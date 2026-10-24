/**
 * 六合彩「7码复式 · 三中三 / 四中四」每日选号工具前端主控制器
 *
 * 一页流结构：① 今日推荐 → ② 自选7码 → ③ 开奖核对 → ④ 历史回放 → ⑤ 更多（折叠）
 * 核心算法（strategy / combinatorics / parser）与底库 data/draws.js 保持不变。
 *
 * 关键约定：
 *  - 只核对前 6 个正码（平一～平六），特码只展示、不计入命中。
 *  - 历史回放严格「无未来函数」：第 T 期推荐只用 T 期之前的数据（由 strategy.buildReplayRecords 保证）。
 *  - 任何异常都要给出明确提示，不能白屏，也不能永远停在「加载中…」。
 */

import {
  ALL_NUMBERS,
  APP_BUILD,
  APP_VERSION_LABEL,
  DEFAULT_CONFIG,
  getColorForNumber,
  getZodiacForNumber,
  pad2,
  padPeriod
} from './constants.js';
import { classifyHitCount, evaluate7CodeCompound, evaluateDirectTickets, normalizeNumbers } from './combinatorics.js';
import { mergeDraws, normalizeDrawRecord, parseDrawsInput } from './parser.js';
import { buildReplayRecords, generatePeriodPlan, summarizeReplay } from './strategy.js';
import { RANDOM_BASELINE_7_CODE, formatPercent } from './statistics.js';
import {
  STORAGE_KEYS,
  loadPersistedState,
  persistMigratedState,
  safeSet
} from './storage.js';
import INITIAL_DB from '../data/draws.js';

const PERIOD_SELECT_LIMIT = 120; // 期数下拉只放近期，避免上千个 option 撑爆 DOM
const REPLAY_PAGE = 40; // 历史回放每页行数
const REPLAY_CHUNK = 40; // 每批计算的期数（分批让出主线程，避免卡死）

const state = {
  config: { ...DEFAULT_CONFIG },
  baseDraws: Array.isArray(INITIAL_DB?.draws) ? INITIAL_DB.draws : [],
  localDraws: [],
  allDraws: [],

  periodKey: 'NEXT', // 'NEXT' 或 draw.id（如 '2026-296'）
  strategyId: 'composite', // 当前主推策略，默认 S1

  customPicks: [],
  pinnedPicks: [],
  simNormals: [],
  comboTab: 'pick3',

  storageErrors: []
};

const replay = {
  token: 0,          // 防止旧计算结果覆盖新结果
  records: [],       // 已计算的逐期回放记录
  filtered: [],      // 经过筛选后的记录（表格与指标卡的数据源）
  running: false,
  visible: REPLAY_PAGE,
  expanded: new Set(),
  filters: {
    year: 'all',
    range: '120',
    from: '',
    to: '',
    strategy: 'composite',
    mode: 'compound7',
    hit: 'all',
    q: ''
  }
};

const planCache = new Map();

/* ==================== 小工具 ==================== */

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  $('toastContainer')?.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function showBootError(msg) {
  if (typeof window.__SHOW_BOOT_ERROR__ === 'function') {
    window.__SHOW_BOOT_ERROR__(msg);
  } else {
    console.error('[boot]', msg);
  }
}

async function copyText(text, label = '已复制到剪贴板') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(`✓ ${label}`);
  } catch {
    showToast('复制失败，请手动选择复制');
  }
}

function money(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('zh-CN')} 元`;
}

/** 金额（不带正负号，用于本金 / 返奖等非盈亏数字） */
function amount(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return `${Math.round(v).toLocaleString('zh-CN')} 元`;
}

const numsText = (nums) => (nums || []).map(pad2).join(' ');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ballHtml(num, opts = {}) {
  const n = Number(num);
  const color = getColorForNumber(n);
  const size = opts.size ? ` ${opts.size}` : '';
  const hit = opts.hitSet?.has(n) ? ' ball-hit' : '';
  const dim = opts.dim ? ' ball-special-dim' : '';
  const zodiac = opts.zodiac === false ? '' : getZodiacForNumber(n, opts.date || '2026-10-24');
  const pin = opts.pinned ? '<span class="pin-badge">胆</span>' : '';
  const attrs = opts.attrs || '';
  return `<div class="lotto-ball-wrap" ${attrs}><div class="lotto-ball ${color}${size}${hit}${dim}">${pad2(n)}${pin}</div>${zodiac ? `<span class="ball-meta">${zodiac}</span>` : ''}</div>`;
}

function miniBallHtml(num, opts = {}) {
  const n = Number(num);
  const cls = ['mini-ball', getColorForNumber(n)];
  if (opts.special) cls.push('special');
  if (opts.hit) cls.push('is-hit');
  if (opts.miss) cls.push('miss');
  return `<span class="${cls.join(' ')}" title="${pad2(n)}${opts.special ? '（特码，不计入命中）' : ''}">${pad2(n)}</span>`;
}

function drawBallsHtml(draw, opts = {}) {
  if (!draw) return '';
  const hitSet = opts.hitSet;
  const normals = draw.numbers.map((n) => ballHtml(n, { ...opts, hitSet, date: draw.date })).join('');
  const special = draw.special != null
    ? `<span class="ball-plus">+</span>${ballHtml(draw.special, { ...opts, hitSet: null, dim: true, date: draw.date })}`
    : '';
  return normals + special;
}

/* ==================== 存储与数据 ==================== */

function loadSavedState() {
  const persisted = loadPersistedState(window.localStorage, {
    defaults: DEFAULT_CONFIG,
    normalizeDrawRecord
  });
  state.config = persisted.config;
  state.localDraws = persisted.localDraws;
  state.customPicks = persisted.customPicks;
  state.pinnedPicks = persisted.pinnedPicks;
  state.storageErrors = persisted.errors || [];
  if (persisted.migrations.length) {
    persistMigratedState(window.localStorage, persisted);
    console.info('[storage] 已迁移旧键：', persisted.migrations.join(', '));
  }
  rebuildMergedDraws();
}

function saveConfig() {
  safeSet(window.localStorage, STORAGE_KEYS.CONFIG, state.config);
}
function saveLocalDraws() {
  safeSet(window.localStorage, STORAGE_KEYS.LOCAL_DRAWS, state.localDraws);
}
function saveCustomPicks() {
  safeSet(window.localStorage, STORAGE_KEYS.CUSTOM_PICKS, { picks: state.customPicks, pinned: state.pinnedPicks });
}

function rebuildMergedDraws() {
  state.allDraws = mergeDraws(state.baseDraws, state.localDraws).merged;
  planCache.clear();
}

function getNextDrawMeta() {
  const latest = state.allDraws[0] || { year: 2026, periodNum: 296, date: '2026-10-23' };
  const periodNum = (latest.periodNum || 0) + 1;
  let date = '2026-10-24';
  if (/^\d{4}-\d{2}-\d{2}$/.test(latest.date || '')) {
    const dt = new Date(`${latest.date}T12:00:00Z`);
    if (!Number.isNaN(dt.getTime())) {
      dt.setUTCDate(dt.getUTCDate() + 1);
      date = dt.toISOString().slice(0, 10);
    }
  }
  return { id: 'NEXT', year: latest.year, periodNum, period: padPeriod(periodNum), date, isUpcoming: true };
}

function getPeriodContext() {
  if (state.periodKey !== 'NEXT') {
    const found = state.allDraws.find((d) => d.id === state.periodKey);
    if (found) {
      return {
        target: { id: found.id, year: found.year, periodNum: found.periodNum, period: found.period, date: found.date, isUpcoming: false },
        draw: found,
        isUpcoming: false
      };
    }
  }
  return { target: getNextDrawMeta(), draw: null, isUpcoming: true };
}

/** 生成/缓存某期的完整方案（内含 5 组策略），主推从 strategies 中按 state.strategyId 取 */
function getPlan(target) {
  const sig = `${target.year}-${target.periodNum}|${state.allDraws.length}:${state.allDraws[0]?.id || ''}`;
  if (!planCache.has(sig)) {
    planCache.set(sig, generatePeriodPlan(state.allDraws, { year: target.year, periodNum: target.periodNum, date: target.date }));
  }
  return planCache.get(sig);
}

function primaryOf(plan) {
  const strat = plan.strategies.find((s) => s.id === state.strategyId) || plan.strategies[0];
  return { strat, seven: strat.numbers, pick3: strat.top5Pick3, pick4: strat.top5Pick4 };
}

const betConfig = () => ({ stake: state.config.stake, odds3: state.config.odds3, odds4: state.config.odds4 });

/* ==================== 文案（复制用） ==================== */

function schemeText(ctx, primary) {
  const t = ctx.target;
  const lines = [
    `${t.year}年第${t.period}期 7码复式（${primary.strat.code} · ${primary.strat.name}）`,
    `7码：${numsText(primary.seven)}`,
    '三中三精选5注：',
    ...primary.pick3.map((t3, i) => `${i + 1}. ${numsText(t3)}`),
    '四中四精选5注：',
    ...primary.pick4.map((t4, i) => `${i + 1}. ${numsText(t4)}`),
    '（仅核对前6个正码，特码不计入）'
  ];
  return lines.join('\n');
}

/* ==================== 渲染：顶栏与期数 ==================== */

function renderHeader() {
  const latest = state.allDraws[0];
  const years = [...new Set(state.allDraws.map((d) => d.year))].sort((a, b) => a - b);
  const badge = $('dbBadge');
  if (badge) {
    badge.textContent = `${state.allDraws.length} 期${years.length ? ` (${years[0]}–${years[years.length - 1]})` : ''}`;
    badge.classList.remove('badge-error');
  }
  if (latest) {
    $('latestLine').textContent = `最新 ${latest.year}年第${latest.period}期 (${latest.date})：${numsText(latest.numbers)} + 特 ${pad2(latest.special)}`;
  }
  $('cfgStake').value = state.config.stake;
  $('cfgOdds3').value = state.config.odds3;
  $('cfgOdds4').value = state.config.odds4;
  const buildTag = $('buildTag');
  if (buildTag) buildTag.textContent = APP_VERSION_LABEL;
  const buildFooter = $('buildTagFooter');
  if (buildFooter) buildFooter.textContent = APP_VERSION_LABEL;
}

function populatePeriodSelect() {
  const select = $('periodSelect');
  const next = getNextDrawMeta();
  const opts = [`<option value="NEXT">下一期 ${next.year}年第${next.period}期 (${next.date})</option>`];
  const recent = state.allDraws.slice(0, PERIOD_SELECT_LIMIT);
  if (state.periodKey !== 'NEXT' && !recent.some((d) => d.id === state.periodKey)) {
    const d = state.allDraws.find((x) => x.id === state.periodKey);
    if (d) opts.push(`<option value="${d.id}">${d.year}年第${d.period}期 (${d.date})</option>`);
  }
  for (const d of recent) {
    opts.push(`<option value="${d.id}">${d.year}年第${d.period}期 (${d.date}) · ${numsText(d.numbers)} + ${pad2(d.special)}</option>`);
  }
  select.innerHTML = opts.join('');
  select.value = state.periodKey;
  if (select.value !== state.periodKey) select.value = 'NEXT';
}

/* ==================== 渲染：① 今日推荐 ==================== */

function ticketListHtml(tickets, evalResult) {
  const details = evalResult?.details || [];
  return tickets.map((nums, i) => {
    const det = details[i];
    const hitSet = det ? new Set(det.hitNums) : null;
    const balls = nums.map((n) => ballHtml(n, { size: 'sm', hitSet, zodiac: false })).join('');
    const status = det?.isWin
      ? '<span class="tag tag-win">✓ 命中</span>'
      : det ? `<span class="tag tag-muted">中 ${det.hitCount} 号</span>` : '';
    return `<div class="ticket-item${det?.isWin ? ' ticket-win' : ''}"><span class="ticket-nums"><span class="ticket-idx">第${i + 1}注</span>${balls}</span>${status}</div>`;
  }).join('');
}

function renderToday() {
  const ctx = getPeriodContext();
  const plan = getPlan(ctx.target);
  const primary = primaryOf(plan);
  const t = ctx.target;
  const cfg = betConfig();

  $('heroPeriod').textContent = ctx.isUpcoming
    ? `${t.year}年第${t.period}期 · 待开奖推荐`
    : `${t.year}年第${t.period}期 · 已开奖复盘`;
  $('heroStrategy').textContent = `${primary.strat.code} · ${primary.strat.name}`;
  $('heroMeta').textContent = `${primary.strat.rationale} · 基于此前 ${plan.priorSampleCount} 期正码`;

  let compound = null;
  let eval3 = null;
  let eval4 = null;
  let heroHitSet = null;

  if (ctx.draw) {
    compound = evaluate7CodeCompound(primary.seven, ctx.draw, cfg);
    eval3 = evaluateDirectTickets(primary.pick3, ctx.draw, { ...cfg, targetSize: 3 });
    eval4 = evaluateDirectTickets(primary.pick4, ctx.draw, { ...cfg, targetSize: 4 });
    heroHitSet = new Set(compound.matchedNormals);
  }

  $('heroBalls').innerHTML = primary.seven.map((n) => ballHtml(n, { size: 'lg', hitSet: heroHitSet, date: t.date })).join('');
  $('pick3List').innerHTML = ticketListHtml(primary.pick3, eval3);
  $('pick4List').innerHTML = ticketListHtml(primary.pick4, eval4);
  $('featuredCostLine').textContent =
    `成本参考：精选每种 5 注 = ${5 * cfg.stake} 元；7码复式全包每种 35 注 = ${35 * cfg.stake} 元（单注 ${cfg.stake} 元，可在「更多」里改）`;

  const box = $('heroResult');
  if (!ctx.draw) {
    box.innerHTML = `<div class="result-strip"><div class="result-label">这一期还没开奖</div><p class="hint-line">开奖后到下方「开奖核对」输一期号码即可核对；也可以在期数下拉里选往期看复盘。</p></div>`;
  } else {
    const k = compound.matchedNormalCount;
    const p3 = compound.pick3;
    const p4 = compound.pick4;
    const winCls = k >= 3 ? ' win' : '';
    const winDetail = [
      p3.winningCombos.length ? `<div>✓ 三中三命中组合（${p3.winningCombos.length} 注）：${p3.winningCombos.map((c) => numsText(c.nums)).join('；')}</div>` : '',
      p4.winningCombos.length ? `<div>✓ 四中四命中组合（${p4.winningCombos.length} 注）：${p4.winningCombos.map((c) => numsText(c.nums)).join('；')}</div>` : ''
    ].filter(Boolean).join('');
    box.innerHTML = `
      <div class="result-strip${winCls}">
        <div class="result-label">本期开奖（正码 + 特码）· 7码命中 ${k} 个正码${compound.specialMatched ? '（另含特码，不计入）' : ''}</div>
        <div class="ball-row">${drawBallsHtml(ctx.draw, { size: 'sm', hitSet: new Set(primary.seven) })}</div>
        <div class="kpi-inline">
          <div class="kpi-chip"><div class="k-label">三中三（复式35注）中 ${p3.winCount} 注</div><div class="k-value ${p3.netProfit >= 0 ? 'positive' : 'negative'}">${money(p3.netProfit)}</div></div>
          <div class="kpi-chip"><div class="k-label">四中四（复式35注）中 ${p4.winCount} 注</div><div class="k-value ${p4.netProfit >= 0 ? 'positive' : 'negative'}">${money(p4.netProfit)}</div></div>
          <div class="kpi-chip"><div class="k-label">精选5注命中</div><div class="k-value gold">三中三 ${eval3.winCount} · 四中四 ${eval4.winCount}</div></div>
        </div>
        ${winDetail ? `<div class="win-detail">${winDetail}</div>` : ''}
      </div>`;
  }

  renderStrategies(plan, ctx.draw);
}

function renderStrategies(plan, draw) {
  $('strategiesBox').innerHTML = plan.strategies.map((s) => {
    const active = s.id === state.strategyId;
    let hitText = '';
    if (draw) {
      const ev = evaluate7CodeCompound(s.numbers, draw, betConfig());
      hitText = ` · 本期中 ${ev.matchedNormalCount} 正码（三中三 ${ev.pick3.winCount} 注 / 四中四 ${ev.pick4.winCount} 注）`;
    }
    return `
      <div class="strategy-row${active ? ' active' : ''}">
        <span class="strategy-code">${s.code}</span>
        <span class="strategy-name">${s.name}${active ? '（当前主推）' : ''}</span>
        <span class="strategy-nums">${numsText(s.numbers)}</span>
        <span class="row-actions">
          <button type="button" class="btn btn-sm${active ? '' : ' btn-primary'}" data-use-strategy="${s.id}" ${active ? 'disabled' : ''}>用作主推</button>
          <button type="button" class="btn btn-sm" data-load-nums="${s.numbers.join(',')}">载入自选</button>
        </span>
        <span class="strategy-why">${s.description} · ${s.rationale}${hitText}</span>
      </div>`;
  }).join('');
}

/* ==================== 渲染：② 自选 ==================== */

function renderPicker() {
  const ctx = getPeriodContext();
  const picks = state.customPicks;
  const pinned = new Set(state.pinnedPicks);

  $('grid49').innerHTML = ALL_NUMBERS.map((n) => {
    const cls = ['matrix-cell', picks.includes(n) ? 'selected' : '', pinned.has(n) ? 'pinned' : ''].join(' ');
    return `<div class="${cls}" data-pick="${n}" role="button" aria-label="号码 ${pad2(n)}">${ballHtml(n, { pinned: pinned.has(n), date: ctx.target.date })}</div>`;
  }).join('');

  $('selCount').textContent = picks.length;
  $('selRow').innerHTML = picks.length
    ? picks.map((n) => ballHtml(n, { pinned: pinned.has(n), date: ctx.target.date, attrs: `data-sel="${n}" title="点击切换胆码"` })).join('')
    : '<span class="hint-line">还没有选号，点上方球号，或用「智能补齐」一键生成。</span>';

  const cfg = betConfig();
  $('customSummary').textContent = picks.length === 7
    ? `自选7码：${numsText(picks)}${pinned.size ? `（胆码：${numsText(state.pinnedPicks)}）` : ''} · 复式成本 三中三 ${35 * cfg.stake} 元 / 四中四 ${35 * cfg.stake} 元`
    : `还差 ${7 - picks.length} 个号选满 7 码${pinned.size ? `，已锁胆码 ${numsText(state.pinnedPicks)}，补齐时不会被换掉` : ''}`;

  renderCombos();
  renderSimResult();
}

function effectiveSimDraw() {
  if (state.simNormals.length === 6) return { numbers: state.simNormals, special: null, label: '按你输入的试算正码' };
  const ctx = getPeriodContext();
  if (ctx.draw) return { numbers: ctx.draw.numbers, special: ctx.draw.special, label: `按${ctx.target.year}年第${ctx.target.period}期实际正码` };
  return null;
}

function renderCombos() {
  const grid = $('comboGrid');
  const picks = state.customPicks;
  document.querySelectorAll('#comboTabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.play === state.comboTab));

  if (picks.length !== 7) {
    grid.innerHTML = '';
    $('comboStats').textContent = '选满 7 码后这里展开全部 35 注';
    return;
  }
  const sim = effectiveSimDraw();
  const ev = evaluate7CodeCompound(picks, sim, betConfig());
  const part = state.comboTab === 'pick4' ? ev.pick4 : ev.pick3;

  grid.innerHTML = part.combos.map((c) => {
    const cls = c.isWin ? ' combo-win' : '';
    return `<div class="combo-chip${cls}">${numsText(c.nums)}${c.isWin ? ' ✓' : ''}</div>`;
  }).join('');
  $('comboStats').textContent = sim
    ? `${sim.label}：命中 ${ev.matchedNormalCount} 正码 · 本页中 ${part.winCount} 注 · 净收益 ${money(part.netProfit)}`
    : `共 ${part.totalBets} 注 · 在上方输入试算正码可高亮中奖组合`;
}

function renderSimResult() {
  const box = $('simResult');
  if (state.simNormals.length !== 6) { box.innerHTML = ''; return; }
  if (state.customPicks.length !== 7) {
    box.innerHTML = '<div class="check-lines"><span class="tag tag-muted">已输入试算正码，先选满 7 码即可看到命中</span></div>';
    return;
  }
  const ev = evaluate7CodeCompound(state.customPicks, { numbers: state.simNormals }, betConfig());
  box.innerHTML = `
    <div class="kpi-inline">
      <div class="kpi-chip"><div class="k-label">自选7码命中正码</div><div class="k-value gold">${ev.matchedNormalCount} 个${ev.matchedNormals.length ? `（${numsText(ev.matchedNormals)}）` : ''}</div></div>
      <div class="kpi-chip"><div class="k-label">三中三 中 ${ev.pick3.winCount} 注</div><div class="k-value ${ev.pick3.netProfit >= 0 ? 'positive' : 'negative'}">${money(ev.pick3.netProfit)}</div></div>
      <div class="kpi-chip"><div class="k-label">四中四 中 ${ev.pick4.winCount} 注</div><div class="k-value ${ev.pick4.netProfit >= 0 ? 'positive' : 'negative'}">${money(ev.pick4.netProfit)}</div></div>
    </div>`;
}

function setCustomPicks(nums, { keepPinned = true } = {}) {
  state.customPicks = normalizeNumbers(nums, { maxCount: 7 });
  state.pinnedPicks = keepPinned ? state.pinnedPicks.filter((n) => state.customPicks.includes(n)) : [];
  saveCustomPicks();
  renderPicker();
  renderCheck();
}

/* ==================== 渲染：③ 开奖核对 ==================== */

/**
 * 解析号码文本，返回号码与明确的错误提示（重复 / 越界 / 数量不足）
 * @param {string} text
 * @param {number} max
 */
function parseNumbersFromText(text, max = 8) {
  const raw = String(text || '').match(/\d+/g) || [];
  const seen = new Set();
  const out = [];
  const errors = [];
  for (const token of raw) {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > 49) {
      errors.push(`「${token}」不是 1–49 的有效号码`);
      continue;
    }
    if (seen.has(n)) {
      errors.push(`号码 ${pad2(n)} 重复出现`);
      continue;
    }
    seen.add(n);
    out.push(n);
    if (out.length >= max) break;
  }
  return { numbers: out, errors };
}

/** 读取录入表单的原始值（不做兜底，便于保存前做严格校验） */
function readEntryFields() {
  const yearRaw = String($('entryYear').value || '').trim();
  const periodRaw = String($('entryPeriod').value || '').trim();
  const dateRaw = String($('entryDate').value || '').trim();
  return {
    yearRaw,
    periodRaw,
    dateRaw,
    year: yearRaw === '' ? NaN : Number(yearRaw),
    periodNum: periodRaw === '' ? NaN : Number(periodRaw)
  };
}

/** 严格校验 YYYY-MM-DD（同时排除 2026-02-30 这类「格式对但日期不存在」的情况） */
function isValidISODate(text) {
  const s = String(text || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(dt.getTime())
    && dt.getUTCFullYear() === y
    && dt.getUTCMonth() + 1 === m
    && dt.getUTCDate() === d;
}

/** 录入表单的展示用目标（非法时回退到下一期，避免出现 0 期 / 1970 年） */
function entryTarget() {
  const f = readEntryFields();
  const next = getNextDrawMeta();
  const year = Number.isInteger(f.year) && f.year > 0 ? f.year : next.year;
  const periodNum = Number.isInteger(f.periodNum) && f.periodNum > 0 ? f.periodNum : next.periodNum;
  const date = isValidISODate(f.dateRaw) ? f.dateRaw : next.date;
  return { year, periodNum, period: padPeriod(periodNum), date };
}

function initEntryDefaults() {
  const next = getNextDrawMeta();
  $('entryYear').value = next.year;
  $('entryPeriod').value = next.periodNum;
  $('entryDate').value = next.date;
}

function renderCheck() {
  const { numbers: nums } = parseNumbersFromText($('entryLine')?.value, 7);
  const t = entryTarget();

  const slots = [];
  for (let i = 0; i < 7; i++) {
    if (i === 6 && nums.length > 0) slots.push('<span class="ball-plus">+</span>');
    if (nums[i] != null) {
      slots.push(ballHtml(nums[i], { date: t.date, dim: i === 6 }));
    } else {
      slots.push(`<div class="lotto-ball-wrap"><div class="ball-empty">${i === 6 ? '特' : `平${'一二三四五六'[i]}`}</div><span class="ball-meta">&nbsp;</span></div>`);
    }
  }
  $('entrySlots').innerHTML = slots.join('');

  const box = $('checkResult');
  if (nums.length < 7) {
    box.innerHTML = `<p class="hint-line">输入 6 个正码 + 1 个特码后自动核对（还差 ${7 - nums.length} 个）。特码只展示，不计入命中。</p>`;
    renderLocalList();
    return;
  }

  const draw = { numbers: nums.slice(0, 6), special: nums[6], date: t.date };
  const plan = getPlan(t);
  const primary = primaryOf(plan);
  const cfg = betConfig();
  const ev = evaluate7CodeCompound(primary.seven, draw, cfg);
  const e3 = evaluateDirectTickets(primary.pick3, draw, { ...cfg, targetSize: 3 });
  const e4 = evaluateDirectTickets(primary.pick4, draw, { ...cfg, targetSize: 4 });

  const lines = [
    `<span class="tag ${ev.matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">主推7码 ${numsText(primary.seven)} · 中 ${ev.matchedNormalCount} 正码 · 三中三 ${ev.pick3.winCount} 注 / 四中四 ${ev.pick4.winCount} 注 · 复式净收益 三 ${money(ev.pick3.netProfit)} / 四 ${money(ev.pick4.netProfit)}</span>`,
    `<span class="tag ${e3.winCount + e4.winCount > 0 ? 'tag-win' : 'tag-muted'}">精选5注 · 三中三中 ${e3.winCount} 注、四中四中 ${e4.winCount} 注</span>`
  ];
  if (state.customPicks.length === 7) {
    const cev = evaluate7CodeCompound(state.customPicks, draw, cfg);
    lines.push(`<span class="tag ${cev.matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">自选7码 ${numsText(state.customPicks)} · 中 ${cev.matchedNormalCount} 正码 · 三中三 ${cev.pick3.winCount} 注 / 四中四 ${cev.pick4.winCount} 注</span>`);
  }
  box.innerHTML = `<div class="check-lines">${lines.join('')}</div>`;
  renderLocalList();
}

function renderLocalList() {
  const wrap = $('localBox');
  const has = state.localDraws.length > 0;
  wrap.hidden = !has;
  if (!has) return;
  $('localCount').textContent = state.localDraws.length;
  $('localList').innerHTML = state.localDraws.slice(0, 10).map((d) => `
    <div class="local-item">
      <span><b>${d.year}年第${d.period}期</b> (${d.date})</span>
      <span>${numsText(d.numbers)} + ${pad2(d.special)}</span>
      <button type="button" class="btn btn-sm" data-del-local="${d.id}">删除</button>
    </div>`).join('');
}

/* ==================== ④ 历史回放（逐期回报表） ==================== */

function strategyLabel(id) {
  const map = {
    composite: 'S1 综合量化主推',
    hot_warm: 'S2 热温动量',
    cold_rebound: 'S3 遗漏回补',
    tail_synergy: 'S4 同尾连码',
    zodiac_wave: 'S5 生肖波色',
    custom: '当前自选 7 码'
  };
  return map[id] || id;
}

function populateYearTabs() {
  const years = [...new Set(state.allDraws.map((d) => d.year))].sort((a, b) => b - a);
  const host = $('histYearTabs');
  const cur = replay.filters.year;
  const options = ['all', ...years];
  if (!options.includes(cur)) replay.filters.year = 'all';
  host.innerHTML = options.map((y) => {
    const label = y === 'all' ? `全部 (${state.allDraws.length})` : `${y} (${state.allDraws.filter((d) => d.year === y).length})`;
    return `<button type="button" class="pill${y === replay.filters.year ? ' active' : ''}" data-year="${y}">${label}</button>`;
  }).join('');
  // 「全部」范围的下拉文案跟随真实期数变化
  const rangeAll = $('histRange')?.querySelector('option[value="all"]');
  if (rangeAll) rangeAll.textContent = `全部（${state.allDraws.length} 期）`;
}

/** 依据「年份 + 范围」筛出需要回放的期次 */
function replayTargets() {
  const f = replay.filters;
  let list = state.allDraws;
  if (f.year !== 'all') list = list.filter((d) => String(d.year) === String(f.year));
  if (f.range === 'custom') {
    const from = f.from ? new Date(`${f.from}T00:00:00Z`).getTime() : -Infinity;
    const to = f.to ? new Date(`${f.to}T23:59:59Z`).getTime() : Infinity;
    list = list.filter((d) => {
      const t = new Date(`${d.date}T12:00:00Z`).getTime();
      return Number.isFinite(t) && t >= from && t <= to;
    });
  } else if (f.range !== 'all') {
    const n = Math.max(1, Number(f.range) || 0);
    list = list.slice(0, n);
  }
  return list;
}

/** 应用「命中筛选 + 搜索」，得到最终展示的记录 */
function applyReplayFilters(records) {
  const f = replay.filters;
  const q = f.q.trim().toLowerCase();
  return records.filter((rec) => {
    const d = rec.draw;
    if (f.hit === 'pick3' && !(rec.compoundEval.pick3.winCount > 0 || rec.direct3Eval.winCount > 0)) return false;
    if (f.hit === 'pick4' && !(rec.compoundEval.pick4.winCount > 0 || rec.direct4Eval.winCount > 0)) return false;
    if (f.hit === 'miss' && (rec.compoundEval.pick3.winCount > 0 || rec.compoundEval.pick4.winCount > 0
      || rec.direct3Eval.winCount > 0 || rec.direct4Eval.winCount > 0)) return false;
    if (!q) return true;
    const hay = `${d.id} ${d.year}年第${d.period}期 ${d.date} ${numsText(d.numbers)} ${pad2(d.special)} ${d.numbers.join(',')}`;
    return hay.toLowerCase().includes(q);
  });
}

/** 分批计算逐期回放，避免一次性算上千期把页面卡死；token 防止旧结果覆盖新结果 */
async function runReplay({ recompute = true } = {}) {
  const f = replay.filters;
  const status = $('replayStatus');

  // 只筛选、不重算：绝不能打断正在进行的计算，也不能把旧结果说成新结果
  if (!recompute) {
    if (replay.running) return; // 有任务在跑，等它跑完再按新筛选展示
    if (replay.records.length) {
      replay.filtered = applyReplayFilters(replay.records);
      status.textContent = `已按当前筛选显示 ${replay.filtered.length} 期（推荐结果来自上一次计算，金额已按当前本金/赔率重算）。`;
      renderReplayTable();
    }
    return;
  }

  // 真正开始新一轮计算时才递增 token：新一轮会让上一轮主动放弃结果
  const token = ++replay.token;

  if (f.strategy === 'custom' && state.customPicks.length !== 7) {
    replay.running = false;
    status.innerHTML = '⚠ 请先在「自选 7 码」里选满 7 个号码，再用自选号码做回放。';
    replay.records = [];
    replay.filtered = [];
    renderReplayTable();
    return;
  }

  const targets = replayTargets();
  if (targets.length === 0) {
    replay.running = false;
    status.textContent = '当前筛选条件下没有可回放的期次。';
    replay.records = [];
    replay.filtered = [];
    renderReplayTable();
    return;
  }

  replay.running = true;
  const started = Date.now();
  status.textContent = `正在逐期回放 ${targets.length} 期（每期只用该期之前的数据）…`;

  const cfg = betConfig();
  const customNumbers = f.strategy === 'custom' ? state.customPicks : null;
  const records = [];
  const chunk = Math.max(1, REPLAY_CHUNK);

  for (let i = 0; i < targets.length; i += chunk) {
    if (token !== replay.token) return; // 已有新的计算任务，放弃本次结果
    const part = buildReplayRecords(state.allDraws, targets.slice(i, i + chunk), {
      strategyId: f.strategy === 'custom' ? 'composite' : f.strategy,
      customNumbers,
      stake: cfg.stake,
      odds3: cfg.odds3,
      odds4: cfg.odds4
    });
    records.push(...part);
    status.textContent = `正在逐期回放… ${records.length}/${targets.length} 期`;
    // 让出主线程，保证筛选、滚动等交互不卡
    await new Promise((r) => setTimeout(r, 0));
  }

  if (token !== replay.token) return;

  replay.records = records;
  replay.filtered = applyReplayFilters(records);
  replay.visible = REPLAY_PAGE;
  replay.running = false;
  const cost = ((Date.now() - started) / 1000).toFixed(1);
  status.textContent = `✓ 已回放 ${records.length} 期（耗时 ${cost}s，无未来函数），当前筛选显示 ${replay.filtered.length} 期。`;
  renderReplayTable();
}

/** 命中分类（k → 三中三 / 四中四 结论与注数） */
function classify(rec) {
  return classifyHitCount(rec.matchedNormalCount);
}

/** 单期收益（按当前投注方式与本金赔率实时计算） */
function periodMoney(rec) {
  const cfg = betConfig();
  const featured = replay.filters.mode === 'featured5';
  const p3 = featured ? rec.direct3Eval : rec.compoundEval.pick3;
  const p4 = featured ? rec.direct4Eval : rec.compoundEval.pick4;
  const cost3 = p3.totalBets * cfg.stake;
  const cost4 = p4.totalBets * cfg.stake;
  const payout3 = p3.winCount * cfg.stake * cfg.odds3;
  const payout4 = p4.winCount * cfg.stake * cfg.odds4;
  return {
    featured,
    p3: { wins: p3.winCount, bets: p3.totalBets, cost: cost3, payout: payout3, net: payout3 - cost3 },
    p4: { wins: p4.winCount, bets: p4.totalBets, cost: cost4, payout: payout4, net: payout4 - cost4 }
  };
}

function resultCellHtml(cls, isHit, betText, combos, net) {
  const badge = isHit
    ? '<span class="badge hit">命中</span>'
    : '<span class="badge miss">未中</span>';
  const comboHtml = combos && combos.length
    ? `<small class="win-combos">${combos.map((c) => numsText(c.nums)).join('；')}</small>`
    : '';
  return `<div class="cell-res">
    ${badge}
    <small>${betText}</small>
    ${comboHtml}
    <small>本期净 ${money(net)}</small>
  </div>`;
}

function replayRowHtml(rec, idx) {
  const d = rec.draw;
  const hitSet = new Set(rec.matchedNormals);
  const cls = classify(rec);
  const m = periodMoney(rec);

  const sevenBalls = rec.sevenNumbers.map((n) => miniBallHtml(n, { hit: hitSet.has(n) })).join('');
  const normalBalls = d.numbers.map((n) => miniBallHtml(n, { hit: hitSet.has(n), miss: !hitSet.has(n) })).join('');
  const specialBall = d.special != null ? miniBallHtml(d.special, { special: true, miss: true }) : '<span class="badge special">—</span>';
  const hitBalls = rec.matchedNormals.length
    ? rec.matchedNormals.map((n) => miniBallHtml(n, { hit: true })).join('')
    : '<span class="badge miss">无</span>';

  const compound = !m.featured;
  const p3BetText = compound
    ? `复式 C(${cls.k},3)=${cls.pick3.betCount} 注`
    : `精选 5 注中 ${m.p3.wins} 注`;
  const p4BetText = compound
    ? `复式 C(${cls.k},4)=${cls.pick4.betCount} 注`
    : `精选 5 注中 ${m.p4.wins} 注`;

  const feat3Wins = rec.direct3Eval.winCount;
  const feat4Wins = rec.direct4Eval.winCount;
  const featHtml = `
    <div class="feat-cell">
      <span class="badge ${feat3Wins ? 'hit' : 'miss'}">三 ${feat3Wins}/5</span>
      <span class="badge ${feat4Wins ? 'hit' : 'miss'}">四 ${feat4Wins}/5</span>
      <br /><button type="button" class="feat-btn" data-feat-toggle="${idx}">展开 5+5 注</button>
    </div>`;

  const rowHit = cls.pick3.isHit || cls.pick4.isHit;

  return `
    <tr class="${rowHit ? 'row-hit' : ''}" data-row-idx="${idx}">
      <td class="col-period">${d.year}-${d.period}<small>${d.date}</small></td>
      <td><div class="cell-balls">${sevenBalls}</div></td>
      <td><div class="cell-balls">${normalBalls}</div></td>
      <td class="col-special"><div class="cell-balls">${specialBall}</div></td>
      <td class="col-hit"><div class="cell-balls">${hitBalls}</div></td>
      <td class="cell-k">${cls.k}</td>
      <td>${resultCellHtml('col-res', cls.pick3.isHit, p3BetText, rec.compoundEval.pick3.winningCombos, m.p3.net)}</td>
      <td>${resultCellHtml('col-res', cls.pick4.isHit, p4BetText, rec.compoundEval.pick4.winningCombos, m.p4.net)}</td>
      <td>${featHtml}</td>
    </tr>`;
}

function featureDetailHtml(rec) {
  const cfg = betConfig();
  const ticketRow = (det, odds, size) => det.map((d) => {
    const balls = d.nums.map((n) => miniBallHtml(n, { hit: d.hitNums.includes(n), miss: !d.hitNums.includes(n) })).join('');
    const badge = d.isWin ? '<span class="badge hit">命中</span>' : `<span class="badge miss">未中</span>`;
    const payout = d.isWin ? ` 返奖 ${amount(d.payout)}` : '';
    return `<tr><td>${d.index}</td><td><div class="feat-ticket">${balls}</div></td><td>${badge} 中 ${d.hitCount} 号</td><td>${payout}</td></tr>`;
  }).join('');

  const f3 = rec.direct3Eval;
  const f4 = rec.direct4Eval;

  return `
    <tr class="feat-detail"><td colspan="9">
      <table>
        <thead><tr><th>注</th><th>三中三精选 5 注（每注 ${amount(cfg.stake)}，命中 ${amount(cfg.stake * cfg.odds3)}）</th><th>结果</th><th>返奖</th></tr></thead>
        <tbody>${ticketRow(f3.details, cfg.odds3, 3)}</tbody>
        <thead><tr><th>注</th><th>四中四精选 5 注（每注 ${amount(cfg.stake)}，命中 ${amount(cfg.stake * cfg.odds4)}）</th><th>结果</th><th>返奖</th></tr></thead>
        <tbody>${ticketRow(f4.details, cfg.odds4, 4)}</tbody>
      </table>
      <p class="hint-line">本期精选合计：三中三中 ${f3.winCount} 注 / 四中四中 ${f4.winCount} 注；7 码复式合计：三中三 ${rec.compoundEval.pick3.winCount} 注 / 四中四 ${rec.compoundEval.pick4.winCount} 注。</p>
    </td></tr>`;
}

function renderReplayTable() {
  const body = $('histBody');
  const list = replay.filtered;
  const visible = list.slice(0, replay.visible);

  if (!list.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="9">${
      replay.running ? '正在计算…' : '当前筛选条件下没有命中的期次，试试放宽筛选或点「重新计算回放」。'
    }</td></tr>`;
  } else {
    body.innerHTML = visible.map(replayRowHtml).join('');
    // 展开的详情行
    for (const idx of replay.expanded) {
      if (idx >= visible.length) continue;
      const tr = body.querySelector(`tr[data-row-idx="${idx}"]`);
      if (!tr) continue;
      tr.insertAdjacentHTML('afterend', featureDetailHtml(list[idx]));
    }
  }

  $('histCount').textContent = list.length
    ? `共 ${list.length} 期，显示 ${visible.length} 期`
    : '没有匹配的期次';
  $('btnMoreHist').style.display = list.length > visible.length ? '' : 'none';

  renderReplayMetrics();
}

function renderReplayMetrics() {
  const cfg = betConfig();
  const summary = summarizeReplay(replay.filtered, {
    stake: cfg.stake,
    odds3: cfg.odds3,
    odds4: cfg.odds4,
    betMode: replay.filters.mode,
    strategyId: replay.filters.strategy
  });

  const totalCost = summary.pick3.totalCost + summary.pick4.totalCost;
  const totalPayout = summary.pick3.totalPayout + summary.pick4.totalPayout;
  const totalNet = totalPayout - totalCost;
  const totalRoi = totalCost > 0 ? ((totalNet / totalCost) * 100).toFixed(2) : '0.00';
  const modeLabel = replay.filters.mode === 'featured5' ? '精选 5 注 / 期' : '7 码复式 35 注 / 期';

  const card = (cls, head, value, sub, extra = '') => `
    <div class="metric-card ${cls}">
      <div class="mc-head"><span>${head}</span>${extra}</div>
      <div class="mc-stat"><span class="mc-val">${value}</span></div>
      ${sub}
    </div>`;

  const bar = (pct) => `<div class="mc-bar"><div class="mc-fill" style="width:${Math.min(100, Math.max(0, pct))}%"></div></div>`;

  $('histMetrics').innerHTML = [
    card('v-other', '回测期数', `${summary.totalPeriods} <span class="mc-label">期</span>`,
      `<div class="mc-grid">
        <div><span class="mc-sm">策略</span><b style="font-size:11px">${strategyLabel(replay.filters.strategy)}</b></div>
        <div><span class="mc-sm">投注</span><b style="font-size:11px">${modeLabel.replace(' / 期', '')}</b></div>
        <div><span class="mc-sm">单注本金</span><b>${cfg.stake} 元</b></div>
      </div>
      <div class="mc-sub">仅使用每期之前的数据生成推荐（无未来函数）。</div>`),
    card('v-num', '三中三命中',
      `${summary.pick3.hitPeriods} <span class="mc-label">期 · ${summary.pick3.hitRate}%</span>`,
      `${bar(summary.pick3.hitRate)}
       <div class="mc-grid">
        <div><span class="mc-sm">中奖注数</span><b>${summary.pick3.totalWinBets}</b></div>
        <div><span class="mc-sm">成本(元)</span><b>${Math.round(summary.pick3.totalCost).toLocaleString()}</b></div>
        <div><span class="mc-sm">返奖(元)</span><b>${Math.round(summary.pick3.totalPayout).toLocaleString()}</b></div>
      </div>
      <div class="mc-sub">净盈亏 <b>${money(summary.pick3.netProfit)}</b> · ROI ${summary.pick3.roi}% · 随机基线 ${formatPercent(RANDOM_BASELINE_7_CODE.pick3)}</div>`),
    card('v-gold', '四中四命中',
      `${summary.pick4.hitPeriods} <span class="mc-label">期 · ${summary.pick4.hitRate}%</span>`,
      `${bar(summary.pick4.hitRate)}
       <div class="mc-grid">
        <div><span class="mc-sm">中奖注数</span><b>${summary.pick4.totalWinBets}</b></div>
        <div><span class="mc-sm">成本(元)</span><b>${Math.round(summary.pick4.totalCost).toLocaleString()}</b></div>
        <div><span class="mc-sm">返奖(元)</span><b>${Math.round(summary.pick4.totalPayout).toLocaleString()}</b></div>
      </div>
      <div class="mc-sub">净盈亏 <b>${money(summary.pick4.netProfit)}</b> · ROI ${summary.pick4.roi}% · 随机基线 ${formatPercent(RANDOM_BASELINE_7_CODE.pick4)}</div>`),
    card('v-green', '总成本 / 总返奖 / 净盈亏',
      `${money(totalNet)}`,
      `<div class="mc-grid">
        <div><span class="mc-sm">总成本(元)</span><b>${Math.round(totalCost).toLocaleString()}</b></div>
        <div><span class="mc-sm">总返奖(元)</span><b>${Math.round(totalPayout).toLocaleString()}</b></div>
        <div><span class="mc-sm">ROI</span><b>${totalRoi}%</b></div>
      </div>
      <div class="mc-sub">三中三与四中四分开统计（上两张卡），此处为两者合计，仅供参考。</div>`)
  ].join('');

  const obs3 = summary.totalPeriods ? summary.pick3.hitRate / 100 : 0;
  const obs4 = summary.totalPeriods ? summary.pick4.hitRate / 100 : 0;
  $('histBaseline').innerHTML = `
    <b>随机基线</b>：49 选 7、开出 6 个正码，超几何分布 P(k≥3)=<b>${formatPercent(RANDOM_BASELINE_7_CODE.pick3)}</b>（三中三）、P(k≥4)=<b>${formatPercent(RANDOM_BASELINE_7_CODE.pick4)}</b>（四中四）。
    当前筛选范围观测：三中三 <b>${formatPercent(obs3)}</b>、四中四 <b>${formatPercent(obs4)}</b>。
    ⚠ 历史回放只是对既有数据的统计回测，彩票结果随机，<b>不能保证未来中奖</b>，也不构成投注建议。`;
}

/* ==================== 数据变更后统一刷新 ==================== */

function refreshAfterDataChange() {
  rebuildMergedDraws();
  renderHeader();
  populatePeriodSelect();
  populateYearTabs();
  initEntryDefaults();
  renderToday();
  renderPicker();
  renderCheck();
  scheduleReplay({ recompute: true });
}

function mergeIncoming(parsed) {
  const before = state.allDraws.length;
  state.localDraws = mergeDraws(state.localDraws, parsed).merged;
  saveLocalDraws();
  refreshAfterDataChange();
  return state.allDraws.length - before;
}

/* ==================== 事件绑定 ==================== */

function bindEvents() {
  /* ① 今日推荐 */
  $('periodSelect').addEventListener('change', (e) => {
    state.periodKey = e.target.value;
    renderToday();
    renderPicker();
  });
  $('btnNext').addEventListener('click', () => {
    state.periodKey = 'NEXT';
    $('periodSelect').value = 'NEXT';
    renderToday();
    renderPicker();
  });
  $('btnCopy7').addEventListener('click', () => {
    const primary = primaryOf(getPlan(getPeriodContext().target));
    copyText(numsText(primary.seven), '7码已复制');
  });
  $('btnCopyAll').addEventListener('click', () => {
    const ctx = getPeriodContext();
    copyText(schemeText(ctx, primaryOf(getPlan(ctx.target))), '本期方案已复制');
  });
  $('btnCopy3').addEventListener('click', () => {
    const primary = primaryOf(getPlan(getPeriodContext().target));
    copyText(primary.pick3.map((t, i) => `${i + 1}. ${numsText(t)}`).join('\n'), '5注三中三已复制');
  });
  $('btnCopy4').addEventListener('click', () => {
    const primary = primaryOf(getPlan(getPeriodContext().target));
    copyText(primary.pick4.map((t, i) => `${i + 1}. ${numsText(t)}`).join('\n'), '5注四中四已复制');
  });
  $('btnLoadMain').addEventListener('click', () => {
    const primary = primaryOf(getPlan(getPeriodContext().target));
    setCustomPicks(primary.seven, { keepPinned: false });
    document.getElementById('picker').scrollIntoView({ behavior: 'smooth' });
    showToast('主推7码已载入自选，可继续微调');
  });
  $('strategiesBox').addEventListener('click', (e) => {
    const useBtn = e.target.closest('[data-use-strategy]');
    if (useBtn && !useBtn.disabled) {
      state.strategyId = useBtn.dataset.useStrategy;
      renderToday();
      showToast('已切换主推策略');
      return;
    }
    const loadBtn = e.target.closest('[data-load-nums]');
    if (loadBtn) {
      setCustomPicks(loadBtn.dataset.loadNums.split(',').map(Number), { keepPinned: false });
      document.getElementById('picker').scrollIntoView({ behavior: 'smooth' });
    }
  });

  /* ② 自选 */
  $('grid49').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-pick]');
    if (!cell) return;
    const n = Number(cell.dataset.pick);
    if (state.customPicks.includes(n)) {
      setCustomPicks(state.customPicks.filter((x) => x !== n));
    } else if (state.customPicks.length >= 7) {
      showToast('已经选满 7 码，先点掉一个再换');
    } else {
      setCustomPicks([...state.customPicks, n]);
    }
  });
  $('selRow').addEventListener('click', (e) => {
    const el = e.target.closest('[data-sel]');
    if (!el) return;
    const n = Number(el.dataset.sel);
    if (state.pinnedPicks.includes(n)) {
      state.pinnedPicks = state.pinnedPicks.filter((x) => x !== n);
    } else if (state.pinnedPicks.length >= 6) {
      showToast('胆码最多 6 个');
      return;
    } else {
      state.pinnedPicks = [...state.pinnedPicks, n].sort((a, b) => a - b);
    }
    saveCustomPicks();
    renderPicker();
  });
  $('btnFill').addEventListener('click', () => {
    const ctx = getPeriodContext();
    const pinned = state.pinnedPicks.length ? state.pinnedPicks : state.customPicks.slice(0, 6);
    const plan = generatePeriodPlan(
      state.allDraws,
      { year: ctx.target.year, periodNum: ctx.target.periodNum, date: ctx.target.date },
      { pinnedNumbers: pinned, strategyId: $('fillStrategy').value }
    );
    state.pinnedPicks = pinned.filter((n) => plan.primary7.includes(n));
    setCustomPicks(plan.primary7);
    showToast(state.pinnedPicks.length ? `已保留胆码 ${numsText(state.pinnedPicks)} 并补齐7码` : '已生成7码');
  });
  $('btnUseMain').addEventListener('click', () => {
    const primary = primaryOf(getPlan(getPeriodContext().target));
    setCustomPicks(primary.seven, { keepPinned: false });
  });
  $('btnCopyCustom').addEventListener('click', () => {
    if (!state.customPicks.length) { showToast('还没有选号'); return; }
    copyText(numsText(state.customPicks), '自选号码已复制');
  });
  $('btnClearPicks').addEventListener('click', () => {
    state.pinnedPicks = [];
    setCustomPicks([], { keepPinned: false });
  });
  $('btnSimUseDraw').addEventListener('click', () => {
    const ctx = getPeriodContext();
    if (!ctx.draw) { showToast('当前选择的是待开奖期，没有当期正码'); return; }
    $('simInput').value = numsText(ctx.draw.numbers);
    state.simNormals = [...ctx.draw.numbers];
    renderPicker();
  });
  $('btnSim').addEventListener('click', () => {
    const { numbers, errors } = parseNumbersFromText($('simInput').value, 6);
    if (errors.length) showToast(errors[0]);
    if (numbers.length !== 6) { showToast('请输入 6 个不重复的正码（01–49）'); return; }
    state.simNormals = numbers;
    renderPicker();
  });
  $('simInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSim').click(); });
  $('comboTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (!btn) return;
    state.comboTab = btn.dataset.play;
    renderCombos();
  });

  /* ③ 开奖核对 */
  ['entryLine', 'entryYear', 'entryPeriod', 'entryDate'].forEach((id) => {
    $(id).addEventListener('input', renderCheck);
  });
  $('btnSaveDraw').addEventListener('click', () => {
    const { numbers, errors } = parseNumbersFromText($('entryLine').value, 7);
    if (errors.length) showToast(`⚠ ${errors[0]}`);
    if (numbers.length !== 7) { showToast('请先输入完整的 6 正码 + 1 特码'); return; }

    const f = readEntryFields();
    if (!f.yearRaw) { showToast('⚠ 请填写年份'); return; }
    if (!Number.isInteger(f.year) || f.year < 2020 || f.year > 2035) { showToast('⚠ 年份应在 2020–2035 之间'); return; }
    if (!f.periodRaw) { showToast('⚠ 请填写期号（1–366）'); return; }
    if (!Number.isInteger(f.periodNum) || f.periodNum < 1 || f.periodNum > 366) { showToast('⚠ 期号应在 1–366 之间'); return; }
    if (!f.dateRaw) { showToast('⚠ 请填写开奖日期（格式 YYYY-MM-DD）'); return; }
    if (!isValidISODate(f.dateRaw)) { showToast('⚠ 日期格式应为 YYYY-MM-DD，且必须是真实存在的日期'); return; }

    let year = f.year;
    if (Number(f.dateRaw.slice(0, 4)) !== year) {
      year = Number(f.dateRaw.slice(0, 4));
      showToast(`⚠ 日期 ${f.dateRaw} 与年份 ${f.year} 不一致，已按日期年份 ${year} 保存`);
    }

    const rec = normalizeDrawRecord({
      year,
      periodNum: f.periodNum,
      date: f.dateRaw,
      numbers: numbers.slice(0, 6),
      special: numbers[6]
    });
    if (!rec) { showToast('号码格式不对，保存失败'); return; }
    const existed = state.allDraws.some((d) => d.id === rec.id);
    mergeIncoming([rec]);
    $('entryLine').value = '';
    renderCheck();
    showToast(existed ? `已更新 ${rec.year}年第${rec.period}期（原记录被覆盖）` : `✓ 已保存 ${rec.year}年第${rec.period}期`);
  });
  $('localList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del-local]');
    if (!btn) return;
    state.localDraws = state.localDraws.filter((d) => d.id !== btn.dataset.delLocal);
    saveLocalDraws();
    refreshAfterDataChange();
    showToast('已删除该期本地记录');
  });
  $('btnClearLocal').addEventListener('click', () => {
    if (!state.localDraws.length) { showToast('本地没有保存的开奖'); return; }
    state.localDraws = [];
    saveLocalDraws();
    refreshAfterDataChange();
    showToast('本地保存的开奖已清空');
  });

  /* ④ 历史回放 */
  $('histYearTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-year]');
    if (!btn) return;
    replay.filters.year = btn.dataset.year;
    populateYearTabs();
    scheduleReplay({ recompute: true });
  });
  $('histRange').addEventListener('change', (e) => {
    replay.filters.range = e.target.value;
    const custom = e.target.value === 'custom';
    $('histFrom').disabled = !custom;
    $('histTo').disabled = !custom;
    scheduleReplay({ recompute: true });
  });
  $('histFrom').addEventListener('change', (e) => {
    replay.filters.from = e.target.value;
    if (replay.filters.range === 'custom') scheduleReplay({ recompute: true });
  });
  $('histTo').addEventListener('change', (e) => {
    replay.filters.to = e.target.value;
    if (replay.filters.range === 'custom') scheduleReplay({ recompute: true });
  });
  $('histStrategy').addEventListener('change', (e) => {
    replay.filters.strategy = e.target.value;
    scheduleReplay({ recompute: true });
  });
  $('histMode').addEventListener('change', (e) => {
    replay.filters.mode = e.target.value;
    // 投注方式只影响金额统计，推荐结果不需要重算
    scheduleReplay({ recompute: false });
  });
  $('histHitTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-hit]');
    if (!btn) return;
    replay.filters.hit = btn.dataset.hit;
    document.querySelectorAll('#histHitTabs .pill').forEach((p) => p.classList.toggle('active', p === btn));
    scheduleReplay({ recompute: false });
  });
  let searchTimer = null;
  $('histSearch').addEventListener('input', (e) => {
    replay.filters.q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => scheduleReplay({ recompute: false }), 220);
  });
  $('btnMoreHist').addEventListener('click', () => {
    replay.visible += REPLAY_PAGE;
    renderReplayTable();
  });
  $('btnReplayRun').addEventListener('click', () => {
    replay.filters.strategy = $('histStrategy').value;
    replay.filters.mode = $('histMode').value;
    runReplay({ recompute: true });
  });
  $('histBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feat-toggle]');
    if (!btn) return;
    const idx = Number(btn.dataset.featToggle);
    if (replay.expanded.has(idx)) replay.expanded.delete(idx);
    else replay.expanded.add(idx);
    renderReplayTable();
  });

  /* ⑤ 设置 */
  const onConfigChange = () => {
    const stake = Number($('cfgStake').value);
    const odds3 = Number($('cfgOdds3').value);
    const odds4 = Number($('cfgOdds4').value);
    if (!Number.isFinite(stake) || stake <= 0) { showToast('⚠ 单注本金必须是大于 0 的数字'); renderHeader(); return; }
    if (!Number.isFinite(odds3) || odds3 <= 0 || !Number.isFinite(odds4) || odds4 <= 0) {
      showToast('⚠ 赔率必须是大于 0 的数字');
      renderHeader();
      return;
    }
    state.config.stake = stake;
    state.config.odds3 = odds3;
    state.config.odds4 = odds4;
    saveConfig();
    renderToday();
    renderPicker();
    renderCheck();
    // 金额按当前本金/赔率实时重算，推荐结果不变
    if (replay.records.length) {
      replay.filtered = applyReplayFilters(replay.records);
      renderReplayTable();
    }
  };
  ['cfgStake', 'cfgOdds3', 'cfgOdds4'].forEach((id) => $(id).addEventListener('change', onConfigChange));
  $('btnResetCfg').addEventListener('click', () => {
    state.config = { ...state.config, stake: DEFAULT_CONFIG.stake, odds3: DEFAULT_CONFIG.odds3, odds4: DEFAULT_CONFIG.odds4 };
    saveConfig();
    renderHeader();
    renderToday();
    renderPicker();
    renderCheck();
    if (replay.records.length) {
      replay.filtered = applyReplayFilters(replay.records);
      renderReplayTable();
    }
    showToast('已恢复默认本金与赔率');
  });

  /* ⑤ 版本与缓存维护 */
  $('btnCheckUpdate').addEventListener('click', async () => {
    const status = $('updateStatus');
    if (!('serviceWorker' in navigator)) { status.textContent = '当前环境不支持 Service Worker（例如 file:// 直接打开）。'; return; }
    status.textContent = '正在检查更新…';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { status.textContent = '尚未注册 Service Worker（可能以 file:// 打开或浏览器限制）。'; return; }
      await reg.update();
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        status.textContent = '发现新版本，正在应用…';
      } else {
        status.textContent = `✓ 已是最新版本（构建 ${APP_BUILD}）。`;
      }
    } catch (err) {
      status.textContent = `检查更新失败：${err.message}`;
    }
  });
  $('btnRepairCache').addEventListener('click', () => repairCache({ message: '已清理旧缓存，正在重新载入…' }));
  $('btnResetServiceWorker').addEventListener('click', () => repairCache({ hard: true, message: '已注销 Service Worker 并清空缓存，正在重新载入…' }));
  // 「重新加载 / 修复缓存」按钮由 index.html 内联看门狗脚本兜底绑定（app.js 挂掉时也能用），
  // 这里只在没有内联兜底时补绑一次，避免重复触发。
  if (!window.__BOOT_REPAIR_BOUND__) {
    $('btnBootReload').addEventListener('click', () => location.reload());
    $('btnBootRepair').addEventListener('click', () => repairCache({ message: '已清理旧缓存，正在重新载入…' }));
  }

  /* ⑤ 数据同步与导入 */
  $('btnSyncRepo').addEventListener('click', async () => {
    const status = $('syncStatus');
    status.textContent = '正在拉取 ./data/draws.json…';
    try {
      const res = await fetch(`./data/draws.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming = Array.isArray(data.draws) ? data.draws : [];
      if (!incoming.length) throw new Error('底库内容为空');
      const { merged, addedCount, updatedCount } = mergeDraws(state.baseDraws, incoming);
      state.baseDraws = merged;
      refreshAfterDataChange();
      status.textContent = `✓ 已刷新：共 ${state.allDraws.length} 期（新增 ${addedCount}、更新 ${updatedCount}）`;
      showToast('底库刷新成功');
    } catch (err) {
      status.textContent = `拉取失败（${err.message}），已继续使用内置 ${state.allDraws.length} 期底库（离线可用）。`;
    }
  });

  $('btnFetchRemote').addEventListener('click', async () => {
    const status = $('syncStatus');
    const targetUrl = DEFAULT_CONFIG.remoteSourceUrl;
    status.textContent = `正在尝试抓取 ${targetUrl} …`;
    const candidates = [
      targetUrl,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
    ];
    let html = '';
    for (const u of candidates) {
      try {
        const res = await fetch(u, { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          if (text?.includes('期(开奖时间:')) { html = text; break; }
        }
      } catch { /* 试下一个 */ }
    }
    if (!html) {
      status.textContent = '⚠ 远程直连被浏览器跨域拦截，请用下方「粘贴导入」，或等待 GitHub Actions 每日自动同步。';
      return;
    }
    const parsed = parseDrawsInput(html);
    if (!parsed.length) {
      status.textContent = '⚠ 远程页面已抓到，但没有解析出有效开奖记录。';
      return;
    }
    const added = mergeIncoming(parsed);
    status.textContent = `✓ 远程解析 ${parsed.length} 期（净增 ${added} 期），现在共 ${state.allDraws.length} 期`;
    showToast('远程同步成功');
  });

  $('btnExport').addEventListener('click', () => {
    const payload = {
      updatedAt: new Date().toISOString(),
      build: APP_BUILD,
      source: DEFAULT_CONFIG.remoteSourceUrl,
      totalCount: state.allDraws.length,
      latestId: state.allDraws[0]?.id || null,
      draws: state.allDraws
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `draws-${state.allDraws[0]?.id || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${state.allDraws.length} 期底库 JSON`);
  });

  $('btnPasteMerge').addEventListener('click', () => {
    const parsed = parseDrawsInput($('pasteBox').value || '');
    const msg = $('pasteMsg');
    if (!parsed.length) {
      msg.textContent = '✕ 没识别出有效记录（需要期号 + 6正码 + 特码，号码必须在 1–49 且不重复）';
      showToast('✕ 粘贴内容没有解析出开奖记录');
      return;
    }
    const added = mergeIncoming(parsed);
    msg.textContent = `✓ 解析 ${parsed.length} 期（净增 ${added} 期），共 ${state.allDraws.length} 期`;
    showToast(`✓ 已导入 ${parsed.length} 期`);
  });
  $('btnPasteDemo').addEventListener('click', () => {
    const next = getNextDrawMeta();
    $('pasteBox').value = `${next.periodNum}期(开奖时间:${next.date})\n08 猪 14 蛇 23 猴 26 蛇 31 鼠 45 狗 12 羊`;
  });
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseDrawsInput(await file.text());
      if (!parsed.length) {
        showToast(`✕ 文件 ${file.name} 未解析出开奖记录（支持 HTML 源码 / 网页文本 / JSON）`);
        $('pasteMsg').textContent = `✕ ${file.name} 未解析出开奖记录`;
        return;
      }
      const added = mergeIncoming(parsed);
      $('pasteMsg').textContent = `✓ 从 ${file.name} 导入 ${parsed.length} 期（净增 ${added} 期）`;
      showToast(`已从 ${file.name} 导入 ${parsed.length} 期`);
    } catch (err) {
      showToast(`✕ 读取文件失败：${err.message}`);
    } finally {
      e.target.value = '';
    }
  });
}

/* ==================== Service Worker / 缓存 ==================== */

let replayTimer = null;
function scheduleReplay({ recompute }) {
  clearTimeout(replayTimer);
  replayTimer = setTimeout(() => {
    runReplay({ recompute }).catch((err) => {
      console.error('[replay]', err);
      $('replayStatus').textContent = `⚠ 回放计算失败：${err.message}`;
    });
  }, 120);
}

/**
 * 修复缓存：清空 Cache Storage + 让 Service Worker 重新安装 + 带随机参数重载
 * 绝不触碰 localStorage（本金赔率 / 自选号码 / 胆码 / 本地录入的开奖都会保留）
 * @param {{hard?: boolean, message?: string}} [opts] hard=true 时额外注销 Service Worker
 */
async function repairCache(opts = {}) {
  const { hard = false, message = '已清理旧缓存，正在重新载入…' } = opts;
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (hard) {
        await Promise.all(regs.map((r) => r.unregister()));
      } else {
        await Promise.all(regs.map((r) => r.update().catch(() => {})));
      }
    }
    showToast(message);
    // 带随机参数重载，绕过文档级 HTTP 缓存
    setTimeout(() => {
      const url = new URL(location.href);
      url.searchParams.set('_r', String(Date.now()));
      location.replace(url.toString());
    }, 400);
  } catch (err) {
    showToast(`修复缓存失败：${err.message}，请直接刷新页面重试`);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.location.protocol.startsWith('http')) return;
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // 首次安装，无需刷新
    const key = `mark6_reloaded_${APP_BUILD}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch { /* ignore */ }
    showToast('已更新到最新版本，正在重新载入…');
    setTimeout(() => location.reload(), 400);
  });

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`./sw.js?v=${APP_BUILD}`, { updateViaCache: 'none' });
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('发现新版本，正在应用…');
          }
        });
      });
      const status = $('updateStatus');
      if (status) status.textContent = `当前构建：${APP_VERSION_LABEL}（Service Worker 已注册，版本 ${APP_BUILD}）`;
    } catch (err) {
      const status = $('updateStatus');
      if (status) status.textContent = `Service Worker 注册失败：${err.message}（不影响在线使用）`;
    }
  });
}

/* ==================== 初始化 ==================== */

function initApp() {
  loadSavedState();
  renderHeader();
  populatePeriodSelect();
  populateYearTabs();
  initEntryDefaults();
  bindEvents();
  renderToday();
  renderPicker();
  renderCheck();
  renderReplayTable();
  registerServiceWorker();

  if (state.storageErrors.length) {
    showToast(`⚠ ${state.storageErrors[0]}`);
  }

  // 首屏回放计算（不阻塞首屏渲染）
  scheduleReplay({ recompute: true });

  window.__APP_BOOTED__ = true;
}

try {
  initApp();
} catch (err) {
  console.error('[boot] 初始化失败', err);
  showBootError(`初始化失败：${err.message}`);
}
