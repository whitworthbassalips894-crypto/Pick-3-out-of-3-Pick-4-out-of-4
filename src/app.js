/**
 * 六合彩选号助手前端主控制器（特码 / 三中三 / 四中四）
 *
 * 一页流结构：① 数据同步（置顶） → ② 今日号码 → ③ 历史回放 → ④ 设置
 *
 * 三种玩法的形态：
 *  - 特码   ：一张 12 号清单，1 个号 = 1 注 → 12 注
 *  - 三中三 ：每天 5 组，每组 3 个号 = 5 注
 *  - 四中四 ：5 组，每组 4 个号 = 1 注 → 5 注
 *  - 命中口径：特码看开奖特码是否在清单里；直选看号码是否全部落在 6 个正码里（特码不计入）。
 *  - 历史回放严格「无未来函数」：第 T 期推荐只用 T 期之前的数据。
 *  - 任何异常都要给出明确提示，不能白屏，也不能永远停在「加载中…」。
 */

import {
  APP_BUILD,
  APP_VERSION_LABEL,
  DEFAULT_CONFIG,
  betsForNumbers,
  betsPerTicket,
  getColorForNumber,
  getPlayMode,
  getZodiacForNumber,
  pad2,
  stakeKeyForMode
} from './constants.js';
import { evaluateTickets } from './combinatorics.js';
import { mergeDraws, normalizeDrawRecord, parseDrawsInput } from './parser.js';
import { compareDrawSets, describeSourceLag, formatSyncSummary, rawGithubDbUrl } from './sync.js';
import { formatFiveTickets, formatSingleTicket } from './copy.js';
import {
  buildDailyFiveRecords,
  expandEntryTickets,
  generateDailyFive,
  summarizeDailyFive
} from './dailyfive.js';
import { directBaseline, expectedReturnRate, formatPercent } from './statistics.js';
import { nextPeriodMeta } from './periods.js';
import { auditDraws } from './audit.js';
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
  cursor: -1, // 「上一 / 下一命中」定位用的行号（在 filtered 里的下标）
  filters: {
    range: '100', // 30 / 100 / 365 / year:YYYY / all
    hit: 'all' // all = 全部 / hit = 只看中奖 / partial = 只看部分命中
  }
};

/** 一条回放记录是否「中奖」（任意一注中了） */
const isWinRecord = (rec) => (rec?.five || []).some((e) => (e.hitCount || 0) > 0);

/** 一条回放记录是否「部分命中」（有号码落在开奖号码里，但没中整注） */
const isPartialRecord = (rec) => (rec?.five || []).some((e) => {
  if ((e.hitCount || 0) > 0) return true;
  return (e.matchedNormalCount || 0) > 0 || (e.hitNums || []).length > 0;
});

/** 按当前筛选条件过滤回放记录 */
function applyReplayFilter(records = replay.records) {
  const hit = replay.filters.hit || 'all';
  if (hit === 'hit') return records.filter(isWinRecord);
  if (hit === 'partial') return records.filter(isPartialRecord);
  return records.slice();
}

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
 *  - special = 特码（每组 3 个号 = 3 注，1 中 1：命中 = 开奖特码等于其中某个号）
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
  // 特码 = 1 中 1（每组 3 个号）；1 / 5 是旧版写法，保留兼容
  if (x === 1 || x === '1' || x === 5 || x === '5' || x === 'special') return 'special';
  return playMode();
}

/** 当前玩法每个选项的号码个数（特码 12 / 三中三 7 / 四中四 4） */
function targetSize(mode = playMode()) {
  return getPlayMode(resolveMode(mode)).size;
}

/** 每个选项折算成几注（特码 = 号码个数；三中三 / 四中四每组 1 注） */
function targetBets(mode = playMode()) {
  return betsPerTicket(resolveMode(mode));
}

/**
 * 本期总注数
 *
 * 特码 = 一张清单（1 个号 = 1 注，清单有几个号就是几注）；
 * 三中三 / 四中四 = 5 组 × 每组 1 注。
 *
 * @param {string} [mode]
 * @param {number} [groups] 组数（特码传 1，直选传 5）
 */
function totalBets(mode = playMode(), groups = 5) {
  return targetBets(mode) * Math.max(1, Math.trunc(Number(groups) || 5));
}

/** 某张卡片的所有注单（特码 1 个号 = 1 注） */
function entryTickets(e, mode = playMode()) {
  return expandEntryTickets(e.numbers, getPlayMode(resolveMode(mode)));
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
  // 特码清单：每个号带一个小角标，标明它属于哪种选号风格（🎲 / 🔥 / 🎯 / ⚖️）
  const mark = opts.mark ? `<span class="ball-tag" title="${escapeHtml(opts.markLabel || '')}">${opts.mark}</span>` : '';
  return `<div class="lotto-ball-wrap" ${attrs}><div class="lotto-ball ${color}${size}${hit}${dim}${cons}">${pad2(n)}${pin}${mark}</div>${zodiac ? `<span class="ball-meta">${zodiac}</span>` : ''}</div>`;
}

function miniBallHtml(num, opts = {}) {
  const n = Number(num);
  // 参考站口径：红底 = 本期命中，灰底 = 未命中；特码用虚线圈区分
  const cls = ['d-num'];
  if (opts.special) cls.push('special');
  if (opts.hit) cls.push('hit');
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

/* ==================== 跨设备对齐（URL 分享参数） ==================== */

/**
 * 手机上重摇 3 次、PC 上还是第 0 次 → 两边看到不同的 🎲 号码，这是最容易吵架的一处。
 *
 * 解决办法：把「期号 + 重摇次数 + 玩法」写进网址，分享同一链接就得到同一张号码。
 *   ?p=2026-300&salt=3&m=pick3
 * 只做显示层同步，不改变任何选号算法（同一期 + 同一盐值 = 同一张号码，本来就成立）。
 */
const URL_KEYS = { period: 'p', salt: 'salt', mode: 'm' };

/**
 * 打开页面时套用网址参数（优先级高于本机存储）
 * 这样手机收到 PC 发来的链接，看到的就是同一张号码。
 */
function applyShareParams() {
  const shared = readShareParams();
  if (shared.mode) state.config.playMode = shared.mode;
  if (typeof shared.salt === 'number') state.randomSalt = shared.salt;
  if (shared.period) {
    const exists = shared.period === 'NEXT' || state.allDraws.some((d) => d.id === shared.period);
    state.periodKey = exists ? shared.period : 'NEXT';
  }
  if (shared.mode || typeof shared.salt === 'number' || shared.period) {
    saveConfig();
    saveRandomSalt();
    writeShareParams();
  }
}

/** 从当前网址读出分享参数（无参数时返回空对象） */
function readShareParams() {
  const out = {};
  try {
    const q = new URLSearchParams(window.location.search || '');
    const p = q.get(URL_KEYS.period);
    const salt = q.get(URL_KEYS.salt);
    const m = q.get(URL_KEYS.mode);
    if (p && /^(NEXT|\d{4}-\d{1,3})$/.test(p)) out.period = p;
    if (salt != null && Number.isFinite(Number(salt)) && Number(salt) >= 0) out.salt = Math.floor(Number(salt));
    if (m === 'special' || m === 'pick3' || m === 'pick4') out.mode = m;
  } catch (err) {
    console.warn('[share] 网址参数解析失败', err);
  }
  return out;
}

/**
 * 把当前状态写回网址（用 replaceState，不塞满浏览历史）
 * 这样地址栏本身就是「同一张号码」的凭证，复制给别人打开就能对上。
 */
function writeShareParams() {
  if (typeof window.history?.replaceState !== 'function') return;
  try {
    const q = new URLSearchParams(window.location.search || '');
    q.set(URL_KEYS.period, state.periodKey);
    q.set(URL_KEYS.salt, String(state.randomSalt || 0));
    q.set(URL_KEYS.mode, playMode());
    window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}${window.location.hash || ''}`);
  } catch (err) {
    console.warn('[share] 网址参数写入失败', err);
  }
}

/** 头部显示「对齐凭证」：期号 + 重摇次数 + 本机底库最新期，两边一对就知道差在哪 */
function renderShareTag() {
  const el = $('heroShare');
  if (!el) return;
  const latest = state.allDraws[0];
  const salt = state.randomSalt || 0;
  el.hidden = false;
  el.textContent = `${state.periodKey === 'NEXT' ? '下一期' : state.periodKey} · 🎲#${salt}`
    + (latest ? ` · 本机底库 ${latest.id}` : '');
  el.title = '把这个网址分享给另一台设备，就能拿到完全相同的号码（期号 + 重摇次数 + 玩法都写在网址里）';
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
  // 旧版本的自选号码；直选玩法每注只放 3 / 4 个号，这里按当前玩法收敛（其余号码保留在旧版本数据里，不再参与计算）
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

/** 生成/缓存某期的「每日 5 组」 */
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

/**
 * 下单参数
 *
 * 三种玩法都是「1 注 1 份本金」，统一用 stake（默认 10 元）。
 * @param {string} [mode]
 */
const betConfig = (mode = playMode()) => ({
  stake: currentStake(mode),
  odds3: state.config.odds3,
  odds4: state.config.odds4,
  oddsSpecial: state.config.oddsSpecial ?? DEFAULT_CONFIG.oddsSpecial
});

/** 当前玩法的单注本金（统一 stake） */
function currentStake(mode = playMode()) {
  const key = stakeKeyForMode(resolveMode(mode));
  const v = Number(state.config[key] ?? state.config.stake);
  return Number.isFinite(v) && v > 0 ? v : Number(DEFAULT_CONFIG[key] ?? DEFAULT_CONFIG.stake);
}

/** 当前玩法一张卡片折算几注（特码 12 个号 = 12 注；三中三 / 四中四每组 1 注） */
function entryBets(mode = playMode(), count = null) {
  return betsForNumbers(resolveMode(mode), count ?? targetSize(mode));
}

/* ==================== 文案（复制用） ==================== */

/**
 * 复制内容统一规范：**只有号码、每组一行、顿号分隔**，不含任何汉字、标题或多余数字。
 * 详细规则与测试见 src/copy.js。
 */

/** 今日推荐（每组一行：特码 12 号清单 / 三中三 / 四中四各 5 组） */
function fiveText(plan) {
  return formatFiveTickets(plan.five);
}

/** 单注号码（三中三 3 码 / 四中四 4 码） */
function fiveCardText(e) {
  return formatSingleTicket(e.numbers);
}

/**
 * 「更多 → 本金与赔率」里的赔率提示：如实展示期望回报率
 *
 * 特码是「1 中 1」：1 个号、命中率 1/49、公平赔率 49 倍，市面常见 48 倍（EV ≈ 97.96%）。
 * 用户把赔率填得高于 49 倍时，期望回报率会超过 100%，必须提醒核对。
 */
function renderOddsNote() {
  const el = $('cfgOddsNote');
  if (!el) return;
  const stake = Number(state.config.stake) || DEFAULT_CONFIG.stake;
  const rows = [
    { key: 'oddsSpecial', label: '特码（12 号清单 = 12 注）', mode: 'special' },
    { key: 'odds3', label: '三中三（每组 3 号 = 1 注）', mode: 'pick3' },
    { key: 'odds4', label: '四中四（每组 4 个号 = 1 注）', mode: 'pick4' }
  ];
  const parts = rows.map(({ key, label, mode }) => {
    const odds = Number(state.config[key]) || 0;
    const base = directBaseline(mode);
    const ev = expectedReturnRate(mode, odds);
    const fair = base.fairOdds;
    const flag = ev > 1 + 1e-6
      ? ' ⚠ 高于公平赔率，期望回报率会超过 100%，真实博彩有抽水，请核对赔率'
      : ev < 0.5 ? '（长期为负）' : ev > 1 - 1e-6 ? '（公平值）' : '';
    // 特码是 1 中 1：1 个号 = 1 注，公平赔率 49 倍，市面常见 48 倍
    const perTicket = base.hitProbPerTicket != null
      ? `（${mode === 'special' ? '整张清单' : '5 注至少中 1 注'} = ${formatPercent(base.hitProbPerTicket, 4)}）`
      : '';
    const marketHint = mode === 'special' ? '（1 中 1：市面常见 48 倍）' : '';
    return `${label}：${odds} 倍 → 单注命中 P = ${formatPercent(base.hitProb, 4)}${perTicket}，公平赔率约 ${fair % 1 === 0 ? fair : fair.toFixed(1)} 倍，期望回报率约 ${formatPercent(ev, 1)}${flag}${marketHint}`;
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

/* ==================== 渲染：① 今日推荐（每日 5 组） ==================== */

/** 特码清单里各风格的小图标 / 名称（与 src/dailyfive.js 的 SPECIAL_LIST_STYLES 对应） */
const STYLE_ICON = { random: '🎲', hot: '🔥', cold: '🎯', balance: '⚖️' };
const STYLE_LABEL = { random: '完全随机', hot: '热号', cold: '冷号', balance: '形态均衡' };

/** 尾数分布 → "0×2 1×1 …"（只列出现过的尾数） */
function tailText(nums) {
  const count = new Array(10).fill(0);
  for (const n of nums) count[n % 10]++;
  return count
    .map((c, t) => (c ? `${t}×${c}` : ''))
    .filter(Boolean)
    .join(' ');
}

function fiveCardHtml(e, ctx, cfg, consensusSet = new Set(), index = 1, mode = playMode()) {
  const t = ctx.target;
  const size = e.numbers.length;
  const isSpecial = mode === 'special';
  const layout = e.layout || (isSpecial ? 'list' : 'groups');
  // 「清单型」卡片：只有特码 12 号清单 —— 一整张号码，不是分组
  const isList = layout === 'list';
  const bets = isList ? entryBets(mode, size) : targetBets(mode);
  // 直选：命中 = 这一注的号码全部落在 6 个正码里
  // 特码（1 中 1）：命中 = 开奖的最后一个号码正好等于这 1 个号
  const drawNormals = ctx.draw ? ctx.draw.numbers.slice(0, 6) : [];
  const hitSet = ctx.draw
    ? new Set(isSpecial
      ? (ctx.draw.special != null && e.numbers.includes(ctx.draw.special) ? [ctx.draw.special] : [])
      : e.numbers.filter((x) => drawNormals.includes(x)))
    : null;
  // 特码清单：每个号带风格角标
  const styleMap = e.styles || {};
  const ballOpts = (n) => ({
    size: 'lg',
    date: t.date,
    hitSet,
    consensus: consensusSet.has(n),
    mark: isList ? (STYLE_ICON[styleMap[n]] || '') : '',
    markLabel: isList ? (STYLE_LABEL[styleMap[n]] || '') : ''
  });
  const balls = e.numbers.map((n) => ballHtml(n, ballOpts(n))).join('');
  const shape = e.shape || { odd: 0, even: 0, big: 0, small: 0, zone1: 0, zone2: 0, zone3: 0, red: 0, blue: 0, green: 0, sum: 0 };

  let hitHtml = '';
  if (ctx.draw) {
    // 统一展开成实际注单再结算（特码 1 个号 = 1 注）
    const tickets = entryTickets(e, mode);
    const ev = evaluateTickets(tickets, ctx.draw, {
      ...cfg,
      playMode: mode,
      targetSize: getPlayMode(mode).ticketSize || size
    });
    const winners = ev.winningTickets || [];
    const normalsHit = [...new Set((ev.details || []).flatMap((d) => d.hitNums || []))];
    let label;
    if (isSpecial) {
      label = winners.length
        ? `中 ${winners.length} 注 ✓ 返奖 ${amount(ev.payout)}`
        : `未中 · 本期特码是 ${ctx.draw.special != null ? pad2(ctx.draw.special) : '—'}`;
    } else {
      label = ev.winCount
        ? `中${size} ✓ 返奖 ${amount(ev.payout)}`
        : `未中 · 命中 ${normalsHit.length}/${size} 个正码`;
    }
    hitHtml = `
      <div class="fc-hit">
        <span class="tag ${winners.length ? 'tag-win' : 'tag-muted'}">${label}</span>
        ${isSpecial
          ? (normalsHit.length ? `<span class="tag tag-muted">命中 ${numsText(normalsHit)}</span>` : '')
          : (normalsHit.length ? `<span class="tag tag-muted">命中正码 ${numsText(normalsHit)}</span>` : '')}
      </div>`;
  }

  // 特码清单的图例：每种风格几个号（号码本身已经带角标，这里只报数量，避免重复罗列）
  const legendHtml = isList && Array.isArray(e.breakdown)
    ? `<div class="fc-legend">${e.breakdown.map((b) => (
      `<span class="legend-item${b.id === 'random' ? ' is-random' : ''}">`
      + `${b.icon} ${escapeHtml(b.name)} <b>${b.count}</b></span>`
    )).join('')}
      <span class="legend-note">每个号都是一注；🎲 为纯随机对照</span></div>`
    : '';

  return `
    <article class="five-card${e.random ? ' is-random' : ''}${isList ? ' is-list' : ''}" data-five="${escapeHtml(e.id)}">
      <header class="fc-head">
        <span class="fc-idx">${isList ? '本期清单' : `第 ${index} 组`}</span>
        <span class="fc-icon">${e.icon}</span>
        <span class="fc-name">${escapeHtml(e.name)}</span>
        ${isList ? '' : (e.random ? '<span class="tag tag-muted">随机对照</span>' : '<span class="tag tag-gold">精选</span>')}
        ${bets > 1 ? `<span class="tag tag-muted">${bets} 注</span>` : ''}
        <span class="fc-actions">
          <button type="button" class="btn btn-sm" data-copy-five="${escapeHtml(e.id)}">${isList ? '复制清单' : '复制本组'}</button>
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
          ${isList ? `<span>尾数 ${tailText(e.numbers)}</span>` : ''}
        </div>
      </div>
      ${legendHtml}
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
  const layout = plan.layout || getPlayMode(mode).layout || 'groups';
  const isList = layout === 'list';
  const bets = isList ? entryBets(mode, size) : targetBets(mode);
  const betsTotal = isList ? bets : totalBets(mode, plan.five.length);
  const cov = plan.coverage || {
    distinct: size * plan.five.length,
    perTicket: baseline.hitProbPerTicket ?? baseline.hitProb,
    perBet: baseline.hitProb,
    anyHit: 0
  };
  const groupCount = plan.five.length;

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
  renderShareTag();
  writeShareParams();
  const heroMeta = $('heroMeta');
  if (heroMeta) {
    if (isList) {
      const list = plan.five[0] || {};
      const st = list.shape || {};
      const randomN = (list.breakdown || []).find((b) => b.id === 'random');
      heroMeta.textContent = `本机清单 ${betsTotal} 注：` +
        `奇偶 ${st.odd ?? 0}:${st.even ?? 0} · 大小 ${st.big ?? 0}:${st.small ?? 0} · ` +
        `三区 ${st.zone1 ?? 0}-${st.zone2 ?? 0}-${st.zone3 ?? 0}` +
        (randomN && randomN.numbers.length ? ` · 其中 🎲 ${randomN.numbers.length} 个为纯随机对照` : '');
    } else {
      heroMeta.textContent = cov.overlap > 0
        ? `${groupCount} 组合计覆盖 ${cov.distinct} 个号 · 共 ${betsTotal} 注（随机组与精选重复 ${cov.overlap} 个）`
        : `${groupCount} 组合计覆盖 ${cov.distinct} 个号 · 共 ${betsTotal} 注`;
    }
  }
  const resetBtn = $('btnResetRandom');
  if (resetBtn) resetBtn.disabled = state.randomSalt === 0;

  const grid = $('fiveGrid');
  if (grid) {
    grid.innerHTML = plan.five.map((e, i) => fiveCardHtml(e, ctx, cfg, new Set(), i + 1, mode)).join('');
  }

  const box = $('heroResult');
  if (box) {
    if (!ctx.draw) {
      box.innerHTML = '';
    } else {
      // 每张卡片按实际注单结算：特码 12 注 / 三中三 1 注 / 四中四 1 注
      const perFive = plan.five.map((e) => {
        const tickets = entryTickets(e, mode);
        const ev = evaluateTickets(tickets, ctx.draw, {
          ...cfg,
          playMode: mode,
          targetSize: getPlayMode(mode).ticketSize || size
        });
        return { e, d: { winCount: ev.winCount || 0, payout: ev.payout || 0, bets: tickets.length } };
      });
      const wins = perFive.reduce((a, p) => a + p.d.winCount, 0);
      const cost = betsTotal * cfg.stake;
      const net = perFive.reduce((a, p) => a + p.d.payout, 0) - cost;
      box.innerHTML = `
        <div class="result-strip${wins ? ' win' : ''}">
          <div class="result-label">本期开奖 · ${modeTitle(mode)} ${betsTotal} 注中 ${wins} 注</div>
          <div class="ball-row">${drawBallsHtml(ctx.draw, { size: 'sm', hitSet: new Set(plan.five.flatMap((e) => e.numbers)) })}</div>
          <div class="kpi-inline">
            <div class="kpi-chip"><div class="k-label">命中注数</div><div class="k-value ${wins ? 'positive' : ''}">${wins} / ${betsTotal}</div></div>
            <div class="kpi-chip"><div class="k-label">本期净收益</div><div class="k-value ${net >= 0 ? 'positive' : 'negative'}">${money(net)}</div></div>
            <div class="kpi-chip"><div class="k-label">${isList ? '清单命中' : '逐组'}</div><div class="k-value gold">${isList
        ? `${wins}/${betsTotal} 注`
        : perFive.map((p) => `${p.e.code} ${p.d.winCount ? '✓' : '—'}`).join(' · ')}</div></div>
          </div>
        </div>`;
    }
  }

  const ev = expectedReturnRate(mode, odds);
  const fair = baseline.fairOdds >= 100 ? Math.round(baseline.fairOdds) : baseline.fairOdds.toFixed(1);
  const costLine = $('featuredCostLine');
  if (costLine) {
    const perTicketText = isSpecial
      ? `单注（1 个号）命中 ${formatPercent(cov.perBet ?? 1 / 49, 4)} · 整张清单 ${size} 个号命中 ${formatPercent(cov.perTicket, 4)}`
      : `单注命中 ${formatPercent(cov.perTicket, 4)}`;
    costLine.innerHTML = [
      `单注 ${cfg.stake} 元 × ${betsTotal} 注 = ${amount(betsTotal * cfg.stake)}`,
      `${perTicketText}（公平赔率 ${fair} 倍）`,
      `当前赔率 ${odds} 倍 → 回报率 <b>${formatPercent(ev, 1)}</b>`,
      `${betsTotal} 注至少中 1 注 <b>${formatPercent(cov.anyHit, 3)}</b>`
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
  const host = $('histRangeTabs');
  if (host) {
    const total = state.allDraws.length;
    const all = host.querySelector('.tab[data-range="all"]');
    if (all) all.textContent = `全部 · ${total}`;
    // 年份标签带上期数（与参考站一致：2026 年 · 282 期），没有数据的年份直接隐藏
    const byYear = new Map();
    for (const d of state.allDraws) byYear.set(Number(d.year), (byYear.get(Number(d.year)) || 0) + 1);
    host.querySelectorAll('.tab[data-range^="year:"]').forEach((btn) => {
      const year = Number(btn.dataset.range.slice(5));
      const n = byYear.get(year) || 0;
      btn.textContent = n ? `${year} 年 · ${n}` : `${year} 年`;
      btn.hidden = n === 0;
      // 当前选中的年份没数据了（换了底库），退回「近 100 期」
      if (!n && String(replay.filters.range) === btn.dataset.range) replay.filters.range = '100';
    });
  }
  markRangeTab();
}

/** 依据「范围」筛出需要回放的期次 */
function replayTargets() {
  const f = replay.filters;
  let list = state.allDraws;
  if (String(f.range).startsWith('year:')) {
    const year = Number(String(f.range).slice(5));
    list = list.filter((d) => Number(d.year) === year);
  } else if (f.range !== 'all') {
    const n = Math.max(1, Number(f.range) || 0);
    list = list.slice(0, n);
  }
  return list;
}

/** 高亮当前选中的范围标签 */
function markRangeTab() {
  const host = $('histRangeTabs');
  if (!host) return;
  host.querySelectorAll('.tab[data-range]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === String(replay.filters.range));
  });
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
  replay.filtered = applyReplayFilter(records);
  replay.visible = REPLAY_PAGE;
  replay.cursor = -1;
  replay.running = false;
  const cost = ((Date.now() - started) / 1000).toFixed(1);
  const winCount = records.filter(isWinRecord).length;
  const filterText = replay.filters.hit === 'hit'
    ? `，其中中奖 ${winCount} 期`
    : replay.filters.hit === 'partial'
      ? `，筛选后 ${replay.filtered.length} 期有命中号码`
      : '';
  if (status) status.textContent = `✓ 已回放 ${records.length} 期（耗时 ${cost}s，无未来函数${filterText}）。`;
  renderReplayTable();
}

/**
 * 单期收益
 *
 * 特码：每个号 = 1 注，中 k 个号返 k 份（成本按号码个数算）
 * 直选：整组 = 1 注，中了返 1 份
 */
function periodMoney(rec) {
  const mode = playMode();
  const cfg = betConfig(mode);
  const size = targetSize(mode);
  const bets = targetBets(mode);
  const odds = currentOdds(mode);
  let wins = 0;
  let cost = 0;
  let payout = 0;
  for (const e of rec.five) {
    // 每种玩法的「中奖注数」就是 hitCount（特码 = 中了的号码数、直选 = 命中的组数）
    wins += e.hitCount || 0;
    // 注数优先用记录里的实际值（特码 12 / 直选 1）
    const betsThis = Number.isFinite(e.bets) && e.bets > 0 ? e.bets : (e.numbers.length === size ? bets : e.numbers.length);
    cost += cfg.stake * betsThis;
    payout += e.payout || 0;
  }
  return {
    size,
    bets,
    wins,
    cost,
    payout,
    net: payout - cost,
    odds
  };
}

/** 当期奖金（参考站口径：没有命中也显示 ¥0，有命中标红） */
function prizeCellHtml(payout, idx) {
  const v = Math.round(Number(payout) || 0);
  const cls = v > 0 ? 'prize-tot win' : 'prize-tot';
  return `<span class="${cls}">${v > 0 ? `¥${v.toLocaleString('zh-CN')}` : '¥0'}</span>
    <button type="button" class="tk-pill fold" data-feat-toggle="${idx}" title="展开当期逐注明细">▾</button>`;
}

function replayRowHtml(rec, idx) {
  const d = rec.draw;
  const mode = playMode();
  const size = targetSize(mode);
  const isSpecial = mode === 'special';

  // 当期 6 正码：本期命中过的号码标红（特码玩法里正码不参与命中，只有特码标红）
  const anyHit = new Set(rec.five.flatMap((e) => e.hitNums || []));
  const normalBalls = d.numbers
    .map((n) => miniBallHtml(n, { hit: !isSpecial && anyHit.has(n) }))
    .join('');
  const specialBall = d.special != null
    ? `<span class="d-sep"></span>${miniBallHtml(d.special, {
      special: true,
      specialCounts: isSpecial,
      hit: isSpecial && anyHit.has(d.special)
    })}`
    : '';

  // 逐注命中胶囊：中了的标红，没中的灰；特码是「中了几个号 / 共几注」
  const pills = rec.five.map((e) => {
    const betsThis = Number.isFinite(e.bets) && e.bets > 0 ? e.bets : e.numbers.length;
    const wins = Number(e.hitCount) || 0;
    // 特码：中了几注 / 共几注；直选：这组 3~4 个号里命中了几个（与「场均命中码数」同口径）
    const text = isSpecial
      ? `${e.code} ${wins}/${betsThis}`
      : `${e.code} ${Number(e.matchedNormalCount) || 0}/${size}`;
    const cls = wins > 0 ? 'tk-pill win' : 'tk-pill';
    const title = isSpecial
      ? (wins > 0 ? `${e.name} 覆盖了特码（中 ${wins} 注）` : `${e.name} 没覆盖特码`)
      : (betsThis > 1
        ? `${e.name}：${betsThis} 注中 ${wins} 注`
        : (e.isWin ? `${e.name} 命中 ${size} 个正码` : `${e.name} 命中 ${e.matchedNormalCount ?? 0}/${size} 个正码`));
    return `<span class="${cls}" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
  }).join('');

  const m = periodMoney(rec);

  return `
    <tr class="main-row ${m.wins ? 'row-win' : ''}" data-row-idx="${idx}" data-draw-id="${escapeHtml(d.id)}">
      <td class="col-period">${d.year}-${d.period}<small>${escapeHtml(d.date)}</small></td>
      <td class="col-draw"><div class="draw-balls">${normalBalls}${specialBall}</div></td>
      <td class="col-hits"><div class="tk-pills">${pills}</div></td>
      <td class="col-prize">${prizeCellHtml(m.payout, idx)}</td>
    </tr>`;
}

function featureDetailHtml(rec) {
  const mode = playMode();
  const cfg = betConfig(mode);
  const size = targetSize(mode);
  const isSpecial = mode === 'special';
  const odds = currentOdds(mode);
  const block = (e) => {
    const hitSet = new Set(e.hitNums || []);
    const balls = e.numbers.map((n) => miniBallHtml(n, { hit: hitSet.has(n), miss: !hitSet.has(n) })).join('');
    const betsThis = Number.isFinite(e.bets) && e.bets > 0 ? e.bets : e.numbers.length;
    const badge = e.hitCount > 0 ? '<span class="badge hit">命中</span>' : '<span class="badge miss">未中</span>';
    const specialNum = rec.draw?.special != null ? pad2(rec.draw.special) : '—';
    const hitText = isSpecial
      ? (e.isWin ? `中 ${e.hitCount} 注（特码 ${numsText(e.hitNums)}）` : `0 注 · 本期特码 ${specialNum} 不在这张清单里`)
      : (betsThis > 1
        ? `共 ${betsThis} 注，中 ${e.hitCount || 0} 注（${e.numbers.length} 个号里命中正码 ${e.matchedNormalCount ?? 0} 个）`
        : `命中 ${e.matchedNormalCount ?? 0}/${size} 个正码${(e.hitNums || []).length ? `（${numsText(e.hitNums)}）` : ''}`);
    return `
      <div class="fd-five">
        <div class="fd-head">${e.icon} ${escapeHtml(e.code)} ${escapeHtml(e.name)} <span class="fd-nums">${balls}</span></div>
        <div class="fd-line">${badge} ${hitText} · ${e.isWin ? `返奖 ${amount(e.payout)}` : `未中奖（成本 ${amount(cfg.stake * (Number.isFinite(e.bets) && e.bets > 0 ? e.bets : targetBets(mode)))}，每中 1 注返 ${amount(cfg.stake * odds)}）`}</div>
      </div>`;
  };
  return `
    <tr class="feat-detail"><td colspan="4">
      ${rec.five.map(block).join('')}
    </td></tr>`;
}

function renderReplayTable() {
  const body = $('histBody');
  const list = replay.filtered;
  const visible = list.slice(0, replay.visible);

  if (!list.length) {
    const emptyText = replay.running
      ? '正在计算…'
      : replay.filters.hit === 'hit'
        ? '这个范围里一期都没中奖 —— 换「全部期次」或缩短范围再看看。'
        : replay.filters.hit === 'partial'
          ? '这个范围里没有命中的号码。'
          : '这个范围还没有回放结果，点「▶ 重新计算」试试。';
    body.innerHTML = `<tr class="empty-row"><td colspan="6">${emptyText}</td></tr>`;
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

  const totalRecords = replay.records.length;
  const filteredNote = list.length !== totalRecords && totalRecords
    ? `（已筛选，占全部 ${totalRecords} 期）`
    : '';
  $('histCount').textContent = list.length
    ? `共 ${list.length} 期${filteredNote}，显示 ${visible.length} 期`
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
/**
 * 回放指标（参考 lottery-tool 版式）
 *
 * 左边一张「有奖期占比」，右边每注一张小卡：场均命中 / 中奖期数 / 当期最高 / 累计返奖。
 * 只陈述事实：每期开奖独立，各注之间的差异都在随机波动范围内。
 */
function renderReplayMetrics() {
  const mode = playMode();
  const cfg = betConfig(mode);
  const size = targetSize(mode);
  const isSpecial = mode === 'special';
  const odds = currentOdds(mode);
  const baseline = directBaseline(mode);
  const records = replay.filtered;
  const host = $('histMetrics');
  if (!host) return;

  // —— 逐期汇总（与表格同源，避免两处数字对不上）——
  let winPeriods = 0;
  let payoutSum = 0;
  let costSum = 0;
  let maxPayout = 0;
  for (const rec of records) {
    const m = periodMoney(rec);
    if (m.wins > 0) winPeriods++;
    payoutSum += m.payout;
    costSum += m.cost;
    if (m.payout > maxPayout) maxPayout = m.payout;
  }
  const periods = records.length;
  const winRate = periods ? (winPeriods / periods) * 100 : 0;
  const backRate = costSum > 0 ? (payoutSum / costSum) * 100 : 0;

  // —— 逐注汇总 ——
  const agg = new Map();
  for (const rec of records) {
    for (const e of rec.five) {
      let a = agg.get(e.id);
      if (!a) {
        a = { id: e.id, code: e.code, name: e.name, icon: e.icon, random: !!e.random, periods: 0, match: 0, wins: 0, best: 0, payout: 0 };
        agg.set(e.id, a);
      }
      a.periods++;
      // 命中口径：特码 = 中了几注；直选 = 命中的正码个数
      const matchThis = isSpecial ? (Number(e.hitCount) || 0) : (Number(e.matchedNormalCount) || 0);
      a.match += matchThis;
      if ((Number(e.hitCount) || 0) > 0) a.wins++;
      if (matchThis > a.best) a.best = matchThis;
      a.payout += Number(e.payout) || 0;
    }
  }
  const cards = [...agg.values()].map((a) => {
    const avg = a.periods ? (a.match / a.periods) : 0;
    const unit = isSpecial ? '注' : '码';
    const cls = ['sc-box'];
    if (a.random) cls.push('is-random');
    return `
      <div class="${cls.join(' ')}">
        <span class="sc-name">${a.icon} ${escapeHtml(a.code)} ${escapeHtml(a.name)}</span>
        <span class="sc-hit">${avg.toFixed(2)} ${unit}</span>
        <small>中奖 ${a.wins} 期 · 最高 ${a.best}</small>
        <span class="sc-sum">累计 ¥${Math.round(a.payout).toLocaleString('zh-CN')}</span>
      </div>`;
  }).join('');

  const unit = isSpecial ? '注' : '码';
  host.innerHTML = `
    <div class="metric-card v-prize">
      <div class="mc-head">${isSpecial ? '特码' : modeTitle(mode)} · 有奖期占比</div>
      <div>
        <span class="mc-val">${winRate.toFixed(1)}%</span>
        <span class="mc-label">${winPeriods} / ${periods} 期有奖</span>
      </div>
      <div class="mc-bar"><div class="mc-fill" style="width:${Math.min(100, winRate).toFixed(1)}%"></div></div>
      <div class="mc-kv">
        <div><span class="mc-sm">累计返奖</span><b>¥${Math.round(payoutSum).toLocaleString('zh-CN')}</b></div>
        <div><span class="mc-sm">投入</span><b>¥${Math.round(costSum).toLocaleString('zh-CN')}</b></div>
        <div><span class="mc-sm">返奖比</span><b>${backRate.toFixed(1)}%</b></div>
        <div><span class="mc-sm">单期最高</span><b>¥${Math.round(maxPayout).toLocaleString('zh-CN')}</b></div>
      </div>
      <div class="mc-sub">单注 ${cfg.stake} 元${targetBets(mode) > 1 ? ` · 每期 ${targetBets(mode)} 注` : ' · 每组 1 注'} · 赔率 ${odds} 倍</div>
    </div>
    <div class="strat-compare">${cards || '<div class="sc-box">暂无数据</div>'}</div>`;

  // —— 口径说明（一句话，不再堆长段落）——
  const ev = expectedReturnRate(mode, odds);
  const fair = baseline.fairOdds >= 100 ? Math.round(baseline.fairOdds) : baseline.fairOdds.toFixed(1);
  const plan = getFivePlan(getPeriodContext().target);
  const anyHit = plan.coverage?.anyHit ?? baseline.hitProb;
  const distinct = plan.coverage?.distinct ?? size * plan.five.length;
  const betsNow = plan.coverage?.totalBets ?? (isSpecial ? size : targetBets(mode) * plan.five.length);
  const base = $('histBaseline');
  if (base) {
    base.innerHTML = `随机理论期望：每期 <b>${baseline.expectedHits.toFixed(2)} ${unit}</b>
      · 公平赔率 <b>${fair}</b> 倍，当前 ${odds} 倍 → 期望回报率 <b>${formatPercent(ev, 1)}</b>
      · 当前这期覆盖 ${distinct} 个号 ${betsNow} 注，至少中 1 注 <b>${formatPercent(anyHit, 3)}</b>。
      回放只做历史统计，各注差异都在随机波动内，不构成投注建议。`;
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
    copyText(fiveText(getFivePlan(ctx.target)), `${modeTitle(playMode())}号码已复制`);
  });
  on('btnCopyAllMobile', 'click', () => {
    const ctx = getPeriodContext();
    copyText(fiveText(getFivePlan(ctx.target)), `${modeTitle(playMode())}号码已复制`);
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
    showToast(`🎲 随机号已重摇（第 ${state.randomSalt} 次）`);
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
  // 范围标签：点了就重算（之前下拉被误删事件，导致「换范围」毫无反应）
  on('histRangeTabs', 'click', (e) => {
    const btn = e.target.closest('.tab[data-range]');
    if (!btn) return;
    replay.filters.range = btn.dataset.range || 'all';
    markRangeTab();
    runReplay();
  });
  on('btnReplayRun', 'click', () => runReplay());
  // 点一下「对齐凭证」= 复制当前链接（发给另一台设备，号码完全一致）
  on('heroShare', 'click', () => {
    copyText(window.location.href, '链接已复制 · 另一台设备打开就是同一张号码');
  });
  on('histFilter', 'change', (e) => {
    replay.filters.hit = e.target.value || 'all';
    replay.cursor = -1;
    replay.visible = REPLAY_PAGE;
    replay.filtered = applyReplayFilter();
    renderReplayTable();
  });
  // 「第 N 个命中（方向 -1 = 更早 / +1 = 更新）」——找不到就提示，不静默
  const jumpHit = (dir) => {
    const list = replay.filtered;
    if (!list.length) { showToast(replay.records.length ? '当前筛选下没有期次' : '请先点「▶ 重新计算」'); return; }
    let idx = replay.cursor;
    if (idx < 0 || idx >= list.length) idx = dir > 0 ? -1 : list.length;
    for (let i = idx + dir; i >= 0 && i < list.length; i += dir) {
      if (isWinRecord(list[i])) {
        replay.cursor = i;
        // 目标行没渲染出来就先加载更多
        if (i >= replay.visible) replay.visible = Math.min(list.length, i + REPLAY_PAGE);
        replay.expanded.add(list[i].draw.id);
        renderReplayTable();
        const tr = [...$('histBody').querySelectorAll('tr[data-draw-id]')].find((row) => row.dataset.drawId === list[i].draw.id);
        if (tr) {
          // 老 WebView 没有 scrollIntoView 时不能整段崩掉，高亮才是关键
          if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
          tr.classList.add('row-flash');
          setTimeout(() => tr.classList.remove('row-flash'), 1600);
        }
        return;
      }
    }
    // 这一侧没有命中：反向再找一次，仍没有就提示
    for (let i = dir > 0 ? list.length - 1 : 0; i >= 0 && i < list.length; i -= dir) {
      if (isWinRecord(list[i])) {
        replay.cursor = i;
        if (i >= replay.visible) replay.visible = Math.min(list.length, i + REPLAY_PAGE);
        replay.expanded.add(list[i].draw.id);
        renderReplayTable();
        showToast(dir > 0 ? '这已经是最新的一个命中了，已跳到最早的一个' : '这已经是最早的一个命中了，已跳到最新的一个');
        return;
      }
    }
    showToast('这个范围里没有中奖期');
  };
  on('btnPrevHit', 'click', () => jumpHit(-1));
  on('btnNextHit', 'click', () => jumpHit(1));
  on('histBody', 'click', (e) => {
    // 点整行 / 点 ▾ 都能展开（参考站交互）；点详情行内部不处理
    const tr = e.target.closest('tr[data-draw-id]');
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
/** 本地时区的今天（YYYY-MM-DD）。不能用 toISOString：北京时间 00:00–08:00 会算成昨天 */
function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

/** 拉一次 JSON（带 _r 参数绕过 Service Worker 的数据缓存；用绝对地址兼容子目录部署） */
async function fetchDbJson(url, timeoutMs = 8000) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const draws = (Array.isArray(data.draws) ? data.draws : []).map(normalizeDrawRecord).filter(Boolean);
    if (!draws.length) throw new Error('数据源里没有可用的开奖记录');
    return { data, draws };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 读取仓库数据源
 *
 * 两级来源：
 *  1. 本站的 ./data/draws.json（GitHub Pages 静态文件）
 *  2. 落后时再问一次 raw.githubusercontent.com 上的同名文件
 *
 * 为什么需要第 2 级：Pages 每次提交后要重新构建（30~90 秒，偶尔更久），
 * 这段时间页面读到的还是旧底库，用户看到的就是「明明同步了却没更新」。
 * 原始文件不经过 Pages 构建，提交后几秒就生效。第 2 级失败不影响主流程。
 */
async function fetchSourceDb() {
  const localUrl = new URL(`./data/draws.json?_r=${Date.now()}`, window.location.href).toString();
  let result = await fetchDbJson(localUrl);
  let via = 'pages';

  const expected = todayIso();
  const localLag = describeSourceLag(result.draws[0], expected);
  if (localLag.ok && localLag.stale) {
    const mirror = rawGithubDbUrl(window.location.href);
    if (mirror) {
      try {
        const fresh = await fetchDbJson(`${mirror}?t=${Date.now()}`, 6000);
        if (describeSourceLag(fresh.draws[0], expected).lagPeriods < localLag.lagPeriods) {
          result = fresh;
          via = 'raw';
        }
      } catch (err) {
        console.info('[sync] 原始文件兜底源不可用，继续用本站静态文件', err.message);
      }
    }
  }

  syncState.remote = result.draws;
  syncState.meta = {
    updatedAt: result.data.updatedAt || '',
    latestId: result.data.latestId || result.draws[0].id,
    totalCount: result.data.totalCount ?? result.draws.length,
    source: result.data.source || '',
    via
  };
  return result.draws;
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
  // 新鲜度：仓库文件靠 GitHub Actions 更新，这里如实显示落后几期
  const lag = describeSourceLag(localLatest, todayIso());
  grid.innerHTML = [
    cell('本地最后一期', localLatest ? localLatest.id : '—'),
    cell('数据源最新一期', syncState.meta ? syncState.meta.latestId : '未读取'),
    cell('数据源更新时间', (syncState.meta ? formatStamp(syncState.meta.updatedAt) : '—')
      + (syncState.meta?.via === 'raw' ? '（取自仓库原始文件，Pages 尚在构建）' : '')),
    cell('本机新鲜度', lag.ok ? (lag.stale ? `落后 ${lag.lagPeriods} 期` : '已是最新') : '—',
      lag.ok ? (lag.stale ? 'is-warn' : 'is-good') : ''),
    cell('本次可追加', r ? `${r.missingCount} 期` : '—', r && r.missingCount > 0 ? 'is-good' : ''),
    cell('冲突 / 缺口', r ? `${r.conflictCount} / ${r.gapCount}` : '—', r && (r.conflictCount || r.gapCount) ? 'is-warn' : '')
  ].join('');
  const cnt = $('localCountSync');
  if (cnt) cnt.textContent = String(state.localDraws.length);

  // 底库体检：坏行会列出来，但不会被自动「修好」（不猜测缺失号码）
  // 底库体检：正常时只留一句「全部可用」，有坏行时一句结论 + 折叠明细。
  // 以前把「1761 期可统计 / 1 处错误 / 不猜测补全」整段常驻在页面上，属于噪音。
  const auditLine = $('auditLine');
  if (auditLine) {
    const report = auditDraws(state.allDraws);
    // 2022-132 是底库里一条永久性的坏行，天天挂着一句「1 期异常」纯属噪音：
    // 默认不显示，用户点了检查 / 同步才显示（要看的时候一定看得到）。
    auditLine.hidden = !syncState.revealAudit;
    if (!syncState.revealAudit) { auditLine.innerHTML = ''; } else {
    auditLine.classList.toggle('is-bad', report.issueCount > 0);
    if (report.issueCount > 0) {
      auditLine.innerHTML = `⚠ ${report.issueCount} 期数据异常，已从统计中排除（不影响其他期）`
        + `<details class="audit-more"><summary>看是哪一期</summary><ul class="audit-list">${report.issues
          .slice(0, 6)
          .map((i) => `<li>${escapeHtml(i.id)}（${escapeHtml(i.date)}）：${escapeHtml(i.message)}</li>`)
          .join('')}</ul></details>`;
    } else {
      auditLine.innerHTML = `<span class="audit-ok">✓ 底库 ${report.usable} 期全部可用于统计</span>`;
    }
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
 *
 * ⚠ 现实情况：上游是 https 的非标准端口 2025、证书链不完整，浏览器必然失败
 *   （证书错误 / CORS / 混合内容），所以这里只可能拿到失败原因。
 *   真正的抓取放在 GitHub Actions 里跑（.github/workflows/sync-draws.yml）。
 *
 * @returns {Promise<{ html: string, reason: string, attempts: string[] }>}
 *   html：抓到且看起来像开奖页时返回页面文本，否则空串
 *   reason：一句话失败原因（用于页面展示，不再笼统说「被 CORS 拦下」）
 *   attempts：每个候选地址的实际错误，便于排查
 */
async function fetchRemoteSourceHtml(timeoutMs = 5000) {
  const attempts = [];
  for (const u of REMOTE_CANDIDATES) {
    const short = u.length > 60 ? `${u.slice(0, 57)}…` : u;
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(new URL(u, window.location.href).toString(), { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) {
        attempts.push(`${short} → HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (text?.includes('期(开奖时间:')) return { html: text, reason: '', attempts };
      attempts.push(`${short} → 页面里找不到开奖记录（站点结构可能变了）`);
    } catch (err) {
      const msg = err?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (err?.message || '网络错误');
      attempts.push(`${short} → ${msg}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    html: '',
    reason: attempts.length ? '浏览器直连上游全部失败（上游为非标准端口 + 证书问题，只能由服务器端抓取）' : '未配置远程源',
    attempts
  };
}

/**
 * 打开页面时自动检查一次底库新鲜度
 *
 * 只做「读仓库文件 + 比对」，不写入任何数据（等价于点一下「仅检查」）。
 * 失败静默处理：页面照常用内置底库，不弹错误打扰用户。
 */
async function autoCheckSyncQuietly() {
  if (window.__SKIP_AUTO_SYNC__) return; // 测试钩子：jsdom 里不真的发网络请求
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    await runSync({ write: false, silent: true });
  } catch (err) {
    console.warn('[sync] 自动检查失败（不影响使用）', err);
  }
}

/**
 * 同步主流程：读取数据源 → 比对 → （可选）写入本机
 * 写入只落在 localStorage，内置底库不会被改动。
 */
async function runSync({ write = false, fix = false, silent = false } = {}) {
  if (syncState.busy) return;
  syncState.busy = true;
  // 只要不是「进页面自检」，就把底库体检结论显示出来（默认藏起来，避免天天挂着）
  if (!silent) { syncState.revealAudit = true; renderSyncPanel(); }
  const status = $('syncStatus');
  const btns = ['btnSyncCheck', 'btnSyncNow', 'btnSyncFix'].map((id) => $(id)).filter(Boolean);
  btns.forEach((b) => { b.disabled = true; });
  status.textContent = '正在读取仓库数据源 ./data/draws.json …（如果本站那份还落后，会自动再问一次仓库原始文件）';
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
      const lagNow = describeSourceLag(state.allDraws[0], todayIso());
      // 仓库里已经有新期次 → 是本机落后，点「一键同步」就能补上；
      // 仓库里也没有 → 才是仓库文件/自动任务的问题。
      if (r.appendable.length) {
        status.textContent = `仓库里已有 ${r.appendable.length} 期新开奖，点「一键同步」补齐本机。`;
      } else if (silent) {
        // 进页面时的静默自检：只留一句，别把「检查完成（未写入任何数据）」这种过程话挂在首屏
        const latest = state.allDraws[0];
        status.textContent = `底库最新 ${latest?.id || '—'}${latest?.date ? `（${latest.date}）` : ''}`
          + ` · 今天 ${lagNow.expectedId} ${lagNow.lagPeriods === 0 ? '已入库' : '未开奖（通常 21:40 后公布）'}`;
      } else {
        status.textContent = `没有可追加的期次。${lagNow.message}`;
      }
      showToast(r.appendable.length
        ? `可补 ${r.appendable.length} 期，点「一键同步」`
        : (lagNow.stale ? `仓库底库落后 ${lagNow.lagPeriods} 期` : '检查完成'));
      return;
    }

    if (r.appendable.length) {
      state.localDraws = mergeDraws(state.localDraws, r.appendable).merged;
      saveLocalDraws();
      refreshAfterDataChange();
      syncState.last = compareDrawSets(state.allDraws, syncState.remote);
      renderSyncPanel();
      const ids = r.appendable.map((d) => d.id);
      const lagAfter = describeSourceLag(state.allDraws[0], todayIso());
      status.textContent = `✓ 已把 ${r.appendable.length} 期（${ids[0]} ~ ${ids[ids.length - 1]}）追加写入本机，现在共 ${state.allDraws.length} 期；内置底库未改动。${lagAfter.message}`;
      showToast(`已同步 ${r.appendable.length} 期`);
      return;
    }

    // 仓库数据源没有更新 → 再试一次远程开奖源（浏览器基本会失败，但要如实报原因）
    const lag = describeSourceLag(state.allDraws[0], todayIso());
    status.textContent = `${lag.base}。仓库文件没有新期次，正在尝试直连上游…`;
    const remote = await fetchRemoteSourceHtml();
    if (!remote.html) {
      // 浏览器直连上游基本永远失败（非标端口 + 坏证书 + CORS），这是预期行为。
      // 以前把 3 条失败原因原样铺在页面上，属于噪音 —— 收进折叠里，真要看再展开。
      status.innerHTML = `仓库文件暂无新期次。${escapeHtml(lag.message)}`
        + `<details class="audit-more"><summary>为什么浏览器抓不到上游</summary>`
        + `<ul class="audit-list"><li>${escapeHtml(remote.reason)}</li>`
        + remote.attempts.map((a) => `<li>${escapeHtml(a)}</li>`).join('')
        + '</ul></details>';
      showToast(lag.ok && lag.stale ? `底库落后 ${lag.lagPeriods} 期` : '已是最新，无需同步');
      return;
    }
    const parsed = parseDrawsInput(remote.html);
    const r2 = compareDrawSets(state.allDraws, parsed);
    if (!r2.appendable.length) {
      status.textContent = `同步完成：仓库数据源与上游都没有更新的期次（上游最新 ${r2.remoteLatest?.id || '未知'}）。${lag.message}`;
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
    status.textContent = `读取仓库数据源 ./data/draws.json 失败：${err.message}。`
      + '可能原因：仓库文件未部署 / 网络或离线缓存异常。可先用下方「粘贴导入」临时补期。';
    if (!silent) showToast('读取数据源失败');
    (silent ? console.info : console.warn)('[sync]', err.message);
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
  applyShareParams();
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

  // 自动跑一次「仅检查」：不用手动点也知道本机底库落后几期
  // （只读 ./data/draws.json，绝不写入任何数据；失败也只是提示，不影响页面）
  autoCheckSyncQuietly();

  window.__APP_BOOTED__ = true;
}

try {
  initApp();
} catch (err) {
  console.error('[boot] 初始化失败', err);
  showBootError(`初始化失败：${err.message}`);
}
