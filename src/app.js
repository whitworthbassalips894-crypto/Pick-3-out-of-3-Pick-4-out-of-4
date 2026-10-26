/**
 * 六合彩「每日 5 注」前端主控制器（特码 / 三中三 / 四中四）
 *
 * 一页流结构：① 今日 5 注 → ② 历史回放 → ③ 数据（折叠） → ④ 设置（折叠）
 *
 * 关键约定：
 *  - 「每日 5 注」= 1 注完全随机（纯 49 选 size，允许与精选重复）+ 4 注风格精选
 *    （热号 / 冷号 / 形态均衡 / 补位覆盖），四注精选之间互不重复（见 src/dailyfive.js）。
 *  - 特码玩法命中 = 开奖的最后一个号码落在这注的 5 个号里；
 *    三中三 / 四中四命中 = 这注号码全部落在 6 个正码里（特码不计入）。
 *  - 历史回放严格「无未来函数」：第 T 期推荐只用 T 期之前的数据。
 *  - 任何异常都要给出明确提示，不能白屏，也不能永远停在「加载中…」。
 */

import {
  APP_BUILD,
  APP_VERSION_LABEL,
  DEFAULT_CONFIG,
  getColorForNumber,
  getPlayMode,
  getZodiacForNumber,
  pad2
} from './constants.js';
import { evaluateTickets } from './combinatorics.js';
import { mergeDraws, normalizeDrawRecord, parseDrawsInput } from './parser.js';
import { compareDrawSets, formatSyncSummary } from './sync.js';
import { formatFiveTickets, formatSingleTicket } from './copy.js';
import {
  buildDailyFiveRecords,
  generateDailyFive,
  summarizeDailyFive
} from './dailyfive.js';
import { directBaseline, expectedReturnRate, formatPercent } from './statistics.js';
import { nextPeriodMeta } from './periods.js';
import { auditDraws, formatAuditSummary } from './audit.js';
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

  customPicks: [], // 旧版自选号码：本页已不再使用，仅为兼容历史存储保留
  pinnedPicks: [],

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
    range: '120' // 30 / 60 / 120 / 365 / all
  }
};

const planCache = new Map();

/* ==================== 小工具 ==================== */

const $ = (id) => document.getElementById(id);

/**
 * 安全绑定：元素不存在时直接跳过（本页已删掉自选 / 核对等区块，
 * 旧的事件绑定不能因为找不到元素就把整个初始化打断）
 */
const on = (id, evt, fn, opts) => {
  const el = $(id);
  if (el) el.addEventListener(evt, fn, opts);
};

/**
 * 当前玩法
 *  - special = 特码（每注 5 个号，命中 = 开奖的最后一个号码落在这 5 个号里）
 *  - pick3   = 三中三（每注 3 个号，全部落在 6 个正码里）
 *  - pick4   = 四中四（每注 4 个号，全部落在 6 个正码里）
 */
function playMode() {
  return getPlayMode(state.config?.playMode).id;
}

/** 把「玩法 id」或「每注号码个数」统一解析成玩法 id */
function resolveMode(x) {
  if (x === 3 || x === '3' || x === 'pick3') return 'pick3';
  if (x === 4 || x === '4' || x === 'pick4') return 'pick4';
  if (x === 5 || x === '5' || x === 'special') return 'special';
  return playMode();
}

/** 当前玩法的每注号码个数（特码 5 / 三中三 3 / 四中四 4） */
function targetSize(mode = playMode()) {
  return getPlayMode(resolveMode(mode)).size;
}

/** 玩法简称（特码 / 选三 / 选四） */
const modeName = (mode = playMode()) => getPlayMode(resolveMode(mode)).name;

/** 玩法全名（特码 / 三中三 / 四中四） */
const modeTitle = (mode = playMode()) => getPlayMode(resolveMode(mode)).title;

/** 当前玩法对应的赔率 */
const currentOdds = (mode = playMode()) =>
  Number(state.config[getPlayMode(resolveMode(mode)).oddsKey]);

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
  const specialTitle = opts.special
    ? (opts.specialCounts ? '（特码，本玩法按它判定命中）' : '（特码，不计入命中）')
    : '';
  return `<span class="${cls.join(' ')}" title="${pad2(n)}${specialTitle}">${pad2(n)}</span>`;
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
  // 旧版本是 7 码复式自选；直选玩法每注只放 3 / 4 个号，这里按当前玩法收敛（其余号码保留在旧版本数据里，不再参与计算）
  const size = targetSize();
  if (state.customPicks.length > size) {
    state.customPicks = state.customPicks.slice(0, size);
    state.pinnedPicks = state.pinnedPicks.filter((n) => state.customPicks.includes(n));
    saveCustomPicks();
    console.info(`[storage] 自选号码已按${modeName(size)}收敛为 ${size} 个`);
  }
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

/**
 * 下一期的年份 / 期号 / 日期
 *
 * 期号约定是「当年第几天」（2024 年有 366 期），所以跨年必须按日历判断：
 * 旧实现用 `periodNum > 366` 这个固定常量，会把平年（365 天）的 12-31 算成
 * 「第 366 期」这种不存在的期号。现在统一交给 src/periods.js 处理（有单测）。
 */
function getNextDrawMeta() {
  return nextPeriodMeta(state.allDraws[0] || { year: 2026, periodNum: 296, date: '2026-10-23' });
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
  const mode = playMode();
  const size = targetSize(mode);
  const sig = `${target.year}-${target.periodNum}|mode:${mode}|${state.allDraws.length}:${state.allDraws[0]?.id || ''}|salt:${state.randomSalt}`;
  if (!planCache.has(sig)) {
    planCache.set(sig, generateDailyFive(
      state.allDraws,
      { year: target.year, periodNum: target.periodNum, date: target.date },
      { randomSalt: state.randomSalt, mode }
    ));
  }
  return planCache.get(sig);
}

const betConfig = () => ({
  stake: state.config.stake,
  odds3: state.config.odds3,
  odds4: state.config.odds4,
  oddsSpecial: state.config.oddsSpecial ?? DEFAULT_CONFIG.oddsSpecial
});

/* ==================== 文案（复制用） ==================== */

/**
 * 复制内容统一规范：**只有号码、每注一行、顿号分隔**，不含任何汉字、标题或多余数字。
 * 详细规则与测试见 src/copy.js。
 */

/** 今日 5 注（每注一行：选三 3 个号 / 选四 4 个号） */
function fiveText(plan) {
  return formatFiveTickets(plan.five);
}

/** 单注直选（3 码 / 4 码） */
function fiveCardText(e) {
  return formatSingleTicket(e.numbers);
}

/**
 * 「更多 → 本金与赔率」里的赔率提示：如实展示期望回报率
 *
 * 特码玩法的公平赔率是 9.8 倍（5 个号覆盖 1 个特码）；如果用户填了 48 倍（传统「押 1 个号」的赔率），
 * 期望回报率会算到 489% —— 数学上不可能长期成立，必须提醒用户核对。
 */
function renderOddsNote() {
  const el = $('cfgOddsNote');
  if (!el) return;
  const stake = Number(state.config.stake) || DEFAULT_CONFIG.stake;
  const rows = [
    { key: 'oddsSpecial', label: '特码（5 个号）', mode: 'special' },
    { key: 'odds3', label: '三中三（3 个号）', mode: 'pick3' },
    { key: 'odds4', label: '四中四（4 个号）', mode: 'pick4' }
  ];
  const parts = rows.map(({ key, label, mode }) => {
    const odds = Number(state.config[key]) || 0;
    const base = directBaseline(mode);
    const ev = expectedReturnRate(mode, odds);
    const fair = base.fairOdds;
    const flag = ev > 1 + 1e-6
      ? ' ⚠ 高于公平赔率，期望回报率会超过 100%，真实博彩有抽水，请核对赔率'
      : ev < 0.5 ? '（长期为负）' : ev > 1 - 1e-6 ? '（公平值）' : '';
    const marketHint = mode === 'special'
      ? `；5 个号一注的默认赔率是 9.6 倍（期望回报率 98.0%），9.8 倍即公平赔率；48 倍是「押 1 个号」的赔率，套到 5 个号上会算出 489.8% 的期望回报率，不现实`
      : '';
    return `${label}：${odds} 倍 → 单注命中 P = ${formatPercent(base.hitProb, 4)}，公平赔率约 ${fair % 1 === 0 ? fair : fair.toFixed(1)} 倍，期望回报率约 ${formatPercent(ev, 1)}${flag}${marketHint}`;
  });
  el.innerHTML = `期望回报率 = 赔率 × 命中概率（1 = 公平）。当前：<br>${parts.map(escapeHtml).join('<br>')}`;
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
  const latestLine = $('latestLine');
  if (latest && latestLine) {
    latestLine.textContent = `最新 ${latest.year}年第${latest.period}期 (${latest.date})：${numsText(latest.numbers)} + 特 ${pad2(latest.special)}`;
  }
  const cfgStake = $('cfgStake');
  if (cfgStake) cfgStake.value = state.config.stake;
  const cfgOdds3 = $('cfgOdds3');
  if (cfgOdds3) cfgOdds3.value = state.config.odds3;
  const cfgOdds4 = $('cfgOdds4');
  if (cfgOdds4) cfgOdds4.value = state.config.odds4;
  const cfgOddsSpecial = $('cfgOddsSpecial');
  if (cfgOddsSpecial) cfgOddsSpecial.value = state.config.oddsSpecial ?? DEFAULT_CONFIG.oddsSpecial;
  renderOddsNote();
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

function fiveCardHtml(e, ctx, cfg, consensusSet = new Set(), index = 1) {
  const t = ctx.target;
  const size = e.numbers.length;
  const mode = resolveMode(size);
  const isSpecial = mode === 'special';
  // 直选：命中 = 这一注的号码全部落在 6 个正码里
  // 特码：命中 = 开奖的最后一个号码落在这 5 个号里
  const drawNormals = ctx.draw ? ctx.draw.numbers.slice(0, 6) : [];
  const hitSet = ctx.draw
    ? new Set(isSpecial
      ? (ctx.draw.special != null && e.numbers.includes(ctx.draw.special) ? [ctx.draw.special] : [])
      : e.numbers.filter((x) => drawNormals.includes(x)))
    : null;
  const balls = e.numbers.map((n) => ballHtml(n, {
    size: 'lg',
    date: t.date,
    hitSet,
    consensus: consensusSet.has(n)
  })).join('');
  const shape = e.shape || { odd: 0, even: 0, big: 0, small: 0, zone1: 0, zone2: 0, zone3: 0, red: 0, blue: 0, green: 0, sum: 0 };

  let hitHtml = '';
  if (ctx.draw) {
    const ev = evaluateTickets([e.numbers], ctx.draw, { ...cfg, playMode: mode, targetSize: size });
    const d = ev.details[0] || { hitNums: [], hitCount: 0, isWin: false, payout: 0 };
    const label = isSpecial
      ? (d.isWin
        ? `中特码 ✓ 返奖 ${amount(d.payout)}`
        : `未中 · 特码 ${ctx.draw.special != null ? pad2(ctx.draw.special) : '—'} 不在这 ${size} 个号里`)
      : (d.isWin ? `中${size} ✓ 返奖 ${amount(d.payout)}` : `未中 · 命中 ${d.hitCount}/${size} 个正码`);
    hitHtml = `
      <div class="fc-hit">
        <span class="tag ${d.isWin ? 'tag-win' : 'tag-muted'}">${label}</span>
        ${d.hitNums.length ? `<span class="tag tag-muted">命中 ${numsText(d.hitNums)}</span>` : ''}
      </div>`;
  }

  return `
    <article class="five-card${e.random ? ' is-random' : ''}" data-five="${escapeHtml(e.id)}">
      <header class="fc-head">
        <span class="fc-idx">第 ${index} 注</span>
        <span class="fc-icon">${e.icon}</span>
        <span class="fc-name">${escapeHtml(e.name)}</span>
        ${e.random ? '<span class="tag tag-muted">随机对照</span>' : '<span class="tag tag-gold">精选</span>'}
        <span class="fc-actions">
          <button type="button" class="btn btn-sm" data-copy-five="${escapeHtml(e.id)}">复制本注</button>
        </span>
        <span class="fc-rationale">${escapeHtml(e.rationale || '')}</span>
      </header>
      <div class="fc-body">
        <div class="fc-balls">${balls}</div>
        <div class="fc-shape">
          <span>奇偶 ${shape.odd}:${shape.even}</span>
          <span>大小 ${shape.big}:${shape.small}</span>
          <span>三区 ${shape.zone1}-${shape.zone2}-${shape.zone3}</span>
          <span>和值 ${shape.sum}</span>
        </div>
      </div>
      <div class="fc-foot">${hitHtml}</div>
    </article>`;
}

function renderToday() {
  const ctx = getPeriodContext();
  const mode = playMode();
  const size = targetSize(mode);
  const isSpecial = mode === 'special';
  const plan = getFivePlan(ctx.target);
  const t = ctx.target;
  const cfg = betConfig();
  const odds = currentOdds(mode);
  const baseline = directBaseline(mode);
  const cov = plan.coverage || { distinct: size * 5, perTicket: baseline.hitProb, anyHit: 0 };

  // 玩法切换按钮的选中态
  document.querySelectorAll('#modeSwitch .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  const heroPeriod = $('heroPeriod');
  if (heroPeriod) {
    heroPeriod.textContent = ctx.isUpcoming
      ? `${t.year}年第${t.period}期 · 待开奖`
      : `${t.year}年第${t.period}期 · 已开奖`;
  }
  const heroMeta = $('heroMeta');
  if (heroMeta) {
    heroMeta.textContent = cov.overlap > 0
      ? `5 注合计覆盖 ${cov.distinct} 个号（随机注与精选重复 ${cov.overlap} 个）`
      : `5 注合计覆盖 ${cov.distinct} 个号`;
  }
  const resetBtn = $('btnResetRandom');
  if (resetBtn) resetBtn.disabled = state.randomSalt === 0;

  const grid = $('fiveGrid');
  if (grid) {
    grid.innerHTML = plan.five.map((e, i) => fiveCardHtml(e, ctx, cfg, new Set(), i + 1)).join('');
  }

  const box = $('heroResult');
  if (box) {
    if (!ctx.draw) {
      box.innerHTML = '';
    } else {
      // 每注 1 注投注：直选 = 号码全部落在 6 正码里；特码 = 特码落在这 5 个号里
      const perFive = plan.five.map((e) => {
        const ev = evaluateTickets([e.numbers], ctx.draw, { ...cfg, playMode: mode, targetSize: size });
        return { e, d: ev.details[0] || { isWin: false, hitCount: 0, hitNums: [], payout: 0 } };
      });
      const wins = perFive.filter((p) => p.d.isWin).length;
      const net = perFive.reduce((a, p) => a + p.d.payout, 0) - perFive.length * cfg.stake;
      box.innerHTML = `
        <div class="result-strip${wins ? ' win' : ''}">
          <div class="result-label">本期开奖 · 5 注中 ${wins} 注${isSpecial ? '特码' : modeTitle(mode)}</div>
          <div class="ball-row">${drawBallsHtml(ctx.draw, { size: 'sm', hitSet: new Set(plan.five.flatMap((e) => e.numbers)) })}</div>
          <div class="kpi-inline">
            <div class="kpi-chip"><div class="k-label">命中注数</div><div class="k-value ${wins ? 'positive' : ''}">${wins} / 5</div></div>
            <div class="kpi-chip"><div class="k-label">本期净收益</div><div class="k-value ${net >= 0 ? 'positive' : 'negative'}">${money(net)}</div></div>
            <div class="kpi-chip"><div class="k-label">逐注</div><div class="k-value gold">${perFive.map((p) => `${p.e.code} ${isSpecial ? (p.d.isWin ? '✓' : '×') : p.d.hitCount}`).join(' · ')}</div></div>
          </div>
        </div>`;
    }
  }

  const ev = expectedReturnRate(mode, odds);
  const fair = baseline.fairOdds >= 100 ? Math.round(baseline.fairOdds) : baseline.fairOdds.toFixed(1);
  const costLine = $('featuredCostLine');
  if (costLine) {
    costLine.innerHTML = [
      `单注 ${cfg.stake} 元 × 5 注 = ${amount(5 * cfg.stake)}`,
      `单注命中 ${formatPercent(cov.perTicket, 4)}（公平赔率 ${fair} 倍）`,
      `当前赔率 ${odds} 倍 → 回报率 <b>${formatPercent(ev, 1)}</b>`,
      `5 注至少中 1 注 <b>${formatPercent(cov.anyHit, 3)}</b>`
    ].join(' · ');
  }
}

/* ==================== 渲染：④ 历史回放 ==================== */

/**
 * 更新回放范围下拉里的「全部（N 期）」文案
 *
 * 说明：年度 / 命中 / 搜索筛选已下线，这里只剩「范围」一个维度。
 * 每次底库变化都要重刷，否则「全部」后面显示的还是旧期数。
 */
function syncHistRangeLabel() {
  const opt = $('histRange')?.querySelector('option[value="all"]');
  if (opt) opt.textContent = `全部（${state.allDraws.length} 期）`;
}

/** 依据「范围」筛出需要回放的期次 */
function replayTargets() {
  const f = replay.filters;
  let list = state.allDraws;
  if (f.range !== 'all') {
    const n = Math.max(1, Number(f.range) || 0);
    list = list.slice(0, n);
  }
  return list;
}

/**
 * 逐期回放（严格无未来函数）
 *
 * 每次都按当前「范围 + 玩法 + 随机盐值」重新计算；token 用于丢弃过期结果，
 * 任何提前 return 的分支都必须把 replay.running 复位，否则后续点击会被静默忽略。
 */
async function runReplay() {
  const status = $('replayStatus');
  const token = ++replay.token;

  const mode = playMode();
  const targets = replayTargets();
  if (targets.length === 0) {
    replay.running = false;
    replay.records = [];
    replay.filtered = [];
    if (status) status.textContent = '当前范围没有可回放的期次。';
    renderReplayTable();
    return;
  }

  replay.running = true;
  replay.expanded.clear(); // 换了范围 / 玩法，展开行按新列表重新来过
  const started = Date.now();
  if (status) status.textContent = `正在逐期回放 ${targets.length} 期（每期只用该期之前的数据）…`;

  const cfg = betConfig();
  const records = [];
  const chunk = Math.max(1, REPLAY_CHUNK);

  for (let i = 0; i < targets.length; i += chunk) {
    if (token !== replay.token) return; // 已有更新的任务接管，本次结果作废（running 由新任务维护）
    const part = buildDailyFiveRecords(state.allDraws, targets.slice(i, i + chunk), {
      ...cfg,
      randomSalt: state.randomSalt,
      mode
    });
    records.push(...part);
    if (status) status.textContent = `正在逐期回放… ${records.length}/${targets.length} 期`;
    // 让出主线程，保证筛选、滚动等交互不卡
    await new Promise((r) => setTimeout(r, 0));
  }

  if (token !== replay.token) return;

  replay.records = records;
  replay.filtered = records;
  replay.visible = REPLAY_PAGE;
  replay.running = false;
  const cost = ((Date.now() - started) / 1000).toFixed(1);
  if (status) status.textContent = `✓ 已回放 ${records.length} 期（耗时 ${cost}s，无未来函数）。`;
  renderReplayTable();
}

/** 单期收益（每注 1 注投注，命中返奖 = 本金 × 赔率） */
function periodMoney(rec) {
  const cfg = betConfig();
  const mode = playMode();
  const size = targetSize(mode);
  const odds = currentOdds(mode);
  let wins = 0;
  let cost = 0;
  let payout = 0;
  for (const e of rec.five) {
    if (e.isWin) wins++;
    cost += cfg.stake;
    payout += e.payout || 0;
  }
  return {
    size,
    wins,
    cost,
    payout,
    net: payout - cost,
    odds
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
  const mode = playMode();
  const size = targetSize(mode);
  const isSpecial = mode === 'special';

  // 当期 6 正码：命中任意一注的号码描边（特码玩法里正码不参与命中，只有特码描边）
  const anyHit = new Set(rec.five.flatMap((e) => e.hitNums || []));
  const normalBalls = d.numbers.map((n) => miniBallHtml(n, { hit: !isSpecial && anyHit.has(n), miss: isSpecial || !anyHit.has(n) })).join('');
  const specialBall = d.special != null
    ? miniBallHtml(d.special, {
      special: true,
      specialCounts: isSpecial,
      hit: isSpecial && anyHit.has(d.special),
      miss: !(isSpecial && anyHit.has(d.special))
    })
    : '<span class="badge special">—</span>';

  // 5 注逐注命中
  const perFive = rec.five.map((e) => {
    const cls = e.isWin ? 'hit' : e.hitCount > 0 ? 'warm' : 'miss';
    const title = isSpecial
      ? (e.isWin ? `${e.name} 覆盖了特码` : `${e.name} 没覆盖特码`)
      : (e.isWin ? `${e.name} 命中 ${size} 个正码` : `${e.name} 命中 ${e.hitCount}/${size} 个正码`);
    const badgeText = isSpecial ? (e.isWin ? '✓' : '×') : (e.isWin ? '✓' : e.hitCount);
    return `<span class="badge ${cls}" title="${escapeHtml(title)}">${escapeHtml(e.code)} ${badgeText}</span>`;
  }).join(' ');

  const m = periodMoney(rec);
  const winList = rec.five.filter((e) => e.isWin);
  const combos = winList.map((e) => `${numsText(e.numbers)}（${e.code}）`).join('；');

  return `
    <tr class="${m.wins ? 'row-hit' : ''}" data-row-idx="${idx}" data-draw-id="${escapeHtml(d.id)}">
      <td class="col-period">${d.year}-${d.period}<small>${escapeHtml(d.date)}</small></td>
      <td><div class="cell-balls">${normalBalls}</div></td>
      <td class="col-special"><div class="cell-balls">${specialBall}</div></td>
      <td class="col-hit"><div class="cell-five-hits">${perFive}</div></td>
      <td>${resultCellHtml(m.wins > 0, `5 注中 ${m.wins} 注${isSpecial ? '特码' : modeTitle(mode)}`, combos, m.net)}</td>
      <td class="col-feat"><button type="button" class="feat-btn" data-feat-toggle="${idx}">展开</button></td>
    </tr>`;
}

function featureDetailHtml(rec) {
  const cfg = betConfig();
  const mode = playMode();
  const size = targetSize(mode);
  const isSpecial = mode === 'special';
  const odds = currentOdds(mode);
  const block = (e) => {
    const hitSet = new Set(e.hitNums || []);
    const balls = e.numbers.map((n) => miniBallHtml(n, { hit: hitSet.has(n), miss: !hitSet.has(n) })).join('');
    const badge = e.isWin ? '<span class="badge hit">命中</span>' : '<span class="badge miss">未中</span>';
    const hitText = isSpecial
      ? (e.isWin ? `覆盖了开奖特码` : `没覆盖开奖特码`)
      : `命中 ${e.hitCount}/${size} 个正码${(e.hitNums || []).length ? `（${numsText(e.hitNums)}）` : ''}`;
    return `
      <div class="fd-five">
        <div class="fd-head">${e.icon} ${escapeHtml(e.code)} ${escapeHtml(e.name)} <span class="fd-nums">${balls}</span></div>
        <div class="fd-line">${badge} ${hitText} · ${e.isWin ? `返奖 ${amount(e.payout)}` : `未中奖（每注成本 ${amount(cfg.stake)}，命中返奖 ${amount(cfg.stake * odds)}）`}</div>
      </div>`;
  };
  return `
    <tr class="feat-detail"><td colspan="6">
      ${rec.five.map(block).join('')}
    </td></tr>`;
}

function renderReplayTable() {
  const body = $('histBody');
  const list = replay.filtered;
  const visible = list.slice(0, replay.visible);

  if (!list.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">${
      replay.running ? '正在计算…' : '这个范围还没有回放结果，点「▶ 重新计算」试试。'
    }</td></tr>`;
  } else {
    body.innerHTML = visible.map(replayRowHtml).join('');
    // 展开的详情行：按期号在真实 DOM 里找行。
    // 不用 CSS.escape（老 WebView / 非浏览器环境没有 globalThis.CSS，一用就抛错，详情渲染不出来），
    // 期号只有数字和横线，直接按 dataset 比对最稳。
    if (replay.expanded.size) {
      const rows = [...body.querySelectorAll('tr[data-draw-id]')];
      for (const drawId of replay.expanded) {
        const idx = list.findIndex((r) => r.draw.id === drawId);
        if (idx < 0 || idx >= visible.length) continue;
        const tr = rows.find((row) => row.dataset.drawId === drawId);
        if (!tr) continue;
        tr.insertAdjacentHTML('afterend', featureDetailHtml(list[idx]));
      }
    }
  }

  $('histCount').textContent = list.length
    ? `共 ${list.length} 期，显示 ${visible.length} 期`
    : '没有匹配的期次';
  $('btnMoreHist').style.display = list.length > visible.length ? '' : 'none';

  renderReplayMetrics();
}

/**
 * 回放指标：逐注对比 + 随机基线
 *
 * 只陈述事实：每期开奖独立，各注命中次数差异都在随机波动范围内，
 * 谁 ROI 高都是运气，不代表任何策略有优势。
 */
function renderReplayMetrics() {
  const cfg = betConfig();
  const mode = playMode();
  const size = targetSize(mode);
  const isSpecial = mode === 'special';
  const odds = currentOdds(mode);
  const baseline = directBaseline(mode);
  const summary = summarizeDailyFive(replay.filtered, {
    stake: cfg.stake,
    odds3: cfg.odds3,
    odds4: cfg.odds4,
    oddsSpecial: cfg.oddsSpecial,
    mode
  });
  const host = $('histMetrics');
  if (!host) return;

  const rows = summary.catalog.filter((c) => c.periods > 0).map((c) => `
      <tr class="${c.random ? 'is-random' : ''}">
        <td>${c.icon} ${escapeHtml(c.code)} ${escapeHtml(c.name)}</td>
        <td>${c.winPeriods} 期 · ${c.winRate}%</td>
        <td>${c.avgHits}</td>
        <td>${Math.round(c.payout).toLocaleString()}</td>
        <td>${c.roi}%</td>
      </tr>`).join('');

  host.innerHTML = `
    <div class="metric-card v-num mc-wide">
      <div class="mc-head">
        <span>${isSpecial ? '特码' : modeTitle(mode)} · ${summary.periods} 期回放</span>
        <span class="mc-label">单注 ${cfg.stake} 元 · 赔率 ${odds} 倍</span>
      </div>
      <div class="table-scroll">
        <table class="mc-table">
          <thead>
            <tr><th>注</th><th>命中</th><th>${isSpecial ? '场均覆盖' : '场均命中号码'}</th><th>累计返奖(元)</th><th>ROI</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5">暂无数据</td></tr>'}</tbody>
        </table>
      </div>
      <div class="mc-grid">
        <div><span class="mc-sm">总成本</span><b>${Math.round(summary.totalCost).toLocaleString()} 元</b></div>
        <div><span class="mc-sm">总返奖</span><b>${Math.round(summary.totalPayout).toLocaleString()} 元</b></div>
        <div><span class="mc-sm">净盈亏</span><b>${money(summary.totalNet)}</b></div>
        <div><span class="mc-sm">整体 ROI</span><b>${summary.totalRoi}%</b></div>
      </div>
      <div class="mc-sub">
        每期开奖独立：5 注只是风格不同，命中次数差异都在随机波动范围内，<b>谁 ROI 高都不代表策略有优势</b>。
      </div>
    </div>`;

  const ev = expectedReturnRate(mode, odds);
  const fair = baseline.fairOdds >= 100 ? Math.round(baseline.fairOdds) : baseline.fairOdds.toFixed(1);
  // 「至少中 1 注」按当前这一期 5 注的实际号码精确算（随机注可能与精选重复）
  const plan = getFivePlan(getPeriodContext().target);
  const anyHit = plan.coverage?.anyHit ?? baseline.hitProb;
  const distinct = plan.coverage?.distinct ?? size * 5;
  const base = $('histBaseline');
  if (base) {
    base.innerHTML = `随机基线：单注命中 <b>${formatPercent(baseline.hitProb, 4)}</b>，公平赔率 <b>${fair}</b> 倍；
      当前赔率 ${odds} 倍 → 期望回报率 <b>${formatPercent(ev, 1)}</b>。
      以当前这期 5 注的实际号码（覆盖 ${distinct} 个号、含随机注与精选的重叠）算 → 至少中 1 注 <b>${formatPercent(anyHit, 3)}</b>。
      回放只是历史统计，不能保证未来中奖，也不构成投注建议。`;
  }
}

/* ==================== 数据变更后统一刷新 ==================== */

function refreshAfterDataChange() {
  rebuildMergedDraws();
  renderHeader();
  populatePeriodSelect();
  syncHistRangeLabel();
  renderToday();
  renderSyncPanel();
  scheduleReplay();
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
  const label = state.periodKey === 'NEXT' ? '下一期' : state.periodKey;
  showToast(`已切换到 ${label}`);
}

/* ==================== 事件绑定 ==================== */

function bindEvents() {
  /* ① 今日推荐 */
  on('periodSelect', 'change', (e) => {
    state.periodKey = e.target.value;
    renderToday();
  });
  on('btnNext', 'click', () => {
    state.periodKey = 'NEXT';
    if ($('periodSelect')) $('periodSelect').value = 'NEXT';
    renderToday();
  });
  on('btnCopyAll', 'click', () => {
    const ctx = getPeriodContext();
    copyText(fiveText(getFivePlan(ctx.target)), '今日 5 注已复制');
  });
  on('btnCopyAllMobile', 'click', () => {
    const ctx = getPeriodContext();
    copyText(fiveText(getFivePlan(ctx.target)), '今日 5 注已复制');
  });
  on('modeSwitch', 'click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (!mode || mode === playMode()) return;
    state.config.playMode = mode;
    saveConfig();
    planCache.clear();
    renderToday();
    scheduleReplay();
  });
  on('btnPrevPeriod', 'click', () => stepPeriod(1));
  on('btnNextPeriod', 'click', () => stepPeriod(-1));
  on('btnRerollRandom', 'click', () => {
    state.randomSalt += 1;
    saveRandomSalt();
    renderToday();
    scheduleReplay(); // 回放里的 #1 也用的是同一个盐值，必须一起重算
    showToast(`随机注已重摇（第 ${state.randomSalt} 次）`);
  });
  on('btnResetRandom', 'click', () => {
    if (state.randomSalt === 0) { showToast('已经是默认随机'); return; }
    state.randomSalt = 0;
    saveRandomSalt();
    renderToday();
    scheduleReplay();
    showToast('已恢复默认随机');
  });
  on('fiveGrid', 'click', (e) => {
    const copyBtn = e.target.closest('[data-copy-five]');
    if (copyBtn) {
      const plan = getFivePlan(getPeriodContext().target);
      const entry = plan.five.find((x) => x.id === copyBtn.dataset.copyFive);
      if (entry) copyText(fiveCardText(entry), `${entry.code} ${entry.name} 已复制`);
      return;
    }
  });

  /* ④ 历史回放 */
  on('btnMoreHist', 'click', () => {
    replay.visible += REPLAY_PAGE;
    renderReplayTable();
  });
  // 范围下拉必须真的重算：之前这一段被误删，导致「换范围 → 点重新计算」看起来毫无反应
  on('histRange', 'change', (e) => {
    replay.filters.range = e.target.value || '120';
    runReplay();
  });
  on('btnReplayRun', 'click', () => runReplay());
  on('histBody', 'click', (e) => {
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
  ['cfgStake', 'cfgOdds3', 'cfgOdds4', 'cfgOddsSpecial'].forEach((id) => {
    on(id, 'input', () => {
      const stake = Number($('cfgStake').value);
      const odds3 = Number($('cfgOdds3').value);
      const odds4 = Number($('cfgOdds4').value);
      const oddsSpecial = Number($('cfgOddsSpecial').value);
      if (!Number.isFinite(stake) || stake <= 0) { showToast('⚠ 单注本金必须是大于 0 的数字'); renderHeader(); return; }
      if (!Number.isFinite(odds3) || odds3 <= 0 || !Number.isFinite(odds4) || odds4 <= 0
        || !Number.isFinite(oddsSpecial) || oddsSpecial <= 0) { showToast('⚠ 赔率必须是大于 0 的数字'); return; }
      state.config = { ...state.config, stake, odds3, odds4, oddsSpecial };
      saveConfig();
      renderHeader();
      renderToday();
      if (replay.records.length) renderReplayTable(); // 金额按新本金 / 赔率重算
    });
  });
  on('btnResetCfg', 'click', () => {
    state.config = { ...DEFAULT_CONFIG };
    saveConfig();
    renderHeader();
    renderToday();
    if (replay.records.length) renderReplayTable();
    showToast('已恢复默认本金与赔率');
  });
  on('btnCheckUpdate', 'click', async () => {
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
  on('btnRepairCache', 'click', () => repairCache({ message: '已清理旧缓存，正在重新载入…' }));
  on('btnResetServiceWorker', 'click', () => repairCache({ hard: true, message: '已注销 Service Worker 并清空缓存，正在重新载入…' }));
  // 「重新加载 / 修复缓存」按钮由 index.html 内联看门狗脚本兜底绑定（app.js 挂掉时也能用），
  // 这里只在没有内联兜底时补绑一次，避免重复触发。
  if (!window.__BOOT_REPAIR_BOUND__) {
    on('btnBootReload', 'click', () => location.reload());
    on('btnBootRepair', 'click', () => repairCache({ message: '已清理旧缓存，正在重新载入…' }));
  }

  /* ⑤ 数据同步 */
  on('btnSyncCheck', 'click', () => runSync({ write: false }));
  on('btnSyncNow', 'click', () => runSync({ write: true }));
  on('btnSyncFix', 'click', () => runSync({ write: false, fix: true }));

  on('btnExportDb', 'click', () => {
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

  on('btnPastePreview', 'click', () => {
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

  on('btnPasteMerge', 'click', () => {
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

  on('btnPasteDemo', 'click', () => {
    const next = getNextDrawMeta();
    $('pasteBox').value = `${next.periodNum}期(开奖时间:${next.date})\n08 猪 14 蛇 23 猴 26 蛇 31 鼠 45 狗 12 羊`;
  });

  on('btnPasteClear', 'click', () => {
    $('pasteBox').value = '';
    $('pasteMsg').textContent = '';
  });

  on('btnExportLocal', 'click', () => {
    if (!state.localDraws.length) { showToast('本机没有手动录入的开奖'); return; }
    downloadJson({
      updatedAt: new Date().toISOString(),
      build: APP_BUILD,
      totalCount: state.localDraws.length,
      draws: state.localDraws
    }, `local-draws-${state.localDraws[0]?.id || 'export'}.json`);
    showToast(`已导出 ${state.localDraws.length} 期本机开奖`);
  });

  on('fileInputLocal', 'change', async (e) => {
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

  on('btnClearLocalSync', 'click', () => {
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

  // 底库体检：坏行会列出来，但不会被自动「修好」（不猜测缺失号码）
  const auditLine = $('auditLine');
  if (auditLine) {
    const report = auditDraws(state.allDraws);
    auditLine.textContent = formatAuditSummary(report);
    auditLine.classList.toggle('is-bad', report.issueCount > 0);
    if (report.issueCount > 0) {
      auditLine.innerHTML = `${escapeHtml(formatAuditSummary(report))}<ul class="audit-list">${report.issues
        .slice(0, 6)
        .map((i) => `<li>${escapeHtml(i.id)}（${escapeHtml(i.date)}）：${escapeHtml(i.message)}</li>`)
        .join('')}</ul>`;
    }
  }
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
  const btns = ['btnSyncCheck', 'btnSyncNow', 'btnSyncFix'].map((id) => $(id)).filter(Boolean);
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
function scheduleReplay() {
  clearTimeout(replayTimer);
  replayTimer = setTimeout(() => {
    runReplay().catch((err) => {
      console.error('[replay]', err);
      $('replayStatus').textContent = `⚠ 回放计算失败：${err.message}`;
    });
  }, 120);
}

/** 本工具专属的缓存名前缀（与 sw.js 保持一致） */
const CACHE_PREFIX = 'mark6-pick3-pick4-';

/**
 * 修复缓存：清空本工具的 Cache Storage + 让 Service Worker 重新安装 + 带随机参数重载
 * 绝不触碰 localStorage（本金赔率 / 自选号码 / 本地录入的开奖都会保留）
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
  syncHistRangeLabel();
  bindEvents();
  renderToday();
  renderSyncPanel();
  renderReplayTable();
  registerServiceWorker();

  if (state.storageErrors.length) {
    showToast(`⚠ ${state.storageErrors[0]}`);
  }

  // 首屏回放计算（不阻塞首屏渲染）
  scheduleReplay();

  window.__APP_BOOTED__ = true;
}

try {
  initApp();
} catch (err) {
  console.error('[boot] 初始化失败', err);
  showBootError(`初始化失败：${err.message}`);
}
