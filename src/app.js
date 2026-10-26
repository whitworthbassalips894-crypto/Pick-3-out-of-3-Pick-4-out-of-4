/**
 * 六合彩「7码复式 · 三中三 / 四中四」每日选号工具前端主控制器
 *
 * 一页流结构：① 今日推荐（每日 5 注） → ② 自选7码 → ③ 开奖核对 → ④ 历史回放 → ⑤ 更多（折叠）
 *
 * 关键约定：
 *  - 「每日 5 注」= 1 注纯随机基线 + 4 注精选（见 src/dailyfive.js），随机注是随机对照。
 *  - 只核对前 6 个正码（平一～平六），特码只展示、不计入命中。
 *  - 历史回放严格「无未来函数」：第 T 期推荐只用 T 期之前的数据。
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
import { evaluate7CodeCompound, normalizeNumbers } from './combinatorics.js';
import { isValidISODate, mergeDraws, normalizeDrawRecord, parseDrawsInput } from './parser.js';
import { compareDrawSets, formatSyncSummary } from './sync.js';
import { formatFiveTickets, formatSingleTicket, formatTickets } from './copy.js';
import {
  buildCustomRecords,
  buildDailyFiveRecords,
  generateDailyFive,
  summarizeDailyFive
} from './dailyfive.js';
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
const REPLAY_CHUNK = 20; // 每批计算的期数（分批让出主线程，避免卡死）

const state = {
  config: { ...DEFAULT_CONFIG },
  baseDraws: Array.isArray(INITIAL_DB?.draws) ? INITIAL_DB.draws : [],
  localDraws: [],
  allDraws: [],

  periodKey: 'NEXT', // 'NEXT' 或 draw.id（如 '2026-296'）
  randomSalt: 0, // 随机注的重摇次数（0 = 默认随机）

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
  expanded: new Set(), // 展开的期号（用 draw.id，重新筛选后不会错位）
  filters: {
    year: 'all',
    range: '120',
    from: '',
    to: '',
    strategy: 'daily5', // 'daily5' 每日 5 注 | 'custom' 当前自选 7 码
    mode: 'compound7',  // 'compound7' 7码复式 | 'featured5' 精选5注
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

/** 所有进入 innerHTML 的外部文本都要过一遍 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ballHtml(num, opts = {}) {
  const n = Number(num);
  const color = getColorForNumber(n);
  const size = opts.size ? ` ${opts.size}` : '';
  const hit = opts.hitSet?.has(n) ? ' ball-hit' : '';
  const dim = opts.dim ? ' ball-special-dim' : '';
  const cons = opts.consensus ? ' ball-consensus' : '';
  const zodiac = opts.zodiac === false ? '' : getZodiacForNumber(n, opts.date || '2026-10-24');
  const pin = opts.pinned ? '<span class="pin-badge">胆</span>' : '';
  const attrs = opts.attrs || '';
  return `<div class="lotto-ball-wrap" ${attrs}><div class="lotto-ball ${color}${size}${hit}${dim}${cons}">${pad2(n)}${pin}</div>${zodiac ? `<span class="ball-meta">${zodiac}</span>` : ''}</div>`;
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
  state.randomSalt = persisted.randomSalt || 0;
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
function saveRandomSalt() {
  safeSet(window.localStorage, STORAGE_KEYS.RANDOM_SALT, state.randomSalt);
}

function rebuildMergedDraws() {
  state.allDraws = mergeDraws(state.baseDraws, state.localDraws).merged;
  planCache.clear();
}

function getNextDrawMeta() {
  const latest = state.allDraws[0] || { year: 2026, periodNum: 296, date: '2026-10-23' };
  let year = latest.year;
  let periodNum = (latest.periodNum || 0) + 1;
  // 跨年：年末最后一期之后归入下一年第 1 期
  if (periodNum > 366) {
    year = year + 1;
    periodNum = 1;
  }
  let date = `${year}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(latest.date || '')) {
    const dt = new Date(`${latest.date}T12:00:00Z`);
    if (!Number.isNaN(dt.getTime())) {
      dt.setUTCDate(dt.getUTCDate() + 1);
      date = dt.toISOString().slice(0, 10);
    }
  }
  return { id: 'NEXT', year, periodNum, period: padPeriod(periodNum), date, isUpcoming: true };
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

/** 生成/缓存某期的「每日 5 注」 */
function getFivePlan(target) {
  const sig = `${target.year}-${target.periodNum}|${state.allDraws.length}:${state.allDraws[0]?.id || ''}|salt:${state.randomSalt}`;
  if (!planCache.has(sig)) {
    planCache.set(sig, generateDailyFive(
      state.allDraws,
      { year: target.year, periodNum: target.periodNum, date: target.date },
      { randomSalt: state.randomSalt }
    ));
  }
  return planCache.get(sig);
}

const betConfig = () => ({ stake: state.config.stake, odds3: state.config.odds3, odds4: state.config.odds4 });

/* ==================== 文案（复制用） ==================== */

/**
 * 复制内容统一规范：**只有号码，每注一行**，不含任何汉字、标题或多余数字。
 * 详细规则与测试见 src/copy.js。
 */
function ticketsText(tickets) {
  return formatTickets(tickets);
}

/** 今日 5 注（每注一行 7 个号码） */
function fiveText(plan) {
  return formatFiveTickets(plan.five);
}

/** 单注 7 码 */
function fiveCardText(e) {
  return formatSingleTicket(e.numbers);
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
    if (d) opts.push(`<option value="${escapeHtml(d.id)}">${d.year}年第${d.period}期 (${escapeHtml(d.date)})</option>`);
  }
  for (const d of recent) {
    opts.push(`<option value="${escapeHtml(d.id)}">${d.year}年第${d.period}期 (${escapeHtml(d.date)}) · ${numsText(d.numbers)} + ${pad2(d.special)}</option>`);
  }
  select.innerHTML = opts.join('');
  select.value = state.periodKey;
  if (select.value !== state.periodKey) select.value = 'NEXT';
}

/* ==================== 渲染：① 今日推荐（每日 5 注） ==================== */

function fiveCardHtml(e, ctx, cfg, consensusSet = new Set()) {
  const t = ctx.target;
  // 该注命中当期正码的号码集合（只取前 6 个正码，特码不参与）
  const drawNormals = ctx.draw ? ctx.draw.numbers.slice(0, 6) : [];
  const cardHitSet = ctx.draw ? new Set(e.numbers.filter((x) => drawNormals.includes(x))) : null;
  const balls = e.numbers.map((n) => ballHtml(n, {
    size: 'sm',
    date: t.date,
    hitSet: cardHitSet,
    consensus: consensusSet.has(n)
  })).join('');
  const shape = e.shape || { odd: 0, even: 0, big: 0, small: 0, zone1: 0, zone2: 0, zone3: 0, red: 0, blue: 0, green: 0, sum: 0 };

  let hitHtml = '';
  if (ctx.draw) {
    const ev = evaluate7CodeCompound(e.numbers, ctx.draw, cfg);
    const p3 = ev.pick3;
    const p4 = ev.pick4;
    const combos3 = p3.winningCombos.map((c) => numsText(c.nums)).join('；');
    const combos4 = p4.winningCombos.map((c) => numsText(c.nums)).join('；');
    hitHtml = `
      <div class="fc-hit">
        <span class="tag ${ev.matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">中 ${ev.matchedNormalCount} 正码${ev.matchedNormals.length ? `（${numsText(ev.matchedNormals)}）` : ''}</span>
        <span class="tag ${p3.winCount ? 'tag-win' : 'tag-muted'}">三中三 ${p3.winCount} 注</span>
        <span class="tag ${p4.winCount ? 'tag-win' : 'tag-muted'}">四中四 ${p4.winCount} 注</span>
        ${combos3 ? `<div class="fc-win">三中三组合：${combos3}</div>` : ''}
        ${combos4 ? `<div class="fc-win">四中四组合：${combos4}</div>` : ''}
      </div>`;
  }

  const ticketRow = (tickets, size) => tickets.map((nums, i) => {
    const ballsHtml = nums.map((n) => miniBallHtml(n, {})).join('');
    return `<div class="ticket-item"><span class="ticket-nums"><span class="ticket-idx">第${i + 1}注</span>${ballsHtml}</span></div>`;
  }).join('');

  return `
    <article class="five-card${e.random ? ' is-random' : ''}" data-five="${escapeHtml(e.id)}">
      <header class="fc-head">
        <span class="fc-icon">${e.icon}</span>
        <span class="fc-code">${escapeHtml(e.code)}</span>
        <span class="fc-name">${escapeHtml(e.name)}</span>
        ${e.random ? '<span class="tag tag-muted">纯随机对照</span>' : '<span class="tag tag-gold">精选</span>'}
      </header>
      <div class="fc-balls">${balls}</div>
      <div class="fc-shape">
        <span>奇偶 ${shape.odd}/${shape.even}</span>
        <span>大小 ${shape.big}/${shape.small}</span>
        <span>三区 ${shape.zone1}-${shape.zone2}-${shape.zone3}</span>
        <span>波色 ${shape.red}/${shape.blue}/${shape.green}</span>
        <span>和值 ${shape.sum}</span>
      </div>
      ${hitHtml}
      <details class="fc-fold">
        <summary>精选 5 注三中三 / 5 注四中四</summary>
        <div class="fc-fold-body">
          <div class="fc-sub-title pick3-color">★ 三中三 5 注
            <button type="button" class="btn btn-sm" data-copy-pick3="${escapeHtml(e.id)}">复制</button>
          </div>
          <div class="ticket-list">${ticketRow(e.featuredPick3, 3)}</div>
          <div class="fc-sub-title pick4-color">★ 四中四 5 注
            <button type="button" class="btn btn-sm" data-copy-pick4="${escapeHtml(e.id)}">复制</button>
          </div>
          <div class="ticket-list">${ticketRow(e.featuredPick4, 4)}</div>
        </div>
      </details>
      <div class="fc-actions">
        <button type="button" class="btn btn-sm" data-copy-five="${escapeHtml(e.id)}">复制本注</button>
        <button type="button" class="btn btn-sm" data-load-five="${escapeHtml(e.id)}">载入自选</button>
      </div>
    </article>`;
}

function renderToday() {
  const ctx = getPeriodContext();
  const plan = getFivePlan(ctx.target);
  const t = ctx.target;
  const cfg = betConfig();

  $('heroPeriod').textContent = ctx.isUpcoming
    ? `${t.year}年第${t.period}期 · 待开奖推荐`
    : `${t.year}年第${t.period}期 · 已开奖复盘`;
  $('heroMeta').textContent = `每日 5 注（1 注随机基线 + 4 注精选）· 基于最近 ${plan.featureWindow} 期正码特征`;
  $('btnResetRandom').disabled = state.randomSalt === 0;

  $('fiveGrid').innerHTML = plan.five.map((e) => fiveCardHtml(e, ctx, cfg, new Set(plan.consensus))).join('');

  // 共识号：4 注精选里被 ≥2 注同时选中的号码
  const consensusHtml = plan.consensus.length
    ? `<span class="consensus-label">共识号（≥2 注精选同选）</span><span class="ball-row">${plan.consensus.map((n) => miniBallHtml(n, { hit: true })).join('')}</span>`
    : '<span class="consensus-label">共识号</span><span class="hint-line">本期 4 注精选没有交集号码</span>';
  $('consensusBox').innerHTML = consensusHtml;

  const box = $('heroResult');
  if (!ctx.draw) {
    box.innerHTML = `<div class="result-strip"><div class="result-label">这一期还没开奖</div><p class="hint-line">开奖后到下方「开奖核对」输一期号码即可核对；也可以在期数下拉里选往期看复盘。</p></div>`;
  } else {
    // 本期 5 注的整体表现（复式口径）
    const perFive = plan.five.map((e) => {
      const ev = evaluate7CodeCompound(e.numbers, ctx.draw, cfg);
      return { e, ev };
    });
    const win3 = perFive.filter((p) => p.ev.pick3.winCount > 0).length;
    const win4 = perFive.filter((p) => p.ev.pick4.winCount > 0).length;
    const net3 = perFive.reduce((a, p) => a + p.ev.pick3.netProfit, 0);
    const net4 = perFive.reduce((a, p) => a + p.ev.pick4.netProfit, 0);
    box.innerHTML = `
      <div class="result-strip${win3 || win4 ? ' win' : ''}">
        <div class="result-label">本期开奖（正码 + 特码）· 5 注中 ${win3} 注有三中三、${win4} 注有四中四</div>
        <div class="ball-row">${drawBallsHtml(ctx.draw, { size: 'sm', hitSet: new Set(plan.five.flatMap((e) => e.numbers)) })}</div>
        <div class="kpi-inline">
          <div class="kpi-chip"><div class="k-label">三中三（5 注复式合计）</div><div class="k-value ${net3 >= 0 ? 'positive' : 'negative'}">${money(net3)}</div></div>
          <div class="kpi-chip"><div class="k-label">四中四（5 注复式合计）</div><div class="k-value ${net4 >= 0 ? 'positive' : 'negative'}">${money(net4)}</div></div>
          <div class="kpi-chip"><div class="k-label">逐注命中球数</div><div class="k-value gold">${perFive.map((p) => `${p.e.code} ${p.ev.matchedNormalCount}`).join(' · ')}</div></div>
        </div>
      </div>`;
  }

  $('featuredCostLine').textContent =
    `成本参考：每注 7 码全包 = 三中三 35 注 + 四中四 35 注 = ${70 * cfg.stake} 元；每注精选 5+5 = ${10 * cfg.stake} 元。5 注合计全包 ${350 * cfg.stake} 元 / 全精选 ${50 * cfg.stake} 元（单注 ${cfg.stake} 元，可在「更多」里改）`;
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

/** 找到某个期号的上一期（按时间倒序的第一条更早记录） */
function findPrevDraw(year, periodNum) {
  return state.allDraws.find((d) => d.year < year || (d.year === year && d.periodNum < periodNum)) || null;
}

/** 依据上一期推算出的应开奖日期（上一期日期 + 1 天） */
function expectedDateFor(year, periodNum) {
  const prev = findPrevDraw(year, periodNum);
  if (!prev || !/^\d{4}-\d{2}-\d{2}$/.test(prev.date || '')) return '';
  const dt = new Date(`${prev.date}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return '';
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * 开奖录入防错提示：建议期号 / 是否已存在 / 日期是否连续
 */
function updateEntryHint() {
  const hint = $('entryHint');
  if (!hint) return;
  const next = getNextDrawMeta();
  const t = entryTarget();
  const existed = state.allDraws.find((d) => d.id === `${t.year}-${padPeriod(t.periodNum)}`);
  const expected = expectedDateFor(t.year, t.periodNum);
  const bits = [];
  bits.push(`建议下一期：<b>${next.year}-${padPeriod(next.periodNum)}</b>（${next.date}）`);
  if (existed) {
    bits.push(`⚠ <b>${existed.id}</b> 已存在（${existed.date}），保存会覆盖本机记录`);
  }
  if (expected && t.date && t.date !== expected) {
    bits.push(`⚠ 日期 ${t.date} 与上一期推算的 ${expected} 不一致，请确认`);
  } else if (expected && t.date) {
    bits.push(`日期与上一期连续 ✓`);
  }
  hint.innerHTML = bits.join(' · ');
}

function renderCheck() {
  const { numbers: nums } = parseNumbersFromText($('entryLine')?.value, 7);
  const t = entryTarget();
  updateEntryHint();

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
  const plan = getFivePlan(t);
  const cfg = betConfig();

  const lines = plan.five.map((e) => {
    const ev = evaluate7CodeCompound(e.numbers, draw, cfg);
    return `<span class="tag ${ev.matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">${e.code} ${e.name} ${numsText(e.numbers)} · 中 ${ev.matchedNormalCount} 正码 · 三中三 ${ev.pick3.winCount} 注 / 四中四 ${ev.pick4.winCount} 注</span>`;
  });
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
      <span><b>${d.year}年第${d.period}期</b> (${escapeHtml(d.date)})</span>
      <span>${numsText(d.numbers)} + ${pad2(d.special)}</span>
      <button type="button" class="btn btn-sm" data-del-local="${escapeHtml(d.id)}">删除</button>
    </div>`).join('');
}

/* ==================== 渲染：④ 历史回放 ==================== */

function populateYearTabs() {
  const years = [...new Set(state.allDraws.map((d) => d.year))].sort((a, b) => b - a);
  const host = $('histYearTabs');
  const cur = replay.filters.year;
  const options = ['all', ...years];
  // 注意：年份可能是数字也可能来自 DOM 的字符串，必须按字符串比较，
  // 否则会把刚选中的年份误判成「非法值」并重置成 all（导致年份筛选失效）
  if (!options.map((y) => String(y)).includes(String(cur))) replay.filters.year = 'all';
  host.innerHTML = options.map((y) => {
    const label = y === 'all' ? `全部 (${state.allDraws.length})` : `${y} (${state.allDraws.filter((d) => d.year === y).length})`;
    const active = String(y) === String(replay.filters.year);
    return `<button type="button" class="pill${active ? ' active' : ''}" data-year="${y}">${label}</button>`;
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
    const any3 = rec.five.some((e) => e.compoundEval.pick3.winCount > 0 || e.direct3Eval.winCount > 0);
    const any4 = rec.five.some((e) => e.compoundEval.pick4.winCount > 0 || e.direct4Eval.winCount > 0);
    if (f.hit === 'pick3' && !any3) return false;
    if (f.hit === 'pick4' && !any4) return false;
    if (f.hit === 'miss' && (any3 || any4)) return false;
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
  const records = [];
  const chunk = Math.max(1, REPLAY_CHUNK);

  for (let i = 0; i < targets.length; i += chunk) {
    if (token !== replay.token) return; // 已有新的计算任务，放弃本次结果
    const part = f.strategy === 'custom'
      ? buildCustomRecords(state.allDraws, targets.slice(i, i + chunk), { ...cfg, customNumbers: state.customPicks })
      : buildDailyFiveRecords(state.allDraws, targets.slice(i, i + chunk), { ...cfg, randomSalt: state.randomSalt });
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

/** 单期收益（按当前投注方式与本金赔率实时计算，跨全部注汇总） */
function periodMoney(rec) {
  const cfg = betConfig();
  const featured = replay.filters.mode === 'featured5';
  let wins3 = 0, wins4 = 0, cost3 = 0, cost4 = 0, payout3 = 0, payout4 = 0;
  for (const e of rec.five) {
    const p3 = featured ? e.direct3Eval : e.compoundEval.pick3;
    const p4 = featured ? e.direct4Eval : e.compoundEval.pick4;
    wins3 += p3.winCount;
    wins4 += p4.winCount;
    cost3 += p3.totalBets * cfg.stake;
    cost4 += p4.totalBets * cfg.stake;
    payout3 += p3.winCount * cfg.stake * cfg.odds3;
    payout4 += p4.winCount * cfg.stake * cfg.odds4;
  }
  return {
    featured,
    p3: { wins: wins3, cost: cost3, payout: payout3, net: payout3 - cost3 },
    p4: { wins: wins4, cost: cost4, payout: payout4, net: payout4 - cost4 }
  };
}

function resultCellHtml(isHit, betText, combosText, net) {
  const badge = isHit
    ? '<span class="badge hit">命中</span>'
    : '<span class="badge miss">未中</span>';
  const comboHtml = combosText
    ? `<small class="win-combos">${combosText}</small>`
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
  const cfg = betConfig();
  const featured = replay.filters.mode === 'featured5';

  // 当期 6 正码：命中任意一注的号码描边
  const anyHit = new Set(rec.five.flatMap((e) => e.matchedNormals));
  const normalBalls = d.numbers.map((n) => miniBallHtml(n, { hit: anyHit.has(n), miss: !anyHit.has(n) })).join('');
  const specialBall = d.special != null ? miniBallHtml(d.special, { special: true, miss: true }) : '<span class="badge special">—</span>';

  // 5 注逐注命中
  const perFive = rec.five.map((e) => {
    const k = e.matchedNormalCount;
    const cls = k >= 3 ? 'hit' : k >= 1 ? 'warm' : 'miss';
    return `<span class="badge ${cls}" title="${escapeHtml(e.name)} 命中 ${k} 个正码">${escapeHtml(e.code)} ${k}</span>`;
  }).join(' ');

  const m = periodMoney(rec);
  const p3Hit = m.p3.wins > 0;
  const p4Hit = m.p4.wins > 0;
  const p3BetText = featured ? `精选 5 注中 ${m.p3.wins} 注` : `${rec.five.length} 注复式共 ${m.p3.wins} 注`;
  const p4BetText = featured ? `精选 5 注中 ${m.p4.wins} 注` : `${rec.five.length} 注复式共 ${m.p4.wins} 注`;

  // 中奖组合：按投注方式取对应口径
  const combos3 = rec.five.flatMap((e) => (featured ? e.direct3Eval.winningTickets : e.compoundEval.pick3.winningCombos)
    .map((c) => ({ nums: c.nums, from: e.code })));
  const combos4 = rec.five.flatMap((e) => (featured ? e.direct4Eval.winningTickets : e.compoundEval.pick4.winningCombos)
    .map((c) => ({ nums: c.nums, from: e.code })));
  const fmtCombos = (list) => list.slice(0, 3).map((c) => `${numsText(c.nums)}（${c.from}）`).join('；');

  const rowHit = p3Hit || p4Hit;

  return `
    <tr class="${rowHit ? 'row-hit' : ''}" data-row-idx="${idx}" data-draw-id="${escapeHtml(d.id)}">
      <td class="col-period">${d.year}-${d.period}<small>${escapeHtml(d.date)}</small></td>
      <td><div class="cell-balls">${normalBalls}</div></td>
      <td class="col-special"><div class="cell-balls">${specialBall}</div></td>
      <td class="col-hit"><div class="cell-five-hits">${perFive}</div></td>
      <td>${resultCellHtml(p3Hit, p3BetText, fmtCombos(combos3), m.p3.net)}</td>
      <td>${resultCellHtml(p4Hit, p4BetText, fmtCombos(combos4), m.p4.net)}</td>
      <td class="col-feat"><button type="button" class="feat-btn" data-feat-toggle="${idx}">展开</button></td>
    </tr>`;
}

function featureDetailHtml(rec) {
  const cfg = betConfig();
  const block = (e) => {
    const f3 = e.direct3Eval;
    const f4 = e.direct4Eval;
    const hitSet = new Set(e.matchedNormals);
    const balls = e.numbers.map((n) => miniBallHtml(n, { hit: hitSet.has(n), miss: !hitSet.has(n) })).join('');
    const ticketRow = (det) => det.map((x) => {
      const b = x.nums.map((n) => miniBallHtml(n, { hit: x.hitNums.includes(n), miss: !x.hitNums.includes(n) })).join('');
      const badge = x.isWin ? '<span class="badge hit">命中</span>' : '<span class="badge miss">未中</span>';
      const payout = x.isWin ? ` 返奖 ${amount(x.payout)}` : '';
      return `<tr><td>${x.index}</td><td><div class="feat-ticket">${b}</div></td><td>${badge} 中 ${x.hitCount} 号</td><td>${payout}</td></tr>`;
    }).join('');
    return `
      <div class="fd-five">
        <div class="fd-head">${e.icon} ${escapeHtml(e.code)} ${escapeHtml(e.name)} <span class="fd-nums">${balls}</span></div>
        <div class="fd-line">命中正码 ${e.matchedNormalCount} 个${e.matchedNormals.length ? `（${numsText(e.matchedNormals)}）` : ''} · 复式：三中三 ${e.compoundEval.pick3.winCount} 注 / 四中四 ${e.compoundEval.pick4.winCount} 注 · 精选：三中三 ${f3.winCount} 注 / 四中四 ${f4.winCount} 注</div>
        <table class="fd-table">
          <thead><tr><th>注</th><th>三中三精选 5 注（每注 ${amount(cfg.stake)}，命中 ${amount(cfg.stake * cfg.odds3)}）</th><th>结果</th><th>返奖</th></tr></thead>
          <tbody>${ticketRow(f3.details)}</tbody>
          <thead><tr><th>注</th><th>四中四精选 5 注（每注 ${amount(cfg.stake)}，命中 ${amount(cfg.stake * cfg.odds4)}）</th><th>结果</th><th>返奖</th></tr></thead>
          <tbody>${ticketRow(f4.details)}</tbody>
        </table>
      </div>`;
  };
  return `
    <tr class="feat-detail"><td colspan="7">
      ${rec.five.map(block).join('')}
    </td></tr>`;
}

function renderReplayTable() {
  const body = $('histBody');
  const list = replay.filtered;
  const visible = list.slice(0, replay.visible);

  if (!list.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">${
      replay.running ? '正在计算…' : '当前筛选条件下没有命中的期次，试试放宽筛选或点「重新计算回放」。'
    }</td></tr>`;
  } else {
    body.innerHTML = visible.map(replayRowHtml).join('');
    // 展开的详情行（按期号匹配，重新筛选后不会错位）
    for (const drawId of replay.expanded) {
      const idx = list.findIndex((r) => r.draw.id === drawId);
      if (idx < 0 || idx >= visible.length) continue;
      const tr = body.querySelector(`tr[data-draw-id="${CSS.escape(drawId)}"]`);
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
  const summary = summarizeDailyFive(replay.filtered, {
    stake: cfg.stake,
    odds3: cfg.odds3,
    odds4: cfg.odds4,
    betMode: replay.filters.mode
  });

  const modeLabel = replay.filters.mode === 'featured5' ? '精选 5 注 / 期' : '7 码复式 35 注 / 期';
  const planLabel = replay.filters.strategy === 'custom' ? '当前自选 7 码' : '每日 5 注';

  const card = (cls, head, value, sub) => `
    <div class="metric-card ${cls}">
      <div class="mc-head"><span>${head}</span></div>
      <div class="mc-stat"><span class="mc-val">${value}</span></div>
      ${sub}
    </div>`;

  // 5 注逐注对比表
  const rows = summary.catalog
    .filter((c) => c.periods > 0)
    .map((c) => `
      <tr class="${c.random ? 'is-random' : ''}">
        <td>${c.icon} ${escapeHtml(c.code)} ${escapeHtml(c.name)}</td>
        <td>${c.avgHits}</td>
        <td>${c.hit3Periods} 期 · ${c.hit3Rate}%</td>
        <td>${c.hit4Periods} 期 · ${c.hit4Rate}%</td>
        <td>${Math.round(c.payout).toLocaleString()}</td>
        <td>${c.roi}%</td>
      </tr>`).join('');

  const compareCard = `
    <div class="metric-card v-num mc-wide">
      <div class="mc-head"><span>5 注逐注对比</span><span class="mc-label">随机期望 ${summary.expectedHits} 码/期</span></div>
      <div class="table-scroll">
        <table class="mc-table">
          <thead>
            <tr><th>注</th><th>场均命中</th><th>三中三命中</th><th>四中四命中</th><th>累计返奖(元)</th><th>ROI</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6">暂无数据</td></tr>'}</tbody>
        </table>
      </div>
      <div class="mc-sub">随机理论期望 7×6/49 = ${summary.expectedHits} 码/期；各注命中率都在随机波动范围内，<b>不代表任何策略有优势</b>。</div>
    </div>`;

  $('histMetrics').innerHTML = [
    card('v-other', '回测期数', `${summary.periods} <span class="mc-label">期</span>`,
      `<div class="mc-grid">
        <div><span class="mc-sm">方案</span><b style="font-size:11px">${planLabel}</b></div>
        <div><span class="mc-sm">投注</span><b style="font-size:11px">${modeLabel.replace(' / 期', '')}</b></div>
        <div><span class="mc-sm">单注本金</span><b>${cfg.stake} 元</b></div>
      </div>
      <div class="mc-sub">仅使用每期之前的数据生成推荐（无未来函数）。</div>`),
    card('v-green', '总成本 / 总返奖 / 净盈亏',
      `${money(summary.totalNet)}`,
      `<div class="mc-grid">
        <div><span class="mc-sm">总成本(元)</span><b>${Math.round(summary.totalCost).toLocaleString()}</b></div>
        <div><span class="mc-sm">总返奖(元)</span><b>${Math.round(summary.totalPayout).toLocaleString()}</b></div>
        <div><span class="mc-sm">ROI</span><b>${summary.totalRoi}%</b></div>
      </div>
      <div class="mc-sub">5 注合计（含随机对照注），仅供参考。</div>`),
    compareCard
  ].join('');

  const catalog3 = summary.catalog.filter((c) => c.periods > 0);
  const obs3 = catalog3.length ? catalog3.reduce((a, c) => a + c.hit3Rate, 0) / catalog3.length : 0;
  const obs4 = catalog3.length ? catalog3.reduce((a, c) => a + c.hit4Rate, 0) / catalog3.length : 0;
  $('histBaseline').innerHTML = `
    <b>随机基线</b>：49 选 7、开出 6 个正码，超几何分布 P(k≥3)=<b>${formatPercent(RANDOM_BASELINE_7_CODE.pick3)}</b>（三中三）、P(k≥4)=<b>${formatPercent(RANDOM_BASELINE_7_CODE.pick4)}</b>（四中四）；
    场均命中期望 <b>${summary.expectedHits}</b> 码/期。
    当前筛选范围各注平均观测：三中三 <b>${obs3.toFixed(2)}%</b>、四中四 <b>${obs4.toFixed(2)}%</b>。
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
  renderSyncPanel();
  scheduleReplay({ recompute: true });
}

/**
 * 上一期 / 下一期快捷切换
 * @param {number} dir +1 = 更早一期，-1 = 更新一期（0 表示当前显示的下一期）
 */
function stepPeriod(dir) {
  const all = state.allDraws;
  if (!all.length) { showToast('没有可切换的期次'); return; }
  // all 是「最新 → 最早」排列
  const idx = all.findIndex((d) => d.id === state.periodKey);
  if (idx === -1) {
    // 当前是 NEXT（未开奖的下一期）
    const target = dir > 0 ? all[0] : null;
    if (!target) { showToast('已经是最新一期'); return; }
    state.periodKey = target.id;
  } else {
    const nextIdx = idx + dir;
    if (nextIdx < 0) { state.periodKey = 'NEXT'; }
    else if (nextIdx >= all.length) { showToast('已经是最新一期'); return; }
    else { state.periodKey = all[nextIdx].id; }
  }
  const sel = $('periodSelect');
  if (sel) sel.value = state.periodKey;
  renderToday();
  renderPicker();
  const label = state.periodKey === 'NEXT' ? '下一期' : state.periodKey;
  showToast(`已切换到 ${label}`);
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
  $('btnCopyAll').addEventListener('click', () => {
    const ctx = getPeriodContext();
    copyText(fiveText(getFivePlan(ctx.target)), '今日 5 注已复制');
  });
  $('btnCopyAllMobile').addEventListener('click', () => {
    const ctx = getPeriodContext();
    copyText(fiveText(getFivePlan(ctx.target)), '今日 5 注已复制');
  });
  $('btnPrevPeriod').addEventListener('click', () => stepPeriod(1));
  $('btnNextPeriod').addEventListener('click', () => stepPeriod(-1));
  $('btnRerollRandom').addEventListener('click', () => {
    state.randomSalt += 1;
    saveRandomSalt();
    renderToday();
    showToast(`随机注已重摇（第 ${state.randomSalt} 次）`);
  });
  $('btnResetRandom').addEventListener('click', () => {
    if (state.randomSalt === 0) { showToast('已经是默认随机'); return; }
    state.randomSalt = 0;
    saveRandomSalt();
    renderToday();
    showToast('已恢复默认随机');
  });
  $('fiveGrid').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy-five]');
    if (copyBtn) {
      const plan = getFivePlan(getPeriodContext().target);
      const entry = plan.five.find((x) => x.id === copyBtn.dataset.copyFive);
      if (entry) copyText(fiveCardText(entry), `${entry.code} ${entry.name} 已复制`);
      return;
    }
    const copy3 = e.target.closest('[data-copy-pick3]');
    if (copy3) {
      const plan = getFivePlan(getPeriodContext().target);
      const entry = plan.five.find((x) => x.id === copy3.dataset.copyPick3);
      if (entry) copyText(ticketsText(entry.featuredPick3), '三中三 5 注已复制');
      return;
    }
    const copy4 = e.target.closest('[data-copy-pick4]');
    if (copy4) {
      const plan = getFivePlan(getPeriodContext().target);
      const entry = plan.five.find((x) => x.id === copy4.dataset.copyPick4);
      if (entry) copyText(ticketsText(entry.featuredPick4), '四中四 5 注已复制');
      return;
    }
    const loadBtn = e.target.closest('[data-load-five]');
    if (loadBtn) {
      const plan = getFivePlan(getPeriodContext().target);
      const entry = plan.five.find((x) => x.id === loadBtn.dataset.loadFive);
      if (!entry) return;
      setCustomPicks(entry.numbers, { keepPinned: false });
      $('picker').scrollIntoView({ behavior: 'smooth' });
      showToast(`${entry.code} ${entry.name} 的 7 码已载入自选，可继续微调`);
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
    const plan = getFivePlan(ctx.target);
    const sourceId = $('fillStrategy').value;
    const entry = plan.five.find((x) => x.id === sourceId) || plan.five[1];
    if (!entry) { showToast('没有可用的方案'); return; }
    const pinned = state.pinnedPicks.length ? state.pinnedPicks : [];
    // 胆码优先，其余用该注的号码补齐到 7 个
    const merged = [...new Set([...pinned, ...entry.numbers])].slice(0, 7);
    state.pinnedPicks = pinned.filter((n) => merged.includes(n));
    setCustomPicks(merged, { keepPinned: true });
    showToast(state.pinnedPicks.length ? `已保留胆码 ${numsText(state.pinnedPicks)} 并补齐7码` : `已按 ${entry.code} ${entry.name} 补齐7码`);
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
  $('btnUseNextPeriod').addEventListener('click', () => {
    const next = getNextDrawMeta();
    $('entryYear').value = next.year;
    $('entryPeriod').value = next.periodNum;
    $('entryDate').value = expectedDateFor(next.year, next.periodNum) || next.date;
    renderCheck();
    showToast(`已填入建议期号 ${next.year}-${padPeriod(next.periodNum)}`);
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
    showToast('已删除该期本地开奖');
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
    const tr = btn.closest('tr[data-draw-id]');
    const id = tr?.dataset.drawId;
    if (!id) return;
    if (replay.expanded.has(id)) {
      replay.expanded.delete(id);
    } else {
      replay.expanded.add(id);
    }
    renderReplayTable();
  });

  /* ⑤ 设置与数据 */
  ['cfgStake', 'cfgOdds3', 'cfgOdds4'].forEach((id) => {
    $(id).addEventListener('input', () => {
      const stake = Number($('cfgStake').value);
      const odds3 = Number($('cfgOdds3').value);
      const odds4 = Number($('cfgOdds4').value);
      if (!Number.isFinite(stake) || stake <= 0) { showToast('⚠ 单注本金必须是大于 0 的数字'); renderHeader(); return; }
      if (!Number.isFinite(odds3) || odds3 <= 0 || !Number.isFinite(odds4) || odds4 <= 0) { showToast('⚠ 赔率必须是大于 0 的数字'); return; }
      state.config = { ...state.config, stake, odds3, odds4 };
      saveConfig();
      renderHeader();
      renderToday();
      renderPicker();
      renderCheck();
      if (replay.records.length) {
        replay.filtered = applyReplayFilters(replay.records);
        renderReplayTable();
      }
    });
  });
  $('btnResetCfg').addEventListener('click', () => {
    state.config = { ...DEFAULT_CONFIG };
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
  $('btnCheckUpdate').addEventListener('click', async () => {
    const status = $('updateStatus');
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

  /* ⑤ 数据同步 */
  $('btnSyncCheck').addEventListener('click', () => runSync({ write: false }));
  $('btnSyncNow').addEventListener('click', () => runSync({ write: true }));
  $('btnSyncFix').addEventListener('click', () => runSync({ write: false, fix: true }));
  $('btnSyncReload').addEventListener('click', () => runSync({ write: false }));

  $('btnExportDb').addEventListener('click', () => {
    const payload = {
      updatedAt: new Date().toISOString(),
      build: APP_BUILD,
      source: DEFAULT_CONFIG.remoteSourceUrl,
      totalCount: state.allDraws.length,
      latestId: state.allDraws[0]?.id || null,
      draws: state.allDraws
    };
    downloadJson(payload, `draws-${state.allDraws[0]?.id || 'export'}.json`);
    showToast(`已导出 ${state.allDraws.length} 期底库 JSON`);
  });

  $('btnPastePreview').addEventListener('click', () => {
    const msg = $('pasteMsg');
    const parsed = parseDrawsInput($('pasteBox').value || '');
    if (!parsed.length) {
      msg.textContent = '✕ 没识别出有效记录（需要期号 + 6正码 + 特码，号码必须在 1–49 且不重复）';
      showToast('✕ 粘贴内容没有解析出开奖记录');
      return;
    }
    const r = compareDrawSets(state.allDraws, parsed);
    const head = parsed[0];
    const tail = parsed[parsed.length - 1];
    msg.textContent = `✓ 解析 ${parsed.length} 期（${head.id} ~ ${tail.id}）：${formatSyncSummary(r)}`;
    showToast(`解析到 ${parsed.length} 期`);
  });

  $('btnPasteMerge').addEventListener('click', () => {
    const msg = $('pasteMsg');
    const parsed = parseDrawsInput($('pasteBox').value || '');
    if (!parsed.length) {
      msg.textContent = '✕ 没识别出有效记录（需要期号 + 6正码 + 特码，号码必须在 1–49 且不重复）';
      showToast('✕ 粘贴内容没有解析出开奖记录');
      return;
    }
    const r = compareDrawSets(state.allDraws, parsed);
    if (!r.appendable.length) {
      msg.textContent = `没有可追加的期次${r.gapCount ? `（期号缺口：${r.gaps.map((g) => g.expected).join('、')}，已停止追加）` : ''}`;
      showToast('没有可追加的期次');
      return;
    }
    state.localDraws = mergeDraws(state.localDraws, r.appendable).merged;
    saveLocalDraws();
    refreshAfterDataChange();
    msg.textContent = `✓ 已追加 ${r.appendable.length} 期（${r.appendable[0].id} ~ ${r.appendable[r.appendable.length - 1].id}），现在共 ${state.allDraws.length} 期`;
    showToast(`已追加 ${r.appendable.length} 期`);
  });

  $('btnPasteDemo').addEventListener('click', () => {
    const next = getNextDrawMeta();
    $('pasteBox').value = `${next.periodNum}期(开奖时间:${next.date})\n08 猪 14 蛇 23 猴 26 蛇 31 鼠 45 狗 12 羊`;
  });

  $('btnPasteClear').addEventListener('click', () => {
    $('pasteBox').value = '';
    $('pasteMsg').textContent = '';
  });

  $('btnFetchRemote').addEventListener('click', async () => {
    const msg = $('pasteMsg');
    msg.textContent = `正在尝试抓取 ${DEFAULT_CONFIG.remoteSourceUrl} …`;
    const html = await fetchRemoteSourceHtml();
    if (!html) {
      msg.textContent = '⚠ 远程直连被浏览器跨域拦截，请用「粘贴导入兜底」，或点「重新读取数据源」读取仓库 JSON。';
      return;
    }
    const parsed = parseDrawsInput(html);
    if (!parsed.length) {
      msg.textContent = '⚠ 远程页面已抓到，但没有解析出有效开奖记录。';
      return;
    }
    const r = compareDrawSets(state.allDraws, parsed);
    if (!r.appendable.length) {
      msg.textContent = `远程解析 ${parsed.length} 期，但没有可追加的期次`;
      return;
    }
    state.localDraws = mergeDraws(state.localDraws, r.appendable).merged;
    saveLocalDraws();
    refreshAfterDataChange();
    msg.textContent = `✓ 远程解析 ${parsed.length} 期，已追加 ${r.appendable.length} 期，现在共 ${state.allDraws.length} 期`;
    showToast('远程同步成功');
  });

  /* 本机手动开奖：导出 / 导入 / 清空 */
  $('btnExportLocal').addEventListener('click', () => {
    if (!state.localDraws.length) { showToast('本机没有手动录入的开奖'); return; }
    downloadJson({
      updatedAt: new Date().toISOString(),
      build: APP_BUILD,
      totalCount: state.localDraws.length,
      draws: state.localDraws
    }, `local-draws-${state.localDraws[0]?.id || 'export'}.json`);
    showToast(`已导出 ${state.localDraws.length} 期本机开奖`);
  });

  $('fileInputLocal').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      let incoming = null;
      try {
        const parsed = JSON.parse(text);
        incoming = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.draws) ? parsed.draws : null);
      } catch { /* 不是 JSON，交给通用解析 */ }
      const records = incoming
        ? incoming.map(normalizeDrawRecord).filter(Boolean)
        : parseDrawsInput(text);
      if (!records.length) {
        showToast(`✕ ${file.name} 未解析出开奖记录`);
        $('pasteMsg').textContent = `✕ ${file.name} 未解析出开奖记录`;
        return;
      }
      state.localDraws = mergeDraws(state.localDraws, records).merged;
      saveLocalDraws();
      refreshAfterDataChange();
      $('pasteMsg').textContent = `✓ 从 ${file.name} 导入 ${records.length} 期，现在本机共 ${state.localDraws.length} 期`;
      showToast(`已导入 ${records.length} 期`);
    } catch (err) {
      showToast(`✕ 读取文件失败：${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  $('btnClearLocalSync').addEventListener('click', () => {
    if (!state.localDraws.length) { showToast('本机没有手动录入的开奖'); return; }
    state.localDraws = [];
    saveLocalDraws();
    refreshAfterDataChange();
    $('pasteMsg').textContent = '✓ 已清空本机手动录入的开奖';
    showToast('已清空本机开奖');
  });
}

/* ==================== 数据同步 ==================== */

/** 数据源缓存（本次会话内复用） */
const syncState = {
  remote: null, // 数据源解析出的开奖记录
  meta: null, // 数据源元信息 { updatedAt, latestId, totalCount }
  last: null, // 最近一次比对结果
  busy: false
};

/** 触发一次下载（Blob URL 延迟回收，避免部分浏览器在下载开始前就释放） */
function downloadJson(payload, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 读取仓库数据源（带 _r 参数绕过 Service Worker 的数据缓存） */
async function fetchSourceDb() {
  const res = await fetch(`./data/draws.json?_r=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const draws = (Array.isArray(data.draws) ? data.draws : []).map(normalizeDrawRecord).filter(Boolean);
  if (!draws.length) throw new Error('数据源里没有可用的开奖记录');
  syncState.remote = draws;
  syncState.meta = {
    updatedAt: data.updatedAt || '',
    latestId: data.latestId || draws[0].id,
    totalCount: data.totalCount ?? draws.length,
    source: data.source || ''
  };
  return draws;
}

function formatStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderSyncPanel() {
  const grid = $('syncGrid');
  if (!grid) return;
  const localLatest = state.allDraws[0] || null;
  const r = syncState.last;
  const cell = (label, value, cls) =>
    `<div class="sync-cell${cls ? ' ' + cls : ''}"><span class="sc-label">${label}</span><span class="sc-value">${value}</span></div>`;
  grid.innerHTML = [
    cell('本地最后一期', localLatest ? localLatest.id : '—'),
    cell('数据源最新一期', syncState.meta ? syncState.meta.latestId : '未读取'),
    cell('数据源更新时间', syncState.meta ? formatStamp(syncState.meta.updatedAt) : '—'),
    cell('本次可追加', r ? `${r.missingCount} 期` : '—', r && r.missingCount > 0 ? 'is-good' : ''),
    cell('冲突 / 缺口', r ? `${r.conflictCount} / ${r.gapCount}` : '—', r && (r.conflictCount || r.gapCount) ? 'is-warn' : '')
  ].join('');
  const cnt = $('localCountSync');
  if (cnt) cnt.textContent = String(state.localDraws.length);
}

/** 直连远程开奖源的候选地址（浏览器跨域限制下会依次尝试代理） */
const REMOTE_CANDIDATES = [
  DEFAULT_CONFIG.remoteSourceUrl,
  `https://api.allorigins.win/raw?url=${encodeURIComponent(DEFAULT_CONFIG.remoteSourceUrl)}`,
  `https://corsproxy.io/?${encodeURIComponent(DEFAULT_CONFIG.remoteSourceUrl)}`
];

/**
 * 尝试抓取远程开奖源页面（每个候选地址都有超时，失败就换下一个）
 * @returns {Promise<string>} 抓到的 HTML 文本（失败返回空串）
 */
async function fetchRemoteSourceHtml(timeoutMs = 5000) {
  for (const u of REMOTE_CANDIDATES) {
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(u, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) continue;
      const text = await res.text();
      if (text?.includes('期(开奖时间:')) return text;
    } catch {
      /* 试下一个 */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return '';
}

/**
 * 同步主流程：读取数据源 → 比对 → （可选）写入本机
 * 写入只落在 localStorage，内置底库不会被改动。
 */
async function runSync({ write = false, fix = false } = {}) {
  if (syncState.busy) return;
  syncState.busy = true;
  const status = $('syncStatus');
  const btns = ['btnSyncCheck', 'btnSyncNow', 'btnSyncFix', 'btnSyncReload'].map((id) => $(id)).filter(Boolean);
  btns.forEach((b) => { b.disabled = true; });
  status.textContent = '正在读取仓库数据源 ./data/draws.json …';
  try {
    await fetchSourceDb();
    const r = compareDrawSets(state.allDraws, syncState.remote);
    syncState.last = r;
    renderSyncPanel();

    if (fix) {
      if (!r.conflicts.length) {
        status.textContent = `检查完成：${formatSyncSummary(r)}；没有需要修复的冲突。`;
        showToast('没有冲突需要修复');
        return;
      }
      state.localDraws = mergeDraws(state.localDraws, r.conflicts.map((c) => c.remote)).merged;
      saveLocalDraws();
      refreshAfterDataChange();
      syncState.last = compareDrawSets(state.allDraws, syncState.remote);
      renderSyncPanel();
      status.textContent = `✓ 已按数据源修复 ${r.conflicts.length} 期冲突（${r.conflicts.map((c) => c.id).join('、')}），现在共 ${state.allDraws.length} 期`;
      showToast(`已修复 ${r.conflicts.length} 期冲突`);
      return;
    }

    if (!write) {
      status.textContent = `检查完成（未写入任何数据）：${formatSyncSummary(r)}`;
      showToast('检查完成');
      return;
    }

    if (r.appendable.length) {
      state.localDraws = mergeDraws(state.localDraws, r.appendable).merged;
      saveLocalDraws();
      refreshAfterDataChange();
      syncState.last = compareDrawSets(state.allDraws, syncState.remote);
      renderSyncPanel();
      const ids = r.appendable.map((d) => d.id);
      status.textContent = `✓ 已把 ${r.appendable.length} 期（${ids[0]} ~ ${ids[ids.length - 1]}）追加写入本机，现在共 ${state.allDraws.length} 期；内置底库未改动。`;
      showToast(`已同步 ${r.appendable.length} 期`);
      return;
    }

    // 仓库数据源没有更新 → 再试一次远程开奖源（代理可能被浏览器跨域拦截）
    status.textContent = '仓库数据源已是最新，正在尝试直连远程开奖源…';
    const html = await fetchRemoteSourceHtml();
    if (!html) {
      status.textContent = `同步完成：${formatSyncSummary(r)}；本机没有需要新增的期次。（远程源被浏览器跨域限制拦下，可改用下方「粘贴导入兜底」）`;
      showToast('已是最新，无需同步');
      return;
    }
    const parsed = parseDrawsInput(html);
    const r2 = compareDrawSets(state.allDraws, parsed);
    if (!r2.appendable.length) {
      status.textContent = `同步完成：仓库数据源与远程源都没有更新（远程源最新 ${r2.remoteLatest?.id || '未知'}）。`;
      showToast('已是最新，无需同步');
      return;
    }
    state.localDraws = mergeDraws(state.localDraws, r2.appendable).merged;
    saveLocalDraws();
    refreshAfterDataChange();
    const ids2 = r2.appendable.map((d) => d.id);
    status.textContent = `✓ 已从远程开奖源补齐 ${r2.appendable.length} 期（${ids2[0]} ~ ${ids2[ids2.length - 1]}），现在共 ${state.allDraws.length} 期；内置底库未改动。`;
    showToast(`已从远程源补齐 ${r2.appendable.length} 期`);
  } catch (err) {
    status.textContent = `读取数据源失败：${err.message}。可改用下方「粘贴导入兜底」。`;
    showToast('读取数据源失败');
    console.warn('[sync]', err);
  } finally {
    syncState.busy = false;
    btns.forEach((b) => { b.disabled = false; });
  }
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

/** 本工具专属的缓存名前缀（与 sw.js 保持一致） */
const CACHE_PREFIX = 'mark6-pick3-pick4-';

/**
 * 修复缓存：清空本工具的 Cache Storage + 让 Service Worker 重新安装 + 带随机参数重载
 * 绝不触碰 localStorage（本金赔率 / 自选号码 / 胆码 / 本地录入的开奖都会保留）
 *
 * 注意：同一个 GitHub Pages 源下可能还挂着其它工具，
 *      因此只清理本工具前缀的缓存、只注销属于本页面路径的 Service Worker。
 * @param {{hard?: boolean, message?: string}} [opts] hard=true 时额外注销 Service Worker
 */
async function repairCache(opts = {}) {
  const { hard = false, message = '已清理旧缓存，正在重新载入…' } = opts;
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      const scopePath = new URL('./', location.href).pathname;
      const mine = regs.filter((r) => {
        try {
          return new URL(r.scope).pathname.startsWith(scopePath);
        } catch {
          return false;
        }
      });
      if (hard) {
        await Promise.all(mine.map((r) => r.unregister()));
      } else {
        await Promise.all(mine.map((r) => r.update().catch(() => {})));
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
  renderSyncPanel();
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
