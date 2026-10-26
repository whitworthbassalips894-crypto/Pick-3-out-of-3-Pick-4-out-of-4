/**
 * 「每日 5 注」引擎（特码 / 三中三 / 四中四 共用一套骨架）
 *
 * 先把概率说清楚（这也是本引擎唯一的数学依据）：
 *   每期开奖相互独立，任何选号方法都**不能**改变单注命中概率：
 *     特码    每注 5 个号，命中 P = 5/49 ≈ 10.20%
 *     三中三  每注 3 个号全落在 6 个正码里，P = C(6,3)/C(49,3) ≈ 0.1086%
 *     四中四  每注 4 个号全落在 6 个正码里，P = C(6,4)/C(49,4) ≈ 0.00708%
 *   能改变的只有「覆盖面」：5 注号码互不重叠时，5 注合计「至少中 1 注」的概率最大
 *     （特码 25/49 ≈ 51.0%；三中三 ≈ 5 × 0.1086% ≈ 0.543%；四中四 ≈ 5 × 0.00708% ≈ 0.0354%）
 *   所以本引擎的唯一硬约束是：5 注共 5×size 个号码**互不重复**。
 *
 * 5 注分工（风格不同，概率相同）：
 *   #1 🎲 完全随机  从 4 注精选没用到的那批号里等概率机选（对照组，可重摇）
 *   #2 🔥 热号      近 30 期出现次数最多的号（顺势风格）
 *   #3 🎯 冷号      遗漏最久的号（回补风格）
 *   #4 ⚖️ 形态均衡  和值靠近理论均值，奇偶 / 大小 / 三区均衡
 *   #5 🧩 补位覆盖  补齐前 4 注没覆盖到的尾数与区段
 *
 * 严格无未来函数：第 T 期的 5 注只用严格早于 T 期的正码 / 特码数据。
 * 确定性：同一期 + 同一重摇盐值 + 同一玩法 → 永远得到同一组 5 注。
 */

import { ALL_NUMBERS, PLAY_MODES, getColorForNumber, getPlayMode, getZodiacForNumber } from './constants.js';
import { isUsableDraw } from './audit.js';
import { binomial, evaluateTickets, normalizeNumbers } from './combinatorics.js';
import { getPriorDraws, selectDirectNumbers } from './strategy.js';

export const DAILY_FIVE_CATALOG = [
  {
    id: 'random',
    code: '#1',
    name: '完全随机',
    icon: '🎲',
    random: true,
    description: '从 4 注精选未用的号里等概率机选（对照基线，可重摇）'
  },
  {
    id: 'hot',
    code: '#2',
    name: '热号',
    icon: '🔥',
    random: false,
    description: '近 30 期出现次数最多的号 + 上期重号 / 斜邻'
  },
  {
    id: 'cold',
    code: '#3',
    name: '冷号',
    icon: '🎯',
    random: false,
    description: '按该号自身的历史间隔分位，取遗漏最久的号'
  },
  {
    id: 'shape',
    code: '#4',
    name: '形态均衡',
    icon: '⚖️',
    random: false,
    description: '和值靠近理论均值，奇偶 / 大小 / 三区均衡'
  },
  {
    id: 'cover',
    code: '#5',
    name: '补位覆盖',
    icon: '🧩',
    random: false,
    description: '补齐前 4 注未覆盖的尾数与区段，让 5 注铺满 01–49'
  }
];

/** 玩法定义（与 src/constants.js 的 PLAY_MODES 一致，方便单独引用） */
export { PLAY_MODES };

/** 直选每注的号码个数：3 = 三中三，4 = 四中四，5 = 特码 */
export const DIRECT_SIZES = [3, 4, 5];

/** 特码玩法的说明（命中对象是特码，统计口径换成「该号作为特码出现」的历史） */
const SPECIAL_DESCRIPTIONS = {
  random: '从 4 注精选未用的号里等概率机选（对照基线，可重摇）',
  hot: '近 30 期作为特码出现次数最多的号 + 上期特码邻号',
  cold: '作为特码遗漏最久的号',
  shape: '和值靠近 5 码理论均值，奇偶 / 大小 / 三区均衡',
  cover: '补齐前 4 注未覆盖的尾数与区段'
};

/**
 * 按玩法取「每日 5 注」目录（特码玩法换一套说明文字，名称保持一致）
 * @param {string} mode 'special' / 'pick3' / 'pick4'
 * @returns {{id:string, code:string, name:string, icon:string, description:string, random:boolean}[]}
 */
export function catalogForMode(mode = 'pick3') {
  const isSpecial = getPlayMode(mode).id === 'special';
  return DAILY_FIVE_CATALOG.map((m) => (
    isSpecial ? { ...m, description: SPECIAL_DESCRIPTIONS[m.id] || m.description } : { ...m }
  ));
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

/**
 * Fisher–Yates 洗牌（可复现）
 * @param {() => number} rng
 * @param {number} count 取几个号
 * @param {Iterable<number>} [excluded] 硬性排除的号码（例如特码玩法的上期特码）
 */
function shuffledNumbers(rng, count, excluded = []) {
  const excludedSet = new Set();
  for (const raw of excluded || []) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 49) excludedSet.add(n);
  }
  const pool = excludedSet.size ? ALL_NUMBERS.filter((n) => !excludedSet.has(n)) : ALL_NUMBERS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/* -------------------------------------------------------------- 特征计算 */

/**
 * 把一期开奖的号码列表清洗成「合法且不重复」的号码（升序无关）
 *
 * 历史上传数据里出现过「同一行 6 个正码里有重复号」的坏行（如 2022-132 期的 33 出现两次），
 * 如果不去重，这类行会让同一个号在一次开奖里被记两次频率，污染全部统计。
 * @param {Array<number|string>} rawNumbers
 * @param {number} [limit=6]
 * @returns {number[]}
 */
export function cleanNumbers(rawNumbers = [], limit = 6) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawNumbers) ? rawNumbers : []) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 49 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从「最新在前」的出现矩阵里算遗漏信息（无未来函数）
 *
 * 约定：matrix[i][n] = 1 表示号码 n 在第 i 期出现，**i = 0 是最新一期**。
 *
 * 历史 bug 说明（2026-10-26 修复）：
 *   旧实现 `gapHistory[n].push(lastSeenIndex[n] - i - 1)` 因为遍历方向是「新 → 旧」，
 *   结果恒为负数；并且 `lastSeenIndex[n]` 每一轮都被覆盖成**更老**的期号，
 *   循环结束后拿到的是「窗口内最老的一次出现」，导致 omission 全部偏大、
 *   omissionPct 恒为 1、isShortRest 恒为 false。
 *
 * @param {Array<ArrayLike<number>>} matrix 最新在前的出现矩阵
 * @param {number} window 窗口期数（用于「窗口内没出现过」的兜底值）
 * @returns {{ omission: number[], gapHistory: number[][], lastSeen: number[] }}
 *   omission[n]：已连续多少期没有出现（0 = 最近一期刚出现；窗口内没出现 = window）
 *   gapHistory[n]：该号历史上两次出现之间「隔了几期」（都是 >= 0 的整数）
 *   lastSeen[n]：最近一次出现距最新一期的期数（-1 = 窗口内没出现过）
 */
export function buildOmissionSeries(matrix = [], window = matrix.length) {
  const size = Math.max(1, Math.trunc(Number(window) || 0));
  // lastSeen[n]：最近一次出现的下标（i 从 0 = 最新一期开始递增，所以第一次遇到就是最近的）
  const lastSeen = new Array(50).fill(-1);
  // prevSeen[n]：遍历到当前位置时，上一个（更新的）出现位置，用于算间距
  const prevSeen = new Array(50).fill(-1);
  const gapHistory = Array.from({ length: 50 }, () => []);
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i] || [];
    for (let n = 1; n <= 49; n++) {
      if (!row[n]) continue;
      if (lastSeen[n] < 0) lastSeen[n] = i;                    // 只记最近一次，不能被更老的期号覆盖
      if (prevSeen[n] >= 0) gapHistory[n].push(i - prevSeen[n] - 1); // 间距 = 两次出现之间隔了几期（>=0）
      prevSeen[n] = i;
    }
  }
  const omission = new Array(50).fill(size);
  for (let n = 1; n <= 49; n++) {
    omission[n] = lastSeen[n] >= 0 ? lastSeen[n] : size;
  }
  return { omission, gapHistory, lastSeen };
}

/**
 * 遗漏分位：当前遗漏在这个号自身的间距分布里排第几（0~1）
 * @param {number[]} gaps 该号的历史间距序列
 * @param {number} cur 当前遗漏
 * @returns {number}
 */
export function omissionPercentile(gaps = [], cur = 0) {
  if (!Array.isArray(gaps) || gaps.length === 0) return 1;
  const le = gaps.filter((g) => g <= cur).length;
  return le / gaps.length;
}

/**
 * 计算 01~49 每个号码的历史特征（全部来自 priorDraws，无未来函数）
 * @param {object[]} priorDraws 严格早于目标期的开奖记录（降序，最新在前）
 * @param {{ date?: string|number, year?: number }} [targetMeta]
 */
export function computeDailyFiveFeatures(priorDraws = [], targetMeta = {}) {
  // 坏行隔离：正码重复 / 越界 / 特码与正码重叠的期次不参与统计（见 src/audit.js）。
  // 不猜测补全，宁可少一期也不能让一次开奖被算成两个号。
  const usablePrior = priorDraws.filter(isUsableDraw);
  const w180 = usablePrior.slice(0, 180);
  const w60 = usablePrior.slice(0, 60);
  const w30 = usablePrior.slice(0, 30);
  const w15 = usablePrior.slice(0, 15);
  const w25 = usablePrior.slice(0, 25);
  const dateOrYear = targetMeta.date || targetMeta.year || priorDraws[0]?.date || 2026;

  const freq = { 15: new Array(50).fill(0), 30: new Array(50).fill(0), 60: new Array(50).fill(0), 180: new Array(50).fill(0) };
  const hitMatrix = []; // hitMatrix[i][n]：第 i 期（倒序，最新在前）n 是否为正码
  for (let i = 0; i < w180.length; i++) {
    // cleanNumbers 去重：防止坏行（同号重复）把一次开奖算成两次
    const normals = cleanNumbers(w180[i]?.numbers, 6);
    const row = new Array(50).fill(0);
    for (const n of normals) {
      row[n] = 1;
      freq[180][n]++;
      if (i < 60) freq[60][n]++;
      if (i < 30) freq[30][n]++;
      if (i < 15) freq[15][n]++;
    }
    hitMatrix.push(row);
  }

  // 遗漏：当前间隔 + 该号自身历史间隔序列（用于分位数）
  // 用整个 180 期窗口算间距（每个号平均出现 ~22 次，间距样本足够做分位），
  // 而不是只用 60 期（样本太少会让分位只有 0 / 1 两个取值）。
  const { omission, gapHistory } = buildOmissionSeries(hitMatrix, w180.length);

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
  const normalsOf = (i) => cleanNumbers(w180[i]?.numbers, 6);
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
    const uniq = cleanNumbers(w60[i]?.numbers, 6);
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
    const uniq = cleanNumbers(w25[i]?.numbers, 6);
    for (const n of uniq) {
      tailFreq[n % 10]++;
      const z = getZodiacForNumber(n, dateOrYear);
      zodiacFreq[z] = (zodiacFreq[z] || 0) + 1;
    }
  }

  // 上期正码与斜连邻码
  const lastNormals = new Set(cleanNumbers(usablePrior[0]?.numbers, 6));
  const neighborSet = new Set();
  for (const n of lastNormals) {
    if (n > 1) neighborSet.add(n - 1);
    if (n < 49) neighborSet.add(n + 1);
  }
  const recent3 = new Set();
  for (let i = 0; i < Math.min(3, w60.length); i++) {
    for (const n of cleanNumbers(w60[i]?.numbers, 6)) recent3.add(n);
  }

  const maxTail = Math.max(1, ...tailFreq);
  const maxZodiac = Math.max(1, ...Object.values(zodiacFreq));

  const stats = {};
  for (let n = 1; n <= 49; n++) {
    const gaps = gapHistory[n];
    const cur = omission[n];
    // 遗漏分位数：当前间隔在该号自身历史间隔分布中的位置（0~1）
    const pct = omissionPercentile(gaps, cur);
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
  const specialOf = (d) => {
    const s = Number(d?.special);
    return Number.isInteger(s) && s >= 1 && s <= 49 ? s : null;
  };
  // 特码出现矩阵：matrix[i][n] = 1 表示第 i 期（最新在前）的特码是 n
  // 特码每期只开出 1 个，若只看 60 期，每个号平均只有 1 次出现 → 间距样本 1 个，
  // 分位会退化成 0 / 1。这里放宽到 400 期，让每个号有 ~8 次出现、7 个间距样本。
  const specialGapWindow = Math.min(priorDraws.length, 400);
  const specialMatrix = [];
  for (let i = 0; i < priorDraws.length && specialMatrix.length < specialGapWindow; i++) {
    const s = specialOf(priorDraws[i]);
    if (s == null) continue; // 特码缺失的坏行直接跳过，不制造虚假的空档
    const row = new Array(50).fill(0);
    row[s] = 1;
    specialMatrix.push(row);
  }
  for (let i = 0; i < w180.length; i++) {
    const s = specialOf(w180[i]);
    if (s == null) continue;
    specialFreq[180][s]++;
    if (i < 60) specialFreq[60][s]++;
    if (i < 30) specialFreq[30][s]++;
    if (i < 15) specialFreq[15][s]++;
  }
  const { omission: specialOmission, gapHistory: specialGapHistory } = buildOmissionSeries(specialMatrix, specialMatrix.length || 1);
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
    const cur = specialOmission[n];
    const pct = omissionPercentile(gaps, cur);
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

  return {
    stats,
    specialStats,
    pairCount,
    sampleSize: w60.length,
    priorCount: priorDraws.length,
    lastSpecial,
    lastSpecialTail
  };
}

/* ------------------------------------------------------------ 评分与选号 */

/**
 * 4 注精选（热号 / 冷号 / 形态均衡 / 补位覆盖）在「正码」口径下的打分表
 *
 * 提醒：分数只决定「风格」，不改变命中概率。它真正的作用是——在「5 注互不重叠」的
 * 硬约束下，让每注看起来符合自己的选号逻辑（热号确实取最近的活跃号，冷号确实取久未出的号）。
 */
function buildScoreMaps(features, year, periodNum) {
  const { stats } = features;
  const maps = { hot: {}, cold: {}, shape: {}, cover: {} };
  for (let n = 1; n <= 49; n++) {
    const st = stats[n];
    const j2 = deterministicJitter(year, periodNum, n, 11);
    const j3 = deterministicJitter(year, periodNum, n, 23);
    const j4 = deterministicJitter(year, periodNum, n, 37);
    const j5 = deterministicJitter(year, periodNum, n, 53);

    // #2 热号：近 30 期出现次数为主 + EMA15 活跃度 + 上期重号 / 斜邻
    maps.hot[n] =
      1.0 * st.freq30 +
      6.0 * st.ema15 +
      (st.isRepeat ? 1.2 : 0) +
      (st.isNeighbor ? 0.7 : 0) +
      j2 * 0.9;

    // #3 冷号：该号自身间距分布里的遗漏分位（越久没出越高）+ 当前遗漏期数
    maps.cold[n] =
      3.0 * st.omissionPct +
      0.06 * Math.min(st.omission, 40) +
      j3 * 0.4;

    // #4 形态均衡：号码靠近中值 25（和值自然落在理论均值附近），频率只做中性微调
    maps.shape[n] =
      -0.10 * Math.abs(n - 25) +
      0.5 * (1 - Math.min(1, Math.abs(st.bayesP - BASE_P) / BASE_P)) +
      j4 * 0.7;

    // #5 补位覆盖：真正的分数要按「已覆盖的尾数 / 区段」动态计算，这里只给底分
    maps.cover[n] = j5 * 0.5;
  }
  return maps;
}

/**
 * 特码模式专用打分表（4 注精选）
 *
 * 命中对象是开奖的最后一个号码（特码），所以只用「该号作为特码出现过」的统计：
 *   rel = 出现次数 × 49 / 窗口期数（1.0 = 平均水平）
 */
function buildSpecialScoreMaps(features, year, periodNum) {
  const { specialStats } = features;
  const maps = { hot: {}, cold: {}, shape: {}, cover: {} };
  for (let n = 1; n <= 49; n++) {
    const st = specialStats[n];
    const j2 = deterministicJitter(year, periodNum, n, 11);
    const j3 = deterministicJitter(year, periodNum, n, 23);
    const j4 = deterministicJitter(year, periodNum, n, 37);
    const j5 = deterministicJitter(year, periodNum, n, 53);
    const rel30 = (st.freq30 * 49) / 30;
    const rel60 = (st.freq60 * 49) / 60;

    // #2 特码热号：近 30 / 60 期作为特码出现的频率 + 上期特码邻号
    maps.hot[n] =
      2.6 * rel30 +
      1.6 * rel60 +
      (st.isNeighbor ? 0.7 : 0) +
      j2 * 0.9;

    // #3 特码冷号：作为特码的遗漏分位 + 遗漏期数
    maps.cold[n] =
      3.0 * st.omissionPct +
      0.03 * Math.min(st.omission, 60) +
      j3 * 0.4;

    // #4 形态均衡：靠近中值 25
    maps.shape[n] = -0.10 * Math.abs(n - 25) + j4 * 0.7;

    // #5 补位覆盖：动态计算，这里只给底分
    maps.cover[n] = j5 * 0.5;
  }
  return maps;
}

/**
 * #5 补位覆盖的动态打分：优先补前 4 注里出现得最少的尾数，并尽量离已用号码远一些，
 * 让 5 注在 01–49 上铺得开（只为外观均匀，不改变命中概率）。
 * @param {Set<number>} used 前 4 注已用掉的号码
 * @param {Record<number, number>} baseMap 底分
 */
function buildCoverScoreMap(used = new Set(), baseMap = {}) {
  const tailCount = new Array(10).fill(0);
  for (const n of used) tailCount[n % 10]++;
  const out = {};
  for (let n = 1; n <= 49; n++) {
    let minDist = 49;
    for (const u of used) minDist = Math.min(minDist, Math.abs(u - n));
    out[n] =
      0.9 * (3 - (tailCount[n % 10] || 0)) +
      0.5 * Math.min(minDist, 6) +
      0.3 * (baseMap[n] || 0);
  }
  return out;
}

/* --------------------------------------------------------------- 主入口 */

/**
 * 生成某期的「每日 5 注」
 * @param {object[]} allDraws 完整底库（降序）
 * @param {{ year?: number, periodNum?: number, date?: string }} [targetMeta]
 * @param {{ randomSalt?: number, mode?: string, pinnedNumbers?: number[] }} [options]
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
  const catalog = catalogForMode(spec.id);

  // ————————————————————————————————————————————————————————————
  // 5 注互不重叠：used = 已用掉的号码，后面每一注都把它作为硬性排除项。
  // 这是整套方案里唯一真正影响概率的部分：5 注合起来覆盖 5×size 个不同号码，
  // 「至少中 1 注」的概率才达到上限。
  // ————————————————————————————————————————————————————————————
  const used = new Set();
  const picks = new Map();

  for (const id of ['hot', 'cold', 'shape', 'cover']) {
    const scoreMap = id === 'cover'
      ? buildCoverScoreMap(used, scoreMaps.cover)
      : scoreMaps[id];
    const nums = selectDirectNumbers(scoreMap, selectFeatures, {
      size,
      pinned: used.size === 0 ? pinned : [],
      quota: id === 'shape',
      excluded: [...used]
    });
    picks.set(id, nums);
    for (const n of nums) used.add(n);
  }

  // #1 完全随机：在 4 注精选没用到的那 49 − 4×size 个号里等概率机选。
  // 号码内容不影响概率（任何 size 个号全部落在 6 正码里的概率都相同），
  // 但只从「剩下的号」里抽，才不会破坏 5 注互不重叠的覆盖面。
  const restCount = ALL_NUMBERS.length - used.size;
  const rng = mulberry32(seedFor(year, periodNum, randomSalt));
  picks.set('random', shuffledNumbers(rng, size, [...used]).sort((a, b) => a - b));

  const entries = catalog.map((meta) => ({
    ...meta,
    numbers: picks.get(meta.id) || [],
    killed: [],
    rationale: meta.id === 'random'
      ? `${randomSalt > 0 ? `已重摇第 ${randomSalt} 次 · ` : ''}从 4 注精选未用的 ${restCount} 个号里等概率机选`
      : meta.description,
    seed: meta.id === 'random' ? seedFor(year, periodNum, randomSalt) : null
  }));

  // 每注的形态统计
  for (const e of entries) {
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

  // 覆盖面：5 注并集的号码数 = 5×size（互不重叠）
  const covered = new Set(entries.flatMap((e) => e.numbers));
  const perTicket = isSpecial ? size / 49 : binomial(6, size) / binomial(49, size);
  const anyHit = isSpecial
    ? covered.size / 49                    // 特码：25 个不同号 → 25/49，精确
    : Math.min(1, 5 * perTicket);          // 直选：5 注互不重叠时 ≈ 5 × 单注概率

  return {
    target: { year, periodNum, period: String(periodNum).padStart(3, '0'), date },
    priorSampleCount: priorDraws.length,
    featureWindow: features.sampleSize,
    randomSalt,
    mode: spec.id,
    size,
    five: entries,
    consensus: [], // 5 注互不重叠 → 不存在「多注共识号」
    coverage: { distinct: covered.size, perTicket, anyHit, allBlank: 1 - anyHit },
    stats: features.stats,
    killedNumbers: [],
    lastSpecial: isSpecial ? (features.lastSpecial ?? null) : null
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
  const { stake = 10, odds3 = 650, odds4 = 7500, oddsSpecial = 9.6, randomSalt = 0 } = options;
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
  const { stake = 10, odds3 = 650, odds4 = 7500, oddsSpecial = 9.6 } = options;
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
  const { stake = 10, odds3 = 650, odds4 = 7500, oddsSpecial = 9.6 } = options;
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
