/**
 * 六合彩「7码复式 · 三中三 / 四中四」每日选号工具（简洁一页版）前端主控制器
 *
 * 一页流结构：① 今日推荐 → ② 自选7码 → ③ 开奖核对 → ④ 历史回放 → ⑤ 更多（折叠）
 * 核心算法（strategy / combinatorics / parser）与底库 data/draws.js 保持不变，仅重组界面与交互。
 */

import {
  ALL_NUMBERS,
  DEFAULT_CONFIG,
  getColorForNumber,
  getZodiacForNumber,
  pad2,
  padPeriod
} from './constants.js';
import { evaluate7CodeCompound, evaluateDirectTickets, normalizeNumbers } from './combinatorics.js';
import { mergeDraws, normalizeDrawRecord, parseDrawsInput } from './parser.js';
import { generatePeriodPlan, runHistoricalBacktest } from './strategy.js';
import INITIAL_DB from '../data/draws.js';

const STORAGE_KEYS = {
  CONFIG: 'mark6_pick3_config_v1',
  LOCAL_DRAWS: 'mark6_pick3_local_draws_v1',
  CUSTOM_PICKS: 'mark6_pick3_custom_picks_v1'
};

const PERIOD_SELECT_LIMIT = 120; // 期数下拉只放近期，避免上千个 option 撑爆 DOM
const HISTORY_PAGE = 30;

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

  historyVisible: HISTORY_PAGE
};

const planCache = new Map();

/* ==================== 小工具 ==================== */

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  $('toastContainer')?.appendChild(el);
  setTimeout(() => el.remove(), 2800);
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
    showToast(`✅ ${label}`);
  } catch {
    showToast('复制失败，请手动选择复制');
  }
}

function money(n) {
  const v = Number(n || 0);
  return `${v > 0 ? '+' : ''}${v.toLocaleString('zh-CN')} 元`;
}

const numsText = (nums) => nums.map(pad2).join(' ');

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
  try {
    const cfg = JSON.parse(localStorage.getItem(STORAGE_KEYS.CONFIG) || 'null');
    if (cfg) state.config = { ...DEFAULT_CONFIG, ...cfg };
  } catch { /* ignore */ }
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_DRAWS) || '[]');
    if (Array.isArray(arr)) state.localDraws = arr.map(normalizeDrawRecord).filter(Boolean);
  } catch { state.localDraws = []; }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_PICKS) || 'null');
    if (saved?.picks) {
      state.customPicks = normalizeNumbers(saved.picks, { maxCount: 7 });
      state.pinnedPicks = normalizeNumbers(saved.pinned || [], { maxCount: 6 })
        .filter((n) => state.customPicks.includes(n));
    }
  } catch { /* ignore */ }
  rebuildMergedDraws();
}

function saveConfig() {
  try { localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(state.config)); } catch { /* ignore */ }
}
function saveLocalDraws() {
  try { localStorage.setItem(STORAGE_KEYS.LOCAL_DRAWS, JSON.stringify(state.localDraws)); } catch { /* ignore */ }
}
function saveCustomPicks() {
  try {
    localStorage.setItem(STORAGE_KEYS.CUSTOM_PICKS, JSON.stringify({ picks: state.customPicks, pinned: state.pinnedPicks }));
  } catch { /* ignore */ }
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
  $('dbBadge').textContent = `${state.allDraws.length} 期${years.length ? ` (${years[0]}–${years[years.length - 1]})` : ''}`;
  if (latest) {
    $('latestLine').textContent = `最新 ${latest.year}年第${latest.period}期 (${latest.date})：${numsText(latest.numbers)} + 特 ${pad2(latest.special)}`;
  }
  $('cfgStake').value = state.config.stake;
  $('cfgOdds3').value = state.config.odds3;
  $('cfgOdds4').value = state.config.odds4;
}

function populatePeriodSelect() {
  const select = $('periodSelect');
  const next = getNextDrawMeta();
  const opts = [`<option value="NEXT">🌟 下一期 ${next.year}年第${next.period}期 (${next.date})</option>`];
  // 若当前选的期不在近期列表内（如从历史深处点入），补一个临时 option 保证可选中
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
      ? '<span class="tag tag-win">🎉 中奖</span>'
      : det ? `<span class="tag tag-muted">中 ${det.hitCount}</span>` : '';
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
    box.innerHTML = `<div class="result-strip"><div class="result-label">⏳ 这一期还没开奖</div><p class="hint-line">开奖后到下方「✍️ 开奖核对」输一期号码即可核对；也可以在期数下拉里选往期看复盘。</p></div>`;
  } else {
    const k = compound.matchedNormalCount;
    const p3 = compound.pick3;
    const p4 = compound.pick4;
    const winCls = k >= 3 ? ' win' : '';
    // 回放命中明细：列出实际中奖的具体组合（无中奖则不占屏）
    const winDetail = [
      p3.winningCombos.length ? `<div>🎉 三中三命中组合（${p3.winningCombos.length} 注）：${p3.winningCombos.map((c) => numsText(c.nums)).join('；')}</div>` : '',
      p4.winningCombos.length ? `<div>🎉 四中四命中组合（${p4.winningCombos.length} 注）：${p4.winningCombos.map((c) => numsText(c.nums)).join('；')}</div>` : ''
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
  const need = state.comboTab === 'pick4' ? 4 : 3;

  grid.innerHTML = part.combos.map((c) => {
    const cls = c.isWin ? ' combo-win' : sim && c.hitCount === need - 1 ? ' combo-partial' : '';
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

function parseNumbersFromText(text, max = 8) {
  const raw = (String(text || '').match(/\d+/g) || []).map(Number);
  const seen = new Set();
  const out = [];
  for (const n of raw) {
    if (Number.isInteger(n) && n >= 1 && n <= 49 && !seen.has(n)) { seen.add(n); out.push(n); }
    if (out.length >= max) break;
  }
  return out;
}

function entryTarget() {
  const year = Number($('entryYear').value) || 2026;
  const periodNum = Number($('entryPeriod').value) || 1;
  const date = $('entryDate').value || `${year}-01-01`;
  return { year, periodNum, period: padPeriod(periodNum), date };
}

function initEntryDefaults() {
  const next = getNextDrawMeta();
  $('entryYear').value = next.year;
  $('entryPeriod').value = next.periodNum;
  $('entryDate').value = next.date;
}

function renderCheck() {
  const nums = parseNumbersFromText($('entryLine')?.value, 7);
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

/* ==================== 渲染：④ 历史与回测 ==================== */

function populateHistoryYears() {
  const years = [...new Set(state.allDraws.map((d) => d.year))].sort((a, b) => b - a);
  const sel = $('histYear');
  const cur = sel.value || 'all';
  sel.innerHTML = '<option value="all">全部年份</option>' + years.map((y) => `<option value="${y}">${y} 年</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'all';
}

function filteredHistory() {
  const year = $('histYear').value;
  const q = $('histSearch').value.trim().toLowerCase();
  return state.allDraws.filter((d) => {
    if (year !== 'all' && String(d.year) !== year) return false;
    if (!q) return true;
    const hay = `${d.id} ${d.year}年第${d.period}期 ${d.date} ${numsText(d.numbers)} ${pad2(d.special)} ${d.numbers.join(',')}`;
    return hay.toLowerCase().includes(q);
  });
}

function renderHistory() {
  const list = filteredHistory();
  const visible = list.slice(0, state.historyVisible);
  $('histCount').textContent = `共 ${list.length} 期，显示 ${visible.length} 期 · 点击任意一期 = 回放该期（用当期之前的数据生成推荐，再和实际开奖核对）`;
  $('histList').innerHTML = visible.map((d) => `
    <button type="button" class="history-item" data-jump="${d.id}">
      <span class="hist-period">${d.year}年第${d.period}期<small>${d.date}</small></span>
      <span class="ball-row">${drawBallsHtml(d, { size: 'sm', zodiac: false })}</span>
    </button>`).join('') || '<p class="hint-line">没有匹配的记录。</p>';
  $('btnMoreHist').style.display = list.length > visible.length ? '' : 'none';
}

function runBacktestUi() {
  const strategySel = $('btStrategy').value;
  const isCustom = strategySel === 'custom';
  if (isCustom && state.customPicks.length !== 7) {
    showToast('先在「自选」里选满 7 码，再用它回测');
    return;
  }
  $('btResult').innerHTML = '<p class="hint-line">正在逐期回测（每期只用之前的数据生成推荐），请稍候…</p>';
  setTimeout(() => {
    const cfg = betConfig();
    const result = runHistoricalBacktest(state.allDraws, {
      year: 'all',
      limit: Number($('btLimit').value) || 60,
      strategyId: isCustom ? 'composite' : strategySel,
      customNumbers: isCustom ? state.customPicks : null,
      betMode: $('btMode').value,
      ...cfg
    });
    const s = result.summary;
    renderBacktestResult(result, s);
  }, 30);
}

function renderBacktestResult(result, s) {
  const hits = result.records.filter((r) => r.active3.winCount > 0 || r.active4.winCount > 0);
  const hitsHtml = hits.length
    ? hits.map((r) => `<div class="bt-hit-item"><b>${r.draw.year}年第${r.draw.period}期</b> (${r.draw.date}) · 7码 ${numsText(r.sevenNumbers)} · 正码 ${numsText(r.draw.numbers)} · 中 ${r.matchedNormalCount} 个 · 三中三 ${r.active3.winCount} 注 / 四中四 ${r.active4.winCount} 注 · 本期净 ${money(r.active3.netProfit + r.active4.netProfit)}</div>`).join('')
    : '<p class="hint-line">这段时间里没有三中三 / 四中四命中期。</p>';

  $('btResult').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">回测期数</div><div class="kpi-value">${s.totalPeriods} 期</div><div class="kpi-sub">${s.betMode === 'featured5' ? '精选5注/期' : '复式35注/期'}</div></div>
      <div class="kpi-card"><div class="kpi-label">三中三命中</div><div class="kpi-value gold">${s.pick3.hitPeriods} 期 · ${s.pick3.totalWinBets} 注</div><div class="kpi-sub">命中率 ${s.pick3.hitRate}%</div></div>
      <div class="kpi-card"><div class="kpi-label">四中四命中</div><div class="kpi-value gold">${s.pick4.hitPeriods} 期 · ${s.pick4.totalWinBets} 注</div><div class="kpi-sub">命中率 ${s.pick4.hitRate}%</div></div>
      <div class="kpi-card"><div class="kpi-label">三中三净收益 / ROI</div><div class="kpi-value ${s.pick3.netProfit >= 0 ? 'positive' : 'negative'}">${money(s.pick3.netProfit)}</div><div class="kpi-sub">ROI ${s.pick3.roi}% · 投入 ${s.pick3.totalCost.toLocaleString()} 元</div></div>
      <div class="kpi-card"><div class="kpi-label">四中四净收益 / ROI</div><div class="kpi-value ${s.pick4.netProfit >= 0 ? 'positive' : 'negative'}">${money(s.pick4.netProfit)}</div><div class="kpi-sub">ROI ${s.pick4.roi}% · 投入 ${s.pick4.totalCost.toLocaleString()} 元</div></div>
    </div>
    <p class="hint-line" style="margin-bottom:6px;">命中的期数（共 ${hits.length} 期）：</p>
    ${hitsHtml}`;
}

/* ==================== 数据变更后统一刷新 ==================== */

function refreshAfterDataChange() {
  rebuildMergedDraws();
  renderHeader();
  populatePeriodSelect();
  populateHistoryYears();
  initEntryDefaults();
  renderToday();
  renderPicker();
  renderCheck();
  renderHistory();
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
    renderPicker(); // 35 注高亮默认按当期正码
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
    const nums = parseNumbersFromText($('simInput').value, 6);
    if (nums.length !== 6) { showToast('请输入 6 个不重复的正码（01–49）'); return; }
    state.simNormals = nums;
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
    const nums = parseNumbersFromText($('entryLine').value, 7);
    if (nums.length !== 7) { showToast('请先输入完整的 6 正码 + 1 特码'); return; }
    const t = entryTarget();
    const rec = normalizeDrawRecord({ year: t.year, periodNum: t.periodNum, date: t.date, numbers: nums.slice(0, 6), special: nums[6] });
    if (!rec) { showToast('号码格式不对，保存失败'); return; }
    const existed = state.allDraws.some((d) => d.id === rec.id);
    mergeIncoming([rec]);
    $('entryLine').value = '';
    renderCheck();
    showToast(existed ? `已更新 ${rec.year}年第${rec.period}期` : `✅ 已保存 ${rec.year}年第${rec.period}期`);
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
    state.localDraws = [];
    saveLocalDraws();
    refreshAfterDataChange();
    showToast('本地保存的开奖已清空');
  });

  /* ④ 历史与回测 */
  $('histYear').addEventListener('change', () => { state.historyVisible = HISTORY_PAGE; renderHistory(); });
  $('histSearch').addEventListener('input', () => { state.historyVisible = HISTORY_PAGE; renderHistory(); });
  $('btnMoreHist').addEventListener('click', () => { state.historyVisible += HISTORY_PAGE; renderHistory(); });
  $('histList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-jump]');
    if (!item) return;
    state.periodKey = item.dataset.jump;
    populatePeriodSelect();
    renderToday();
    renderPicker();
    document.getElementById('today').scrollIntoView({ behavior: 'smooth' });
  });
  $('btnBacktest').addEventListener('click', runBacktestUi);

  /* ⑤ 设置 */
  const onConfigChange = () => {
    state.config.stake = Math.max(1, Number($('cfgStake').value) || DEFAULT_CONFIG.stake);
    state.config.odds3 = Math.max(1, Number($('cfgOdds3').value) || DEFAULT_CONFIG.odds3);
    state.config.odds4 = Math.max(1, Number($('cfgOdds4').value) || DEFAULT_CONFIG.odds4);
    saveConfig();
    renderToday();
    renderPicker();
    renderCheck();
  };
  ['cfgStake', 'cfgOdds3', 'cfgOdds4'].forEach((id) => $(id).addEventListener('change', onConfigChange));
  $('btnResetCfg').addEventListener('click', () => {
    state.config = { ...state.config, stake: DEFAULT_CONFIG.stake, odds3: DEFAULT_CONFIG.odds3, odds4: DEFAULT_CONFIG.odds4 };
    saveConfig();
    renderHeader();
    renderToday();
    renderPicker();
    renderCheck();
    showToast('已恢复默认本金与赔率');
  });

  /* ⑤ 数据同步与导入 */
  $('btnSyncRepo').addEventListener('click', async () => {
    const status = $('syncStatus');
    status.textContent = '正在拉取 ./data/draws.json…';
    try {
      const res = await fetch(`./data/draws.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming = Array.isArray(data.draws) ? data.draws : [];
      const { merged, addedCount, updatedCount } = mergeDraws(state.baseDraws, incoming);
      state.baseDraws = merged;
      refreshAfterDataChange();
      status.textContent = `✓ 已刷新：共 ${state.allDraws.length} 期（新增 ${addedCount}、更新 ${updatedCount}）`;
      showToast('底库刷新成功');
    } catch {
      status.textContent = `拉取失败，已继续使用内置 ${state.allDraws.length} 期底库（离线可用）。`;
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
      status.textContent = '⚠️ 远程直连被浏览器跨域拦截，请用下方「粘贴导入」，或等待 GitHub Actions 每日自动同步。';
      return;
    }
    const parsed = parseDrawsInput(html);
    const added = mergeIncoming(parsed);
    status.textContent = `✓ 远程解析 ${parsed.length} 期（净增 ${added} 期），现在共 ${state.allDraws.length} 期`;
    showToast('远程同步成功');
  });

  $('btnExport').addEventListener('click', () => {
    const payload = {
      updatedAt: new Date().toISOString(),
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
      msg.textContent = '❌ 没识别出有效记录（需要期号 + 6正码 + 特码）';
      return;
    }
    const added = mergeIncoming(parsed);
    msg.textContent = `✓ 解析 ${parsed.length} 期（净增 ${added} 期），共 ${state.allDraws.length} 期`;
    showToast(`✅ 已导入 ${parsed.length} 期`);
  });
  $('btnPasteDemo').addEventListener('click', () => {
    const next = getNextDrawMeta();
    $('pasteBox').value = `${next.periodNum}期(开奖时间:${next.date})\n08 猪 14 蛇 23 猴 26 蛇 31 鼠 45 狗 12 羊`;
  });
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const parsed = parseDrawsInput(await file.text());
    if (!parsed.length) { showToast(`文件 ${file.name} 未解析出开奖记录`); return; }
    const added = mergeIncoming(parsed);
    $('pasteMsg').textContent = `✓ 从 ${file.name} 导入 ${parsed.length} 期（净增 ${added} 期）`;
    showToast(`已从 ${file.name} 导入 ${parsed.length} 期`);
    e.target.value = '';
  });
}

/* ==================== 初始化 ==================== */

function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* 受限环境忽略 */ });
    });
  }
}

function initApp() {
  loadSavedState();
  renderHeader();
  populatePeriodSelect();
  populateHistoryYears();
  initEntryDefaults();
  bindEvents();
  renderToday();
  renderPicker();
  renderCheck();
  renderHistory();
  registerServiceWorker();
}

initApp();
