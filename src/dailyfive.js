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
import { isUsableDraw } from './audit.js';
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
 * 遗漏回补曲线：把「遗漏分位」映射成回补强度（0 ~ 3）
 *
 * 设计原则（修复遗漏 bug 后重新校准）：
 *   1. 0.80~0.98 是所谓「饱和度临界区」，给 1.0 → 3.0 的递增；
 *   2. 超过 0.98 的极端长空**不再继续加分**（打回 1.2）。独立开奖下
 *      「空得越久越该回补」并不成立（下一期命中概率恒为 5/49），
 *      这里的分数只是选号风格，不能把冷号包装成「更该出」；
 *   3. 0.8 以下线性递减，避免回补注变成「专挑刚开过的号」。
 * @param {number} pct 遗漏分位 0~1
 * @returns {number}
 */
export function reboundStrength(pct = 0) {
  const p = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct)) : 0;
  if (p >= 0.98) return 1.2;
  if (p >= 0.8) return 1.0 + (2.0 * (p - 0.8)) / 0.18;
  return 0.9 * (p / 0.8);
}

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

    // #3 遗漏回补：80%–98% 饱和度临界区为主信号 + 短休回补窗 + 长期频率微调
    // 抖动权重必须小于信号权重（0.5 vs 1.5），否则这一注会退化成「随机票」
    maps.omission_rebound[n] =
      1.5 * reboundStrength(st.omissionPct) +
      (st.isShortRest ? 1.0 : 0) +
      0.35 * (st.freq180 / 180) * 6 +
      j3 * 0.5;

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

    // #3 特码遗漏回补：该号「作为特码」的遗漏分位落在 80%–98% 临界区为主信号
    maps.omission_rebound[n] =
      1.5 * reboundStrength(st.omissionPct) +
      (st.isShortRest ? 1.0 : 0) +
      0.3 * rel180 +
      j3 * 0.5;

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

  // ————————————————————————————————————————————————————————————
  // 杀上期特码：特码玩法的命中对象就是「开奖的最后一个号码」，
  // 而这个号在下一期继续当特码的概率只有约 1/49（≈2.04%），属于典型的低价值号。
  // 所以 5 注全部把它排除在候选池之外：
  //   #1 随机注 —— 在剩下 48 个号里随机（仍然是纯随机，只是不含上期特码）；
  //   #2~#5 精选 —— 直接把该号从候选里剔除，其余历史特征照旧打分。
  // 正码玩法（三中三 / 四中四）的命中对象是 6 个正码，上期特码不参与判定，因此不杀号。
  // ————————————————————————————————————————————————————————————
  const killLastSpecial = isSpecial && options.excludeLastSpecial !== false;
  const lastSpecial = isSpecial ? (features.lastSpecial ?? null) : null;
  const killedNumbers = killLastSpecial && lastSpecial != null ? [lastSpecial] : [];
  const killedLabel = killedNumbers.length ? `已杀上期特码 ${String(killedNumbers[0]).padStart(2, '0')}` : '';

  const entries = [];

  // #1 随机基线：按期号定种机选 size 个号（纯随机对照，不含上期特码）
  const rng = mulberry32(seedFor(year, periodNum, randomSalt));
  const randomNums = shuffledNumbers(rng, size, killedNumbers);
  entries.push({
    id: 'random',
    code: '#1',
    name: '随机基线',
    icon: '🎲',
    random: true,
    numbers: randomNums,
    killed: killedNumbers.slice(),
    rationale: [
      randomSalt > 0 ? `已重摇第 ${randomSalt} 次（按期号定种）` : '按目标期号定种机选的纯随机对照',
      killedNumbers.length ? `池子为除上期特码外的 48 个号（${killedLabel}）` : ''
    ].filter(Boolean).join(' · '),
    seed: seedFor(year, periodNum, randomSalt)
  });

  // #2~#5 精选：四注各自风格不变（热势 / 遗漏回补 / 尾数共振 / 三区均衡），
  // 统一不带入上期特码，并逐注累计「跨注已用次数」：同一个号被 2 注选中后，
  // 后面两注几乎不会再压上去，让 5 注合起来覆盖面更散、更均匀。
  const order = ['hot_momentum', 'omission_rebound', 'transition_cooccur', 'balanced_quota'];
  const usage = new Map();
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const meta = DAILY_FIVE_CATALOG.find((m) => m.id === id);
    const scoreMap = scoreMaps[id];
    const nums = selectDirectNumbers(scoreMap, selectFeatures, {
      size,
      pinned: i === 0 ? pinned : [],
      quota: id === 'balanced_quota',
      usedElsewhere: usage,
      excluded: killedNumbers,
      // 跨注硬上限：同一个号最多被 2 注精选同时选中（再往上只会浪费覆盖面）
      maxShared: 2
    });
    const override = isSpecial ? SPECIAL_CATALOG_OVERRIDE[id] : null;
    entries.push({
      ...meta,
      name: override?.name || meta.name,
      numbers: nums,
      killed: killedNumbers.slice(),
      rationale: [override?.description || meta.description, killedLabel].filter(Boolean).join(' · '),
      seed: null
    });
    for (const n of nums) usage.set(n, (usage.get(n) || 0) + 1);
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
    stats: features.stats,
    // 杀号信息：killedNumbers = 本期被 5 注统一排除的号码（特码玩法 = 上期特码）
    killedNumbers,
    lastSpecial
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
