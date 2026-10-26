/**
 * 「每日 5 注」直选引擎：1 注纯随机基线 + 4 注精选
 *
 * 模式参考 https://whitworthbassalips894-crypto.github.io/lottery-tool/ ：
 *   #1 🎲 随机基线   —— 按目标期号定种机选，纯随机对照，可重摇
 *   #2 🔥 热势恒强   —— EMA 短中周期活跃热码 + 上期重号 + 斜连邻号动量
 *   #3 🎯 遗漏回补   —— 个人历史遗漏 80%–98% 临界区 + 热码短休回补窗
 *   #4 🔗 关联共振   —— 近 180 期条件转移升幅 + 同尾/两连号高频共现协同
 *   #5 ⚖️ 均衡配额   —— 贝叶斯频率 + 三区/波色/奇偶配额 + 等隔韵律 + 跨注去重
 *
 * 玩法口径（直选）：
 *   size = 3 → 三中三：每注 3 个号码，3 个号全部落在 6 个正码里才算中；
 *   size = 4 → 四中四：每注 4 个号码，4 个号全部落在 6 个正码里才算中。
 *
 * 严格无未来函数：第 T 期的 5 注只用严格早于 T 期的正码数据。
 * 确定性：同一期（同一重摇盐值、同一 size）永远得到同一组 5 注。
 */

import { ALL_NUMBERS, PLAY_MODES, getColorForNumber, getPlayMode, getZodiacForNumber } from './constants.js';
import { evaluateTickets, normalizeNumbers } from './combinatorics.js';
import { getPriorDraws, selectDirectNumbers } from './strategy.js';

/** 5 注目录：第 1 注为纯随机基线，后 4 注为精选 */
export const DAILY_FIVE_CATALOG = [
  {
    id: 'random',
    code: '#1',
    name: '随机基线',
    icon: '🎲',
    random: true,
    description: '按目标期号定种机选的纯随机对照，可重摇，也可恢复默认随机'
  },
  {
    id: 'hot_momentum',
    code: '#2',
    name: '热势恒强',
    icon: '🔥',
    random: false,
    description: 'EMA 短中周期活跃热码 + 上期温热重号 + 斜连邻号动量'
  },
  {
    id: 'omission_rebound',
    code: '#3',
    name: '遗漏回补',
    icon: '🎯',
    random: false,
    description: '个人历史遗漏 80%–98% 饱和度临界区 + 高活性热码短休回补窗'
  },
  {
    id: 'transition_cooccur',
    code: '#4',
    name: '关联共振',
    icon: '🔗',
    random: false,
    description: '近 180 期条件转移升幅 + 同尾与两连号高频共现协同选码'
  },
  {
    id: 'balanced_quota',
    code: '#5',
    name: '三区波色均衡',
    icon: '⚖️',
    random: false,
    description: '贝叶斯平滑频率 + 三区/波色/奇偶均衡配额 + 等隔韵律，适度跨注去重'
  }
];

/** 玩法定义（与 src/constants.js 的 PLAY_MODES 一致，方便单独引用） */
export { PLAY_MODES };

/** 直选每注的号码个数：3 = 三中三，4 = 四中四，5 = 特码 */
export const DIRECT_SIZES = [3, 4, 5];

/** 特码玩法下 4 注精选的名称与说明（命中对象是特码，策略口径与正码玩法不同） */
const SPECIAL_CATALOG_OVERRIDE = {
  hot_momentum: {
    name: '特码热势',
    description: '近 30/60 期作为特码出现的频率 + 上期特码邻号动量 + 尾数带动'
  },
  omission_rebound: {
    name: '特码遗漏回补',
    description: '该号作为特码的历史遗漏分位落在 80%–98% 饱和度临界区'
  },
  transition_cooccur: {
    name: '特码尾数共振',
    description: '近 60 期特码尾数族群频率 + 上期特码尾数带动 + 长期频率'
  },
  balanced_quota: {
    name: '特码三区均衡',
    description: '特码出现频率 + 三区/波色/奇偶均衡配额 + 等隔韵律，适度跨注去重'
  }
};

/**
 * 按玩法取「每日 5 注」目录（特码玩法用特码自己的名称与说明）
 * @param {string} mode 'special' / 'pick3' / 'pick4'
 * @returns {{id:string, code:string, name:string, icon:string, description:string, random:boolean}[]}
 */
export function catalogForMode(mode = 'pick3') {
  const isSpecial = getPlayMode(mode).id === 'special';
  return DAILY_FIVE_CATALOG.map((m) => {
    const override = isSpecial ? SPECIAL_CATALOG_OVERRIDE[m.id] : null;
    return override ? { ...m, name: override.name, description: override.description } : { ...m };
  });
}

/**
 * 随机理论期望
 * @param {number|string} mode 玩法（special / pick3 / pick4）或号码个数（3 / 4 / 5）
 *  - 特码：每注 5 个号覆盖 1 个特码 → 期望命中率 5/49 ≈ 0.102
 *  - 三中三 / 四中四：size 个号 × 6 个正码 / 49（期望命中**号码个数**）
 */
export function randomExpectedHits(mode = 3) {
  const raw = String(mode ?? '').trim();
  if (raw === 'special' || raw === '特码' || raw === 5 || raw === '5') return 5 / 49;
  const size = raw === 'pick4' || raw === 4 || raw === '4' ? 4 : 3;
  return (size * 6) / 49;
}

/** 兼容旧引用：默认按三中三（3 码）计 */
export const RANDOM_EXPECTED_HITS = randomExpectedHits(3);

/** 基础概率：每期开出 6 个正码，任一号码当期出现的概率 */
const BASE_P = 6 / 49;

/* ------------------------------------------------------------------ 工具 */

/** 确定性伪随机微调（同年 + 期号 + 号码 + 盐值下 100% 可复现） */
function deterministicJitter(year, periodNum, num, salt = 1) {
  let x = ((year * 1009 + periodNum * 9176 + num * 379 + salt * 131071) >>> 0) || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) % 10000) / 10000;
}

/** mulberry32：小而稳的可复现 PRNG */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 期号 + 盐值 → 32 位种子 */
function seedFor(year, periodNum, salt) {
  let h = (year * 2654435761) ^ (periodNum * 2246822519) ^ ((salt + 1) * 3266489917);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Fisher–Yates 洗牌（可复现） */
function shuffledNumbers(rng, count) {
  const pool = ALL_NUMBERS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/* -------------------------------------------------------------- 特征计算 */

/**
 * 计算 01~49 每个号码的历史特征（全部来自 priorDraws，无未来函数）
 * @param {object[]} priorDraws 严格早于目标期的开奖记录（降序，最新在前）
 * @param {{ date?: string|number, year?: number }} [targetMeta]
 */
export function computeDailyFiveFeatures(priorDraws = [], targetMeta = {}) {
  const w180 = priorDraws.slice(0, 180);
  const w60 = priorDraws.slice(0, 60);
  const w30 = priorDraws.slice(0, 30);
  const w15 = priorDraws.slice(0, 15);
  const w25 = priorDraws.slice(0, 25);
  const dateOrYear = targetMeta.date || targetMeta.year || priorDraws[0]?.date || 2026;

  const freq = { 15: new Array(50).fill(0), 30: new Array(50).fill(0), 60: new Array(50).fill(0), 180: new Array(50).fill(0) };
  const hitMatrix = []; // hitMatrix[i][n]：第 i 期（倒序，最新在前）n 是否为正码
  for (let i = 0; i < w180.length; i++) {
    const normals = Array.isArray(w180[i]?.numbers) ? w180[i].numbers.slice(0, 6) : [];
    const row = new Array(50).fill(0);
    for (const raw of normals) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 49) continue;
      row[n] = 1;
      freq[180][n]++;
      if (i < 60) freq[60][n]++;
      if (i < 30) freq[30][n]++;
      if (i < 15) freq[15][n]++;
    }
    hitMatrix.push(row);
  }

  // 遗漏：当前间隔 + 该号自身历史间隔序列（用于分位数）
  const omission = new Array(50).fill(w60.length);
  const gapHistory = Array.from({ length: 50 }, () => []);
  const lastSeenIndex = new Array(50).fill(-1);
  for (let i = 0; i < w60.length; i++) {
    const row = hitMatrix[i];
    for (let n = 1; n <= 49; n++) {
      if (!row[n]) continue;
      if (lastSeenIndex[n] >= 0) gapHistory[n].push(lastSeenIndex[n] - i - 1);
      lastSeenIndex[n] = i;
    }
  }
  // hitMatrix[0] 是最近一期：出现位置即为「已遗漏几期」；未出现则记满窗口长度
  for (let n = 1; n <= 49; n++) {
    omission[n] = lastSeenIndex[n] >= 0 ? lastSeenIndex[n] : w60.length;
  }

  // EMA：对「是否出现」序列做指数平滑（从旧到新）
  const ema = (span) => {
    const alpha = 2 / (span + 1);
    const out = new Array(50).fill(0);
    const seq = hitMatrix.slice(0, span).reverse();
    for (const row of seq) {
      for (let n = 1; n <= 49; n++) {
        out[n] = out[n] * (1 - alpha) + alpha * row[n];
      }
    }
    return out;
  };
  const ema15 = ema(15);
  const ema30 = ema(30);

  // 条件转移升幅 lift = P(n_t | n_{t-1}) / P(n)（近 180 期）
  const lift = new Array(50).fill(1);
  const bothCount = new Array(50).fill(0);
  const prevCount = new Array(50).fill(0);
  const normalsOf = (i) => Array.from(new Set((w180[i]?.numbers || []).slice(0, 6).map(Number)))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 49);
  for (let i = 0; i < w180.length - 1; i++) {
    const cur = hitMatrix[i];
    const prevRow = hitMatrix[i + 1]; // i+1 更早一期
    for (const n of normalsOf(i + 1)) {
      prevCount[n]++;
      if (cur[n]) bothCount[n]++;
    }
  }
  for (let n = 1; n <= 49; n++) {
    const cond = prevCount[n] > 0 ? bothCount[n] / prevCount[n] : BASE_P;
    lift[n] = Math.min(2.5, Math.max(0.2, cond / BASE_P));
  }

  // 共现矩阵（近 60 期同期共现）
  const pairCount = Array.from({ length: 50 }, () => new Uint16Array(50));
  for (let i = 0; i < w60.length; i++) {
    const uniq = Array.from(new Set((w60[i]?.numbers || []).slice(0, 6).map(Number)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 49);
    for (let a = 0; a < uniq.length; a++) {
      for (let b = a + 1; b < uniq.length; b++) {
        pairCount[uniq[a]][uniq[b]]++;
        pairCount[uniq[b]][uniq[a]]++;
      }
    }
  }

  // 尾数 / 生肖热度（近 25 期）
  const tailFreq = new Array(10).fill(0);
  const zodiacFreq = {};
  for (let i = 0; i < w25.length; i++) {
    const uniq = Array.from(new Set((w25[i]?.numbers || []).slice(0, 6).map(Number)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 49);
    for (const n of uniq) {
      tailFreq[n % 10]++;
      const z = getZodiacForNumber(n, dateOrYear);
      zodiacFreq[z] = (zodiacFreq[z] || 0) + 1;
    }
  }

  // 上期正码与斜连邻码
  const lastNormals = new Set((priorDraws[0]?.numbers || []).slice(0, 6).map(Number));
  const neighborSet = new Set();
  for (const n of lastNormals) {
    if (n > 1) neighborSet.add(n - 1);
    if (n < 49) neighborSet.add(n + 1);
  }
  const recent3 = new Set();
  for (let i = 0; i < Math.min(3, w60.length); i++) {
    for (const n of (w60[i]?.numbers || []).slice(0, 6)) recent3.add(Number(n));
  }

  const maxTail = Math.max(1, ...tailFreq);
  const maxZodiac = Math.max(1, ...Object.values(zodiacFreq));

  const stats = {};
  for (let n = 1; n <= 49; n++) {
    const gaps = gapHistory[n];
    const cur = omission[n];
    // 遗漏分位数：当前间隔在该号自身历史间隔分布中的位置（0~1）
    let pct = 1;
    if (gaps.length > 0) {
      const le = gaps.filter((g) => g <= cur).length;
      pct = le / gaps.length;
    }
    const color = getColorForNumber(n);
    const zodiac = getZodiacForNumber(n, dateOrYear);
    stats[n] = {
      num: n,
      color,
      zodiac,
      tail: n % 10,
      zone: n <= 16 ? 1 : n <= 33 ? 2 : 3,
      odd: n % 2 === 1,
      freq15: freq[15][n],
      freq30: freq[30][n],
      freq60: freq[60][n],
      freq180: freq[180][n],
      ema15: ema15[n],
      ema30: ema30[n],
      omission: cur,
      omissionPct: pct,
      gapCount: gaps.length,
      isRepeat: lastNormals.has(n),
      isNeighbor: neighborSet.has(n),
      isShortRest: recent3.has(n) && cur >= 1 && cur <= 3,
      lift: lift[n],
      tailNorm: tailFreq[n % 10] / maxTail,
      zodiacNorm: (zodiacFreq[zodiac] || 0) / maxZodiac,
      // 贝叶斯收缩频率：先验强度 10 期、基础率 6/49
      bayesP: (freq[60][n] + 10 * BASE_P) / (60 + 10)
    };
  }

  // ————————————————————————————————————————————————————————————
  // 特码专属特征：这个号「作为特码（开奖最后一个号码）」出现的频率与遗漏
  // 特码玩法的命中对象是特码，所以打分必须用特码自己的历史，而不是 6 个正码的历史。
  // ————————————————————————————————————————————————————————————
  const specialFreq = { 15: new Array(50).fill(0), 30: new Array(50).fill(0), 60: new Array(50).fill(0), 180: new Array(50).fill(0) };
  const specialGapHistory = Array.from({ length: 50 }, () => []);
  const lastSpecialIndex = new Array(50).fill(-1);
  const specialOf = (d) => {
    const s = Number(d?.special);
    return Number.isInteger(s) && s >= 1 && s <= 49 ? s : null;
  };
  for (let i = 0; i < w180.length; i++) {
    const s = specialOf(w180[i]);
    if (s == null) continue;
    specialFreq[180][s]++;
    if (i < 60) specialFreq[60][s]++;
    if (i < 30) specialFreq[30][s]++;
    if (i < 15) specialFreq[15][s]++;
    if (lastSpecialIndex[s] >= 0) specialGapHistory[s].push(lastSpecialIndex[s] - i - 1);
    lastSpecialIndex[s] = i;
  }
  const specialTailFreq = new Array(10).fill(0);
  for (let i = 0; i < w60.length; i++) {
    const s = specialOf(w60[i]);
    if (s != null) specialTailFreq[s % 10]++;
  }
  const maxSpecialTail = Math.max(1, ...specialTailFreq);
  const lastSpecial = specialOf(w180[0]);
  const specialNeighbor = new Set();
  if (lastSpecial != null) {
    if (lastSpecial > 1) specialNeighbor.add(lastSpecial - 1);
    if (lastSpecial < 49) specialNeighbor.add(lastSpecial + 1);
  }
  const lastSpecialTail = lastSpecial != null ? lastSpecial % 10 : -1;

  const specialStats = {};
  for (let n = 1; n <= 49; n++) {
    const gaps = specialGapHistory[n];
    const cur = lastSpecialIndex[n] >= 0 ? lastSpecialIndex[n] : w60.length;
    let pct = 1;
    if (gaps.length > 0) {
      const le = gaps.filter((g) => g <= cur).length;
      pct = le / gaps.length;
    }
    specialStats[n] = {
      num: n,
      color: getColorForNumber(n),
      zodiac: getZodiacForNumber(n, dateOrYear),
      tail: n % 10,
      zone: n <= 16 ? 1 : n <= 33 ? 2 : 3,
      odd: n % 2 === 1,
      freq15: specialFreq[15][n],
      freq30: specialFreq[30][n],
      freq60: specialFreq[60][n],
      freq180: specialFreq[180][n],
      omission: cur,
      omissionPct: pct,
      gapCount: gaps.length,
      isNeighbor: specialNeighbor.has(n),
      isTailMatch: lastSpecialTail >= 0 && n % 10 === lastSpecialTail,
      isShortRest: cur >= 1 && cur <= 3,
      tailNorm: specialTailFreq[n % 10] / maxSpecialTail
    };
  }

  return { stats, specialStats, pairCount, sampleSize: w60.length, priorCount: priorDraws.length };
}

/* ------------------------------------------------------------ 评分与选号 */

/** 生成 4 注精选的打分表 */
function buildScoreMaps(features, year, periodNum) {
  const { stats } = features;
  const maps = { hot_momentum: {}, omission_rebound: {}, transition_cooccur: {}, balanced_quota: {} };
  for (let n = 1; n <= 49; n++) {
    const st = stats[n];
    const j2 = deterministicJitter(year, periodNum, n, 11);
    const j3 = deterministicJitter(year, periodNum, n, 23);
    const j4 = deterministicJitter(year, periodNum, n, 37);
    const j5 = deterministicJitter(year, periodNum, n, 53);

    // #2 热势恒强：EMA 短中周期 + 重号 + 斜连邻号
    maps.hot_momentum[n] =
      2.2 * st.ema15 +
      1.5 * st.ema30 +
      (st.isRepeat ? 1.5 : 0) +
      (st.isNeighbor ? 1.2 : 0) +
      0.8 * st.tailNorm +
      j2 * 1.3;

    // #3 遗漏回补：80%–98% 临界区 + 热码短休窗
    const pct = st.omissionPct;
    const rebound = pct >= 0.8 ? 1.6 + 2.2 * ((pct - 0.8) / 0.2) : 0.9 * pct;
    maps.omission_rebound[n] =
      1.6 * rebound +
      (st.isShortRest ? 1.4 : 0) +
      0.5 * (st.freq180 / 180) * 6 +
      j3 * 1.4;

    // #4 关联共振：条件转移升幅 + 尾数族群
    maps.transition_cooccur[n] =
      2.6 * (Math.min(st.lift, 2) / 2) +
      1.3 * st.tailNorm +
      0.9 * (st.freq60 / 6) +
      j4 * 1.5;

    // #5 均衡配额：贝叶斯频率 + 尾数 + 近 30 期热度
    maps.balanced_quota[n] =
      2.0 * (st.bayesP / BASE_P) * 0.35 +
      1.0 * st.tailNorm +
      0.8 * (st.freq30 / 6) +
      j5 * 1.2;
  }
  return maps;
}

/**
 * 特码模式专用打分表（4 注精选）
 *
 * 命中对象是开奖的最后一个号码（特码），所以打分只用「该号作为特码出现过」的统计：
 *   rel = 出现次数 × 49 / 窗口期数（1.0 = 平均水平）
 */
function buildSpecialScoreMaps(features, year, periodNum) {
  const { specialStats } = features;
  const maps = { hot_momentum: {}, omission_rebound: {}, transition_cooccur: {}, balanced_quota: {} };
  for (let n = 1; n <= 49; n++) {
    const st = specialStats[n];
    const j2 = deterministicJitter(year, periodNum, n, 11);
    const j3 = deterministicJitter(year, periodNum, n, 23);
    const j4 = deterministicJitter(year, periodNum, n, 37);
    const j5 = deterministicJitter(year, periodNum, n, 53);
    const rel15 = (st.freq15 * 49) / 15;
    const rel30 = (st.freq30 * 49) / 30;
    const rel60 = (st.freq60 * 49) / 60;
    const rel180 = (st.freq180 * 49) / 180;

    // #2 特码热势：近 30/60 期作为特码出现的频率 + 上期特码邻号 + 尾数带动
    maps.hot_momentum[n] =
      2.4 * rel30 +
      1.6 * rel60 +
      (st.isNeighbor ? 1.4 : 0) +
      (st.isTailMatch ? 0.8 : 0) +
      0.6 * st.tailNorm +
      j2 * 1.3;

    // #3 特码遗漏回补：该号作为特码的遗漏分位落在 80%–98% 临界区
    const pct = st.omissionPct;
    const rebound = pct >= 0.8 ? 1.6 + 2.2 * ((pct - 0.8) / 0.2) : 0.9 * pct;
    maps.omission_rebound[n] =
      1.6 * rebound +
      (st.isShortRest ? 1.2 : 0) +
      0.5 * rel180 +
      j3 * 1.4;

    // #4 特码尾数共振：近 60 期特码尾数族群 + 上期特码尾数 + 长期频率
    maps.transition_cooccur[n] =
      2.2 * st.tailNorm +
      1.4 * rel180 +
      0.9 * (st.isTailMatch ? 1 : 0) +
      j4 * 1.5;

    // #5 特码三区均衡：出现频率 + 尾数 + 近 30 期热度（配额由选号器兜底）
    maps.balanced_quota[n] =
      2.0 * rel60 * 0.35 +
      1.0 * st.tailNorm +
      0.8 * rel30 +
      0.4 * rel15 +
      j5 * 1.2;
  }
  return maps;
}

/* --------------------------------------------------------------- 主入口 */

/**
 * 生成某期的「每日 5 注」
 * @param {object[]} allDraws 完整底库（降序）
 * @param {{ year?: number, periodNum?: number, date?: string }} [targetMeta]
 * @param {{ randomSalt?: number, mode?: string, size?: number, pinnedNumbers?: number[] }} [options]
 *        mode: 'special' = 特码（每注 5 个号，命中 = 特码落在这 5 个号里）
 *              'pick3'   = 三中三（每注 3 个号，全部落在 6 正码里）
 *              'pick4'   = 四中四（每注 4 个号，全部落在 6 正码里）
 */
export function generateDailyFive(allDraws = [], targetMeta = {}, options = {}) {
  const latest = allDraws[0] || { year: 2026, periodNum: 296, date: '2026-10-23' };
  const year = Number(targetMeta.year || latest.year || 2026);
  const periodNum = Number(targetMeta.periodNum || (latest.periodNum || 0) + 1);
  const date = targetMeta.date || latest.date || `${year}-10-24`;
  const randomSalt = Number(options.randomSalt || 0);
  const spec = getPlayMode(options.mode);
  const size = spec.size;
  const isSpecial = spec.id === 'special';

  const priorDraws = getPriorDraws(allDraws, { year, periodNum });
  const features = computeDailyFiveFeatures(priorDraws, { year, periodNum, date });
  const scoreMaps = isSpecial
    ? buildSpecialScoreMaps(features, year, periodNum)
    : buildScoreMaps(features, year, periodNum);
  // 特码玩法的命中对象是特码，正码之间的共现加分不适用
  const selectFeatures = isSpecial ? { ...features, pairCount: null } : features;
  const pinned = normalizeNumbers(options.pinnedNumbers || [], { sort: true, maxCount: size });

  const entries = [];

  // #1 随机基线：按期号定种机选 size 个号（纯随机对照）
  const rng = mulberry32(seedFor(year, periodNum, randomSalt));
  const randomNums = shuffledNumbers(rng, size);
  entries.push({
    id: 'random',
    code: '#1',
    name: '随机基线',
    icon: '🎲',
    random: true,
    numbers: randomNums,
    rationale: randomSalt > 0 ? `已重摇第 ${randomSalt} 次（按期号定种）` : '按目标期号定种机选的纯随机对照',
    seed: seedFor(year, periodNum, randomSalt)
  });

  // #2~#5 精选
  const order = ['hot_momentum', 'omission_rebound', 'transition_cooccur', 'balanced_quota'];
  const usedElsewhere = new Set();
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const meta = DAILY_FIVE_CATALOG.find((m) => m.id === id);
    const scoreMap = scoreMaps[id];
    const nums = selectDirectNumbers(scoreMap, selectFeatures, {
      size,
      pinned: i === 0 ? pinned : [],
      quota: id === 'balanced_quota',
      usedElsewhere: i === order.length - 1 ? usedElsewhere : new Set()
    });
    const override = isSpecial ? SPECIAL_CATALOG_OVERRIDE[id] : null;
    entries.push({
      ...meta,
      name: override?.name || meta.name,
      numbers: nums,
      rationale: override?.description || meta.description,
      seed: null
    });
    for (const n of nums) usedElsewhere.add(n);
  }

  const ordered = [entries[0], entries[1], entries[2], entries[3], entries[4]];

  // 共识号：≥2 注精选（不含随机注）共同选中的号码
  const counts = new Map();
  for (const e of ordered.slice(1)) {
    for (const n of e.numbers) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const consensus = ALL_NUMBERS.filter((n) => (counts.get(n) || 0) >= 2);

  // 每注的形态统计
  for (const e of ordered) {
    const st = features.stats;
    const hotList = e.numbers.filter((n) => st[n].freq30 >= 5 || st[n].freq15 >= 3);
    const hot = hotList.length;
    const cold = e.numbers.filter((n) => !hotList.includes(n) && (st[n].omission >= 10 || st[n].freq30 <= 2)).length;
    const odd = e.numbers.filter((n) => st[n].odd).length;
    e.shape = {
      hot,
      warm: e.numbers.length - hot - cold,
      cold,
      red: e.numbers.filter((n) => st[n].color === 'red').length,
      blue: e.numbers.filter((n) => st[n].color === 'blue').length,
      green: e.numbers.filter((n) => st[n].color === 'green').length,
      zone1: e.numbers.filter((n) => st[n].zone === 1).length,
      zone2: e.numbers.filter((n) => st[n].zone === 2).length,
      zone3: e.numbers.filter((n) => st[n].zone === 3).length,
      odd,
      even: e.numbers.length - odd,
      big: e.numbers.filter((n) => n >= 25).length,
      small: e.numbers.filter((n) => n <= 24).length,
      sum: e.numbers.reduce((a, b) => a + b, 0)
    };
  }

  return {
    target: { year, periodNum, period: String(periodNum).padStart(3, '0'), date },
    priorSampleCount: priorDraws.length,
    featureWindow: features.sampleSize,
    randomSalt,
    mode: spec.id,
    size,
    five: ordered,
    consensus,
    stats: features.stats
  };
}

/* -------------------------------------------------------------- 逐期回放 */

/**
 * 逐期生成 5 注回放记录（无未来函数）
 * @param {object[]} allDraws
 * @param {object[]} targets
 * @param {{ stake?: number, odds3?: number, odds4?: number, oddsSpecial?: number, randomSalt?: number, mode?: string, size?: number }} [options]
 */
export function buildDailyFiveRecords(allDraws = [], targets = [], options = {}) {
  const { stake = 10, odds3 = 650, odds4 = 7500, oddsSpecial = 48, randomSalt = 0 } = options;
  const spec = getPlayMode(options.mode);
  const size = spec.size;
  const records = [];
  for (const draw of targets) {
    if (!draw) continue;
    const plan = generateDailyFive(allDraws, { year: draw.year, periodNum: draw.periodNum, date: draw.date }, { randomSalt, mode: spec.id });
    const five = plan.five.map((e) => {
      const ev = evaluateTickets([e.numbers], draw, { stake, odds3, odds4, oddsSpecial, playMode: spec.id, targetSize: size });
      const detail = ev.details[0] || { hitNums: [], hitCount: 0, isWin: false, payout: 0 };
      return {
        id: e.id,
        code: e.code,
        name: e.name,
        icon: e.icon,
        random: !!e.random,
        numbers: e.numbers,
        hitNums: detail.hitNums,
        hitCount: detail.hitCount,
        isWin: detail.isWin,
        payout: detail.payout,
        matchedNormals: detail.hitNums,
        matchedNormalCount: detail.hitCount
      };
    });
    records.push({ draw, five, consensus: plan.consensus, size, mode: spec.id });
  }
  return records;
}

/**
 * 逐期生成「当前自选」的单注回放记录（与 buildDailyFiveRecords 结构一致，便于统一渲染）
 * @param {object[]} allDraws
 * @param {object[]} targets
 * @param {{ stake?: number, odds3?: number, odds4?: number, oddsSpecial?: number, customNumbers?: number[], mode?: string, size?: number }} [options]
 */
export function buildCustomRecords(allDraws = [], targets = [], options = {}) {
  const { stake = 10, odds3 = 650, odds4 = 7500, oddsSpecial = 48 } = options;
  const spec = getPlayMode(options.mode);
  const size = spec.size;
  const picks = normalizeNumbers(options.customNumbers || [], { sort: true, maxCount: size });
  if (picks.length !== size) return [];

  const records = [];
  for (const draw of targets) {
    if (!draw) continue;
    const ev = evaluateTickets([picks], draw, { stake, odds3, odds4, oddsSpecial, playMode: spec.id, targetSize: size });
    const detail = ev.details[0] || { hitNums: [], hitCount: 0, isWin: false, payout: 0 };
    records.push({
      draw,
      consensus: [],
      size,
      mode: spec.id,
      five: [{
        id: 'custom',
        code: '自选',
        name: `当前自选 ${size} 码`,
        icon: '✍️',
        random: false,
        numbers: picks,
        hitNums: detail.hitNums,
        hitCount: detail.hitCount,
        isWin: detail.isWin,
        payout: detail.payout,
        matchedNormals: detail.hitNums,
        matchedNormalCount: detail.hitCount
      }]
    });
  }
  return records;
}

/**
 * 汇总 5 注的表现
 *
 * 每注就是 1 注投注；成本 = 期数 × 单注本金；返奖 = 命中期数 × 单注本金 × 赔率。
 *  - 特码玩法：命中 = 开奖特码落在这 5 个号里
 *  - 三中三 / 四中四：命中 = 该注号码全部落在 6 个正码里
 *
 * @param {object[]} records buildDailyFiveRecords / buildCustomRecords 的输出
 * @param {{ stake?: number, odds3?: number, odds4?: number, oddsSpecial?: number, mode?: string, size?: number }} [options]
 */
export function summarizeDailyFive(records = [], options = {}) {
  const { stake = 10, odds3 = 650, odds4 = 7500, oddsSpecial = 48 } = options;
  const spec = getPlayMode(options.mode);
  const size = spec.size;
  const odds = spec.id === 'special' ? oddsSpecial : spec.id === 'pick4' ? odds4 : odds3;

  const catalog = catalogForMode(spec.id).map((m) => ({
    ...m,
    periods: 0,
    hitSum: 0,
    winPeriods: 0,
    cost: 0,
    payout: 0
  }));
  const index = new Map(catalog.map((c) => [c.id, c]));
  const ensure = (e) => {
    if (index.has(e.id)) return index.get(e.id);
    const agg = {
      id: e.id,
      code: e.code || '—',
      name: e.name || e.id,
      icon: e.icon || '',
      random: !!e.random,
      periods: 0,
      hitSum: 0,
      winPeriods: 0,
      cost: 0,
      payout: 0
    };
    catalog.push(agg);
    index.set(e.id, agg);
    return agg;
  };

  for (const rec of records) {
    for (const e of rec.five) {
      const agg = ensure(e);
      agg.periods++;
      agg.hitSum += e.hitCount || 0;
      if (e.isWin) agg.winPeriods++;
      agg.cost += stake;
      agg.payout += e.payout || 0;
    }
  }

  for (const agg of catalog) {
    agg.avgHits = agg.periods ? Number((agg.hitSum / agg.periods).toFixed(3)) : 0;
    agg.net = agg.payout - agg.cost;
    agg.roi = agg.cost > 0 ? Number(((agg.net / agg.cost) * 100).toFixed(2)) : 0;
    agg.winRate = agg.periods ? Number(((agg.winPeriods / agg.periods) * 100).toFixed(3)) : 0;
  }

  const totalCost = catalog.reduce((a, c) => a + c.cost, 0);
  const totalPayout = catalog.reduce((a, c) => a + c.payout, 0);
  return {
    size,
    mode: spec.id,
    stake,
    odds3,
    odds4,
    oddsSpecial,
    odds,
    periods: records.length,
    catalog,
    expectedHits: Number(randomExpectedHits(spec.id).toFixed(3)),
    totalCost,
    totalPayout,
    totalNet: totalPayout - totalCost,
    totalRoi: totalCost > 0 ? Number((((totalPayout - totalCost) / totalCost) * 100).toFixed(2)) : 0
  };
}
