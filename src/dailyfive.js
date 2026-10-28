/**
 * 选号引擎（特码 = 一张 12 号清单 / 三中三 / 四中四 = 5 组）
 *
 * 先把概率说清楚（这也是本引擎唯一的数学依据）：
 *   每期开奖相互独立，任何选号方法都**不能**改变单注命中概率：
 *     特码    1 个号 = 1 注（1 中 1），单注命中 P = 1/49 ≈ 2.0408%；本工具每期给 12 个号 = 12 注
 *     三中三  每注 3 个号全落在 6 个正码里，P = C(6,3)/C(49,3) ≈ 0.1086%
 *     四中四  每注 4 个号全落在 6 个正码里，P = C(6,4)/C(49,4) ≈ 0.00708%
 *   能改变的只有「覆盖面」：各注号码越少重叠，N 注合计「至少中 1 注」的概率越高。
 *
 * 两种形态（r17 起分开）：
 *   特码   → **一张 12 号清单**（generateDailyFive 走独立分支 + selectSpecialList）
 *            1 个号就是一注，号码之间没有「组」的概念，分组只是从三中三继承下来的壳。
 *   四中四 → 5 组骨架（一组 = 一注组合，分组才有意义），分工见下。
 *   三中三 → 一张 7 码复式（C(7,3) = 35 注，中 k 个正码就中 C(k,3) 注）。
 *
 * 直选 5 组分工（风格不同，概率相同）：
 *   #1 🎲 完全随机  **纯 49 选 size 等概率机选**，允许与精选重复（对照组，可重摇）
 *   #2 🔥 热号      近 30 期出现次数最多的号（顺势风格）
 *   #3 🎯 冷号      遗漏最久的号（回补风格）
 *   #4 ⚖️ 形态均衡  和值靠近理论均值，奇偶 / 大小 / 三区均衡
 *   #5 🧩 补位覆盖  补齐 #2~#4 没覆盖到的尾数与区段
 *
 * 重叠策略：随机组不设任何限制（随机就该是随机的）；#2~#5 四组精选之间互不重复，
 * 让「补位覆盖」这一组有意义、也让整体覆盖面不至于浪费。
 * 「至少中 1 注」的概率按实际号码用容斥公式精确计算（见 anyHitProbability），不靠假设。
 *
 * 严格无未来函数：第 T 期的 5 组只用严格早于 T 期的正码 / 特码数据。
 * 确定性：同一期 + 同一重摇盐值 + 同一玩法 → 永远得到同一组号码。
 */

import { ALL_NUMBERS, PLAY_MODES, betsPerTicket, combinationsCount, getColorForNumber, getPlayMode, getZodiacForNumber } from './constants.js';
import { isUsableDraw } from './audit.js';
import { atLeastMatchProbability, binomial, combinations, evaluateTickets, normalizeNumbers } from './combinatorics.js';
import { getPriorDraws, selectDirectNumbers } from './strategy.js';

export const DAILY_FIVE_CATALOG = [
  {
    id: 'random',
    code: '#1',
    name: '完全随机',
    icon: '🎲',
    random: true,
    description: '从 01–49 等概率机选（纯随机对照，允许与精选重复，可重摇）'
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
    description: '补齐 #2~#4 未覆盖的尾数与区段，让精选四注铺得更开'
  }
];

/** 玩法定义（与 src/constants.js 的 PLAY_MODES 一致，方便单独引用） */
export { PLAY_MODES };

/** 直选玩法的号码个数：3 = 三中三，4 = 四中四（特码是 1 中 1，不走直选口径） */
export const DIRECT_SIZES = [3, 4];

/**
 * 特码的「目录」只有一项：整张 12 号清单
 *
 * 特码是 1 中 1（1 个号 = 1 注），号码之间没有「组」的概念，
 * 所以这里不再返回 5 组，而是返回一张清单——页面据此渲染成单张卡片。
 *
 * @param {string} mode 'special' / 'pick3' / 'pick4'
 * @returns {{id:string, code:string, name:string, icon:string, description:string, random:boolean, layout?:string}[]}
 */
export function catalogForMode(mode = 'pick3') {
  const spec = getPlayMode(mode);
  if (spec.id === 'special') {
    return [{
      id: 'specialList',
      code: '清单',
      name: `特码 ${spec.size} 号`,
      icon: '📋',
      random: false,
      layout: 'list',
      description: `${spec.size} 个号 = ${spec.size} 注，奇偶 / 大小 / 三区均衡，其中 🎲 3 个为纯随机对照`
    }];
  }
  if (spec.layout === 'complex') {
    // 三中三 7 码复式：一张卡片、7 个号、35 注
    const tickets = Math.round((spec.size * (spec.size - 1) * (spec.size - 2)) / 6);
    return [{
      id: 'pick3Set',
      code: '复式',
      name: `三中三 ${spec.size} 码复式`,
      icon: '📋',
      random: false,
      layout: 'complex',
      description: `${spec.size} 个号 = C(${spec.size},3) = ${tickets} 注，三区 3-2-2 / 奇偶 4:3，其中 🎲 2 个为纯随机对照`
    }];
  }
  return DAILY_FIVE_CATALOG.map((m) => ({ ...m }));
}

/**
 * 随机理论期望（每个选项场均中奖注数）
 * @param {number|string} mode 玩法（special / pick3 / pick4）或号码个数（3 / 4）
 *  - 特码：每组 3 个号 = 3 注，1 个号命中率 1/49 → 期望 3/49 ≈ 0.0612 注
 *  - 三中三 / 四中四：size 个号 × 6 个正码 / 49（期望命中**号码个数**）
 */
export function randomExpectedHits(mode = 3) {
  const raw = String(mode ?? '').trim();
  if (raw === 'special' || raw === '特码' || raw === 1 || raw === '1' || raw === 5 || raw === '5') {
    return PLAY_MODES.special.size / 49;
  }
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
 * 特码模式专用打分表（清单内三种精选风格）
 *
 * 命中对象是开奖的最后一个号码（特码），所以只用「该号作为特码出现过」的统计：
 *   rel = 出现次数 × 49 / 窗口期数（1.0 = 平均水平）
 *
 * statsTable 决定统计口径：
 *   · 特码清单 → features.specialStats（「该号作为**特码**出现」的次数 / 遗漏），mean30 = 30/49
 *   · 三中三 7 码复式 → features.stats（「该号落在 6 个正码里」的次数 / 遗漏），mean30 = 30×6/49
 *
 * 注意 balance（形态均衡）的打分口径：
 *   旧实现是 `-0.10 × |n − 25|`，也就是「越靠中间分越高」——全域对称、完全不看历史，
 *   于是每期的均衡组永远是 16 / 25 / 34-35 这几个号（实测最近 300 期里
 *   `16 25 35` 占了 24%）。现在改成「温号」口径（近 30 期作为特码的出现次数接近均值），
 *   真正的均衡由 selectSpecialList() 的全局约束（奇偶 / 大小 / 三区 / 尾数）来保证。
 */
function buildSpecialScoreMaps(features, year, periodNum, statsTable = null, mean30 = 30 / 49) {
  const table = statsTable || features.specialStats;
  const maps = { hot: {}, cold: {}, balance: {} };
  for (let n = 1; n <= 49; n++) {
    const st = table[n];
    const j2 = deterministicJitter(year, periodNum, n, 11);
    const j3 = deterministicJitter(year, periodNum, n, 23);
    const j4 = deterministicJitter(year, periodNum, n, 37);
    const rel30 = (st.freq30 * 49) / 30;
    const rel60 = (st.freq60 * 49) / 60;

    // 热号：近 30 / 60 期作为特码出现的频率 + 上期特码邻号
    maps.hot[n] =
      2.6 * rel30 +
      1.6 * rel60 +
      (st.isNeighbor ? 0.7 : 0) +
      j2 * 0.9;

    // 冷号：作为特码的遗漏分位 + 遗漏期数
    maps.cold[n] =
      3.0 * st.omissionPct +
      0.03 * Math.min(st.omission, 60) +
      j3 * 0.4;

    // 形态均衡（温号）：越接近「平均出现次数」越有分，离得越远（烫 / 冰）越低
    const deviation = Math.abs(st.freq30 - mean30);
    maps.balance[n] =
      1.6 / (1 + deviation) +
      0.25 * (1 - Math.abs(st.omissionPct - 0.5)) +
      j4 * 0.8;
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

/* ------------------------------------------- 特码：一张 12 号清单（1 中 1） */

/**
 * 特码清单的风格定义
 *
 * 特码是「1 中 1」：1 个号 = 1 注，所以「本期的号码」天生就是**一张清单**，
 * 而不是「5 个组」。分组是三中三 / 四中四的形态（一组 = 一注组合），
 * 特码沿用分组只会让人误以为每组是个整体。
 *
 * 12 个号的分工（合计 = 12 注）：
 *   🎲 完全随机  3 个  49 选 3 等概率机选，纯对照，可重摇
 *   🔥 热号      3 个  近 30 / 60 期作为特码最活跃
 *   🎯 冷号      2 个  作为特码遗漏最久
 *   ⚖️ 形态均衡  4 个  补齐全局奇偶 / 大小 / 三区 / 尾数
 */
export const SPECIAL_LIST_STYLES = [
  { id: 'random', count: 3, icon: '🎲', name: '完全随机', description: '49 个号等概率机选（纯随机对照，可重摇）' },
  { id: 'hot', count: 3, icon: '🔥', name: '热号', description: '近 30 / 60 期作为特码最活跃的号' },
  { id: 'cold', count: 2, icon: '🎯', name: '冷号', description: '作为特码遗漏最久的号' },
  { id: 'balance', count: 4, icon: '⚖️', name: '形态均衡', description: '补齐奇偶 / 大小 / 三区 / 尾数，让整张清单均衡' }
];

/**
 * 三中三 7 码复式的选号分工（合计 7 个号 → C(7,3) = 35 注）
 *
 * 先说清楚：复式已经把 7 个号的**全部** 35 种三连组合都买下了，
 * 所以 7 个号怎么选，命中率都是同一个数（3.095%）——
 * 这套分工只为「观感」和「成本可控」，不改变任何概率。
 */
export const PICK3_SET_STYLES = [
  { id: 'random', count: 2, icon: '🎲', name: '完全随机', description: '49 选 2 等概率机选（纯随机对照，可重摇）' },
  { id: 'hot', count: 2, icon: '🔥', name: '热号', description: '近 30 / 60 期正码出现最活跃的号' },
  { id: 'cold', count: 1, icon: '🎯', name: '冷号', description: '正码遗漏最久的号' },
  { id: 'balance', count: 2, icon: '⚖️', name: '形态均衡', description: '补齐三区 / 奇偶 / 尾数' }
];

/** 7 码复式的分区模型：三区 3-2-2（一区 01–16 取 3 个、二区 17–33 取 2 个、三区 34–49 取 2 个） */
export const PICK3_IDEAL_MODEL = { z1: 3, z2s: 1, z2b: 1, z3: 2 };

/**
 * 12 号整体要达到的形态目标
 *
 *   奇偶 6:6、大小 6:6、三区 4:4:4、同一尾数最多出现 2 次（🎲 纯随机号不受约束）
 * 这几个目标是「看上去专业」的地方：它不改变中奖概率（每个号永远是 1/49），
 * 但能保证清单不会挤在某个区间或某个尾数上。
 */
export const SPECIAL_SHAPE_TARGET = { odd: 6, big: 6, zone: 4, maxTailRepeat: 2 };

/** 特码清单的四个子区：一区 / 二区小号 / 二区大号 / 三区 */
const SPECIAL_SUBZONES = ['z1', 'z2s', 'z2b', 'z3'];

/** 号码 → 子区（z1 = 01–16，z2s = 17–24，z2b = 25–33，z3 = 34–49） */
function subzoneOf(n) {
  if (n <= 16) return 'z1';
  if (n <= 24) return 'z2s';
  if (n <= 33) return 'z2b';
  return 'z3';
}

/**
 * 12 个号的理想「分区模型」
 *
 * 三区 4:4:4 是外壳，里面还要满足大小 6:6：
 *   一区（01–16）4 个 —— 全小
 *   二区小（17–24）2 个 —— 小
 *   二区大（25–33）2 个 —— 大
 *   三区（34–49）4 个 —— 全大
 * 于是大 = 2 + 4 = 6、小 = 4 + 2 = 6，奇偶再单独按 6:6 分配。
 * 这个模型让「三区 4:4:4 + 大小 6:6 + 奇偶 6:6」可以同时成立（随机号占位后仍会算残余目标）。
 */
const SPECIAL_IDEAL_MODEL = { z1: 4, z2s: 2, z2b: 2, z3: 4 };

/** 把一组号码按子区计数 */
function countSubzones(nums) {
  const out = { z1: 0, z2s: 0, z2b: 0, z3: 0 };
  for (const n of nums) out[subzoneOf(n)]++;
  return out;
}

/**
 * 由「随机号已经占了哪些子区」推出剩下 9 个精选号的子区目标
 *
 * 理想模型减掉随机号即可；若随机号把某个子区撑爆（残余为负），
 * 就把多出来的坑位让给其他子区，保证总数仍然是 9 个。
 */
function residualModel(randomNums, size, idealModel = SPECIAL_IDEAL_MODEL) {
  const rand = countSubzones(randomNums);
  const resid = {};
  for (const z of SPECIAL_SUBZONES) resid[z] = idealModel[z] - rand[z];

  const total = () => SPECIAL_SUBZONES.reduce((a, z) => a + resid[z], 0);
  const want = size - randomNums.length;

  // 先把负数压平到 0（坑位不够就认了）
  for (const z of SPECIAL_SUBZONES) if (resid[z] < 0) resid[z] = 0;

  // 少了就补到「离理想最远」的子区；多了就从「超出最多」的子区收回
  let guard = 0;
  while (total() < want && guard++ < 60) {
    let pick = null;
    let bestGap = -Infinity;
    for (const z of SPECIAL_SUBZONES) {
      const gap = idealModel[z] - (rand[z] + resid[z]);
      if (gap > bestGap) { bestGap = gap; pick = z; }
    }
    if (!pick) break;
    resid[pick]++;
  }
  guard = 0;
  while (total() > want && guard++ < 60) {
    let pick = null;
    let worst = Infinity;
    for (const z of SPECIAL_SUBZONES) {
      const gap = idealModel[z] - (rand[z] + resid[z]);
      if (resid[z] > 0 && gap < worst) { worst = gap; pick = z; }
    }
    if (!pick) break;
    resid[pick]--;
  }
  return resid;
}

/**
 * 生成一张「风格化号码清单」（特码 12 号清单 / 三中三 7 码复式共用）
 *
 * 步骤：
 *   1. 🎲 用「期号 + 盐值」定种，49 选 N 等概率机选随机号（纯随机，不排除任何号，可重摇）
 *   2. 按「理想分区模型 − 随机号已占的子区」算出剩下几个号的子区目标
 *   3. 在每个子区里按综合分（热 / 冷 / 温号）取号，并保证奇偶合计达标、同尾最多 2 个
 *   4. 给精选号贴风格标签：最热的 🔥、最冷的 🎯、剩下 ⚖️
 *
 * 随机号先选、精选避开它 → 整张清单的号码天然互不重复，不浪费任何一注。
 * 严格无未来函数：只用严格早于目标期的历史；同一期 + 同一盐值永远得到同一张清单。
 *
 * @param {{ hot: Record<number,number>, cold: Record<number,number>, balance: Record<number,number> }} scoreMaps
 * @param {{ year?: number, periodNum?: number, randomSalt?: number, size?: number, pinnedNumbers?: number[],
 *           styles?: object[], idealModel?: object, oddTarget?: number }} [options]
 * @returns {{ numbers: number[], styles: Map<number,string>, breakdown: object[], seed: number }}
 */
export function selectCuratedList(scoreMaps, options = {}) {
  const year = Number(options.year || 2026);
  const periodNum = Number(options.periodNum || 1);
  const randomSalt = Number(options.randomSalt || 0);
  const size = Math.max(2, Math.min(49, Math.trunc(Number(options.size || 12))));
  const styleDefs = Array.isArray(options.styles) && options.styles.length ? options.styles : SPECIAL_LIST_STYLES;
  const idealModel = options.idealModel || SPECIAL_IDEAL_MODEL;
  const maxTailRepeat = Math.max(1, Math.trunc(Number(options.maxTailRepeat ?? 2)));
  const pinned = (Array.isArray(options.pinnedNumbers) ? options.pinnedNumbers : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 49);

  // 各风格的号数；总和不等于 size 时补齐 / 收缩到 balance
  const stylesPlan = styleDefs.map((st) => ({ ...st }));
  let sum = stylesPlan.reduce((a, st) => a + st.count, 0);
  stylesPlan[stylesPlan.length - 1].count += size - sum;
  if (stylesPlan[stylesPlan.length - 1].count < 0) stylesPlan[stylesPlan.length - 1].count = 0;
  sum = stylesPlan.reduce((a, st) => a + st.count, 0);
  stylesPlan[0].count += size - sum;
  const randomCount = Math.max(0, Math.min(size, stylesPlan[0].count));

  // ——— 1) 纯随机：49 选 count，等概率，不排除任何号
  const seed = seedFor(year, periodNum, randomSalt);
  const rng = mulberry32(seed);
  const randoms = shuffledNumbers(rng, randomCount).sort((a, b) => a - b);
  const taken = new Set(randoms);

  // ——— 2) 子区目标
  const resid = residualModel(randoms, size, idealModel);

  // ——— 3) 综合打分（归一化到 0~1），只为「风格」服务，不改变命中概率
  const normalizeMap = (map) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let n = 1; n <= 49; n++) {
      const v = Number(map?.[n] || 0);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo;
    const out = {};
    for (let n = 1; n <= 49; n++) {
      const v = Number(map?.[n] || 0);
      out[n] = span > 1e-12 ? (v - lo) / span : 0.5;
    }
    return out;
  };
  const hotN = normalizeMap(scoreMaps.hot);
  const coldN = normalizeMap(scoreMaps.cold);
  const balN = normalizeMap(scoreMaps.balance);
  const valueOf = (n) => 0.45 * hotN[n] + 0.30 * coldN[n] + 0.25 * balN[n]
    + deterministicJitter(year, periodNum, n, 71) * 0.06;

  // 奇偶目标：默认整张清单尽量对半（特码 6:6、7 码 4:3）
  const targetOdd = Math.max(0, Math.min(size, Math.trunc(Number(options.oddTarget ?? Math.round(size / 2)))));
  const randOdd = randoms.filter((n) => n % 2 === 1).length;
  let oddLeft = Math.max(0, Math.min(size - randoms.length, targetOdd - randOdd));

  // 需要从每个子区取几个奇数（尽量摊开，避免整段同奇偶）
  const oddQuota = { z1: 0, z2s: 0, z2b: 0, z3: 0 };
  {
    const order = SPECIAL_SUBZONES.slice().sort((a, b) => resid[b] - resid[a] || (a < b ? -1 : 1));
    let round = 0;
    while (oddLeft > 0 && round < 8) {
      let progressed = false;
      for (const z of order) {
        if (oddLeft <= 0) break;
        if (oddQuota[z] >= resid[z]) continue;
        const available = ALL_NUMBERS.filter((n) => subzoneOf(n) === z && n % 2 === 1 && !taken.has(n)).length;
        if (oddQuota[z] >= available) continue;
        oddQuota[z]++;
        oddLeft--;
        progressed = true;
      }
      if (!progressed) break;
      round++;
    }
  }

  // ——— 填充：每个子区按 (奇数个数, 偶数个数) 取最高分的号
  const tailCount = new Array(10).fill(0);
  for (const n of randoms) tailCount[n % 10]++;
  const curated = [];

  const takeFromBucket = (zone, oddWant, evenWant) => {
    const pool = ALL_NUMBERS
      .filter((n) => subzoneOf(n) === zone && !taken.has(n))
      .sort((a, b) => valueOf(b) - valueOf(a) || (a - b));
    const need = [[1, oddWant], [0, evenWant]];
    for (const [parity, count] of need) {
      let filled = 0;
      // 先挑尾数还没满 2 个的，再放宽
      for (const relax of [false, true]) {
        for (const n of pool) {
          if (filled >= count) break;
          if (taken.has(n)) continue;
          if ((n % 2 === 1 ? 1 : 0) !== parity) continue;
          if (!relax && tailCount[n % 10] >= maxTailRepeat) continue;
          taken.add(n);
          curated.push(n);
          tailCount[n % 10]++;
          filled++;
        }
      }
    }
  };

  for (const zone of SPECIAL_SUBZONES) {
    if (resid[zone] <= 0) continue;
    takeFromBucket(zone, oddQuota[zone], resid[zone] - oddQuota[zone]);
  }

  // 尾数兜底：同一个尾数最多 2 个（12 个号共 10 个尾数，必然有重复，但不能扎堆）
  // 只在**同子区 + 同奇偶**之间换号，所以换完之后三区 / 大小 / 奇偶都不会被破坏。
  // 例外：🎲 纯随机号不受约束（随机就该是随机的，否则不叫对照组）。
  for (let t = 0; t < 10; t++) {
    let guard = 0;
    while (tailCount[t] > maxTailRepeat && guard++ < 6) {
      const outIdx = curated.findIndex((n) => n % 10 === t);
      if (outIdx < 0) break;
      const out = curated[outIdx];
      const inn = ALL_NUMBERS.find((n) => !taken.has(n)
        && subzoneOf(n) === subzoneOf(out)
        && (n % 2 === 1) === (out % 2 === 1)
        && tailCount[n % 10] < maxTailRepeat);
      if (inn == null) break;
      taken.delete(out);
      taken.add(inn);
      curated[outIdx] = inn;
      tailCount[out % 10]--;
      tailCount[inn % 10]++;
    }
  }

  // 固定号码：用户指定时并入清单（替换掉分数最低的精选号）
  for (const n of pinned) {
    if (taken.has(n)) continue;
    if (curated.length >= size - randoms.length) break;
    taken.add(n);
    curated.push(n);
  }

  // ——— 4) 贴风格标签（热 / 冷 / 均衡，个数由 styles 决定）
  const hotNeed = Math.max(0, Math.min(stylesPlan[1].count, curated.length));
  const coldNeed = Math.max(0, Math.min(stylesPlan[2].count, curated.length - hotNeed));
  const byHot = curated.slice().sort((a, b) => hotN[b] - hotN[a] || a - b);
  const hotPicks = new Set(byHot.slice(0, hotNeed));
  const rest = curated.filter((n) => !hotPicks.has(n));
  const byCold = rest.slice().sort((a, b) => coldN[b] - coldN[a] || a - b);
  const coldPicks = new Set(byCold.slice(0, coldNeed));

  const styles = new Map();
  for (const n of randoms) styles.set(n, 'random');
  for (const n of curated) styles.set(n, hotPicks.has(n) ? 'hot' : coldPicks.has(n) ? 'cold' : 'balance');

  const numbers = [...taken].sort((a, b) => a - b);
  const breakdown = styleDefs.map((st) => {
    const nums = numbers.filter((n) => styles.get(n) === st.id);
    return { ...st, count: nums.length, numbers: nums };
  });

  return { numbers, styles, breakdown, seed };
}

/**
 * 特码清单（12 个号 = 12 注，三区 4:4:4 / 大小 6:6 / 奇偶 6:6）
 * @param {object} scoreMaps
 * @param {object} [options]
 */
export function selectSpecialList(scoreMaps, options = {}) {
  return selectCuratedList(scoreMaps, {
    size: 12,
    styles: SPECIAL_LIST_STYLES,
    idealModel: SPECIAL_IDEAL_MODEL,
    oddTarget: 6,
    ...options
  });
}

/**
 * 三中三 7 码复式（C(7,3) = 35 注，三区 3-2-2 / 奇偶 4:3）
 * @param {object} scoreMaps
 * @param {object} [options]
 */
export function selectPick3Set(scoreMaps, options = {}) {
  return selectCuratedList(scoreMaps, {
    size: 7,
    styles: PICK3_SET_STYLES,
    idealModel: PICK3_IDEAL_MODEL,
    oddTarget: 4,
    ...options
  });
}

/**
 * N 注号码「至少中 1 注」的精确概率（按实际号码算，允许注与注之间重复）
 *
 * 特码：命中 = 开奖特码落在这一注的 size 个号里，
 *   所以「至少中 1 注」= 开奖特码落在这 N 注号码的**并集**里 → 并集号码数 / 49（精确）。
 *
 * 三中三 / 四中四：命中 = 这一注的 size 个号全部落在 6 个正码里。
 *   记每一注的命中事件 A_t，用容斥原理：
 *     P(∪A_t) = Σ_{∅≠U⊆T} (-1)^{|U|+1} · C(49 - m_U, 6 - m_U) / C(49, 6)
 *   其中 m_U = U 里所有号码去重后的个数（6 个正码要包含 U 的并集，剩下 6 - m_U 个位置
 *   从其余 49 - m_U 个号里选；m_U > 6 时不可能命中，该项为 0）。
 *   注与注之间有重叠时，并集概率会小于「N × 单注概率」，这里如实算出来。
 *
 * @param {number[][]} tickets 每注号码
 * @param {string} [mode] 'special' / 'pick3' / 'pick4'
 * @returns {number} 0~1
 */
export function anyHitProbability(tickets = [], mode = 'pick3') {
  const spec = getPlayMode(mode);
  const size = spec.size;
  const isSpecialMode = spec.id === 'special';
  const clean = (Array.isArray(tickets) ? tickets : [])
    .map((t) => normalizeNumbers(t, { sort: true, maxCount: size }))
    .filter((t) => (isSpecialMode ? t.length > 0 : t.length === size));
  if (!clean.length) return 0;

  // 特码：每个号都是 1 注，各号互斥 → 并集号码数 / 49 是**精确值**
  if (isSpecialMode) {
    return Math.min(1, new Set(clean.flat()).size / 49);
  }

  const draws = 6;
  // 复式（一组 7 码 = C(7,3) = 35 注）：35 注用容斥要枚举 2^35，不可行。
  // 「至少中 1 注」等价于「7 个号里至少有 3 个落在 6 个正码中」，用 atLeastMatchProbability 精确算；
  // 只有 1 组时结果是精确值（页面就是这个形态），多组时用并集上界（不会高估到失控）。
  if (spec.layout === 'complex' && spec.ticketSize && spec.ticketSize < spec.size) {
    let p = 0;
    for (const t of clean) {
      if (t.length !== spec.size) continue;
      p += atLeastMatchProbability(spec.size, draws, spec.ticketSize);
    }
    return Math.min(1, p);
  }
  const total = binomial(49, draws);
  if (!(total > 0)) return 0;
  let favorable = 0;
  const n = clean.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const union = new Set();
    let bits = 0;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      bits++;
      for (const x of clean[i]) union.add(x);
    }
    const m = union.size;
    if (m > draws) continue; // 号码超过 6 个，这一组注不可能同时命中
    const ways = binomial(49 - m, draws - m);
    favorable += (bits % 2 === 1 ? 1 : -1) * ways;
  }
  const p = favorable / total;
  return Math.min(1, Math.max(0, p));
}

/**
 * 把「一组号码」展开成实际的注单
 *
 *   · 特码（ticketSize = 1）：每个号就是 1 注 → [[n1],[n2],…]
 *   · 三中三（ticketSize = 3）：7 码复式 → C(7,3) = 35 注
 *   · 四中四（ticketSize = 4）：4 码 → 1 注
 *
 * @param {number[]} numbers
 * @param {object} spec 玩法定义（PLAY_MODES 里的一项）
 * @returns {number[][]}
 */
export function expandEntryTickets(numbers = [], spec = {}) {
  const nums = normalizeNumbers(numbers, { sort: true });
  const ticketSize = Math.max(1, Math.trunc(Number(spec.ticketSize ?? spec.size ?? nums.length)));
  if (!nums.length) return [];
  if (ticketSize <= 1) return nums.map((n) => [n]);
  if (nums.length === ticketSize) return [nums];
  return combinations(nums, ticketSize);
}

/* --------------------------------------------------------------- 主入口 */

/**
 * 生成某期的「每日 5 注」
 * @param {object[]} allDraws 完整底库（降序）
 * @param {{ year?: number, periodNum?: number, date?: string }} [targetMeta]
 * @param {{ randomSalt?: number, mode?: string, pinnedNumbers?: number[] }} [options]
 *        mode: 'special' = 特码（每注 1 个号，1 中 1：命中 = 特码正好等于这个号）
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

  // ————————————————————————————————————————————————————————————————
  // 「精选清单」路径（1 张卡片，号码互不重复）：
  //   · 特码      layout = 'list'    → 12 个号 = 12 注
  //   · 三中三    layout = 'complex' → 7 个号 = C(7,3) = 35 注（7 码复式）
  // 四中四仍然走「5 组」骨架（每组 = 一注组合）。
  // ————————————————————————————————————————————————————————————————
  if (spec.layout === 'list' || spec.layout === 'complex') {
    const isComplex = spec.layout === 'complex';
    // 统计口径：特码看「作为特码出现」，三中三看「落在 6 个正码里」
    const statsTable = isSpecial ? features.specialStats : features.stats;
    const mean30 = isSpecial ? 30 / 49 : (30 * 6) / 49;
    const scoreMaps = buildSpecialScoreMaps(features, year, periodNum, statsTable, mean30);
    const picker = isComplex ? selectPick3Set : selectSpecialList;
    const list = picker(scoreMaps, {
      year,
      periodNum,
      randomSalt,
      size,
      pinnedNumbers: options.pinnedNumbers || []
    });
    const meta = catalogForMode(spec.id)[0];
    const st = features.stats;
    const hotList = list.numbers.filter((n) => statsTable[n].freq30 >= (isComplex ? 5 : 3));
    const coldList = list.numbers.filter((n) => !hotList.includes(n)
      && (statsTable[n].omission >= (isComplex ? 8 : 5) || statsTable[n].freq30 === 0));
    const odd = list.numbers.filter((n) => statsTable[n].odd).length;
    const entry = {
      ...meta,
      numbers: list.numbers,
      styles: Object.fromEntries(list.styles),
      breakdown: list.breakdown,
      killed: [],
      rationale: `${randomSalt > 0 ? `已重摇第 ${randomSalt} 次 · ` : ''}`
        + `${isComplex ? '三中三 7 码复式' : '特码'} ${list.numbers.length} 号：`
        + list.breakdown.map((b) => `${b.icon}${b.numbers.length}`).join(' / ')
        + `；整体奇偶 ${odd}:${list.numbers.length - odd}、三区 `
        + `${list.numbers.filter((n) => n <= 16).length}-${list.numbers.filter((n) => n > 16 && n <= 33).length}-`
        + `${list.numbers.filter((n) => n > 33).length}`
        + (isComplex
          ? '；7 个号把 C(7,3) = 35 个三连组合全部买下，任意 3 个落在正码里就中'
          : '；🎲 为 49 个号等概率机选（纯随机对照，可重摇），其余 9 个受全局均衡约束'),
      seed: list.seed,
      shape: {
        hot: hotList.length,
        warm: list.numbers.length - hotList.length - coldList.length,
        cold: coldList.length,
        red: list.numbers.filter((n) => st[n].color === 'red').length,
        blue: list.numbers.filter((n) => st[n].color === 'blue').length,
        green: list.numbers.filter((n) => st[n].color === 'green').length,
        zone1: list.numbers.filter((n) => n <= 16).length,
        zone2: list.numbers.filter((n) => n > 16 && n <= 33).length,
        zone3: list.numbers.filter((n) => n > 33).length,
        odd,
        even: list.numbers.length - odd,
        big: list.numbers.filter((n) => n >= 25).length,
        small: list.numbers.filter((n) => n <= 24).length,
        sum: list.numbers.reduce((a, b) => a + b, 0)
      }
    };

    const distinct = list.numbers.length;
    // 每张清单折算几注：特码 1 个号 = 1 注；三中三 7 码 = C(7,3) = 35 注
    const betsPerOption = isComplex ? combinationsCount(distinct, spec.ticketSize) : distinct;
    // 单注命中率：一注 ticketSize 个号全部落在 6 个正码里 = C(6,k) / C(49,k)
    // （复式不是把单注概率变大，而是买更多注）
    const perBet = isComplex
      ? binomial(6, spec.ticketSize) / binomial(49, spec.ticketSize)
      : 1 / 49;
    const anyHit = isComplex
      ? atLeastMatchProbability(distinct, 6, spec.ticketSize)
      : Math.min(1, distinct / 49);
    return {
      target: { year, periodNum, period: String(periodNum).padStart(3, '0'), date },
      priorSampleCount: priorDraws.length,
      featureWindow: features.sampleSize,
      randomSalt,
      mode: spec.id,
      size,
      layout: spec.layout,
      five: [entry],
      consensus: [],
      listStyles: list.breakdown,
      coverage: {
        distinct,
        overlap: 0, // 随机号先选、精选避开它 → 整张清单的号码天然互不重复
        perTicket: anyHit, // 整张清单至少中 1 注
        perBet, // 单注命中率
        betsPerOption,
        totalBets: betsPerOption,
        anyHit,
        allBlank: 1 - anyHit
      },
      stats: features.stats,
      killedNumbers: [],
      lastSpecial: isSpecial ? (features.lastSpecial ?? null) : null
    };
  }

  const scoreMaps = buildScoreMaps(features, year, periodNum);
  const selectFeatures = features;
  const pinned = normalizeNumbers(options.pinnedNumbers || [], { sort: true, maxCount: size });
  const catalog = catalogForMode(spec.id);

  // ————————————————————————————————————————————————————————————
  // #2~#5 四注精选之间互不重复：used = 精选已用掉的号码，后面每一注都把它作为硬性排除项。
  // 这样「补位覆盖」才有意义，四注精选整体也能铺开面。
  // （随机注 #1 不受此限制，见下）
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

  // #1 完全随机：**纯 49 选 size**，等概率机选，不排除任何号码。
  // 随机就应该是随机的：与精选撞号就撞号（任何 size 个号的命中概率都是同一个数）。
  // 仍按期号 + 盐值定种，保证同一期可复现、可重摇。
  const rng = mulberry32(seedFor(year, periodNum, randomSalt));
  picks.set('random', shuffledNumbers(rng, size).sort((a, b) => a - b));

  const entries = catalog.map((meta) => ({
    ...meta,
    numbers: picks.get(meta.id) || [],
    killed: [],
    rationale: meta.id === 'random'
      ? `${randomSalt > 0 ? `已重摇第 ${randomSalt} 次 · ` : ''}49 个号等概率机选（允许与精选重复）`
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

  // 覆盖面：按 5 注的**实际号码**算，随机注可能与精选重复，所以并集可能少于 5×size。
  const covered = new Set(entries.flatMap((e) => e.numbers));
  // perTicket = 每个选项至少中 1 注的概率（特码 = 3 个号 × 1/49；直选 = 组合概率）
  const perTicket = isSpecial ? size / 49 : binomial(6, size) / binomial(49, size);
  const anyHit = anyHitProbability(entries.map((e) => e.numbers), spec.id);
  const betsPerOption = betsPerTicket(spec.id);
  const totalBets = betsPerOption * entries.length;

  return {
    target: { year, periodNum, period: String(periodNum).padStart(3, '0'), date },
    priorSampleCount: priorDraws.length,
    featureWindow: features.sampleSize,
    randomSalt,
    mode: spec.id,
    size,
    five: entries,
    consensus: [], // 取消共识号展示
    coverage: {
      distinct: covered.size,
      overlap: size * entries.length - covered.size, // 随机注与精选撞上的号码个数
      perTicket, // 每个选项至少中 1 注
      perBet: isSpecial ? 1 / 49 : perTicket, // 单注（特码 = 单个号码）
      betsPerOption, // 每个选项折算成几注（特码 3）
      totalBets, // 本期总注数（特码 15）
      anyHit,
      allBlank: 1 - anyHit
    },
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
  const { stake = 10, odds3 = 650, odds4 = 7500, oddsSpecial = 48, randomSalt = 0 } = options;
  const spec = getPlayMode(options.mode);
  const size = spec.size;
  const records = [];
  for (const draw of targets) {
    if (!draw) continue;
    const plan = generateDailyFive(allDraws, { year: draw.year, periodNum: draw.periodNum, date: draw.date }, { randomSalt, mode: spec.id });
    const five = plan.five.map((e) => {
      // 复式：一组号码要展开成 C(size, ticketSize) 注分别结算（7 码 → 35 注）
      const tickets = expandEntryTickets(e.numbers, spec);
      const ev = evaluateTickets(tickets, draw, {
        stake,
        odds3,
        odds4,
        oddsSpecial,
        playMode: spec.id,
        targetSize: spec.ticketSize || size
      });
      const winners = ev.winningTickets || [];
      const normalsHit = new Set();
      for (const d of ev.details || []) for (const n of d.hitNums || []) normalsHit.add(n);
      return {
        id: e.id,
        code: e.code,
        name: e.name,
        icon: e.icon,
        random: !!e.random,
        numbers: e.numbers,
        styles: e.styles || null,
        breakdown: e.breakdown || null,
        layout: e.layout || spec.layout || 'groups',
        // 命中注数：特码 = 中了的号码个数；复式 = 中了的组合数；直选 = 0/1
        hitNums: winners.length ? [...normalsHit] : [],
        hitCount: winners.length,
        isWin: winners.length > 0,
        payout: ev.payout || 0,
        bets: tickets.length,
        winningTickets: winners.length,
        matchedNormals: [...normalsHit],
        matchedNormalCount: normalsHit.size
      };
    });
    records.push({ draw, five, consensus: plan.consensus, size, mode: spec.id, ticketSize: spec.ticketSize, betsPerEntry: plan.coverage?.betsPerOption });
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
  // 自选就是「1 注号码」：
  //   特码     → 1 中 1，允许 1 ~ size 个号（每个号 1 注）
  //   复式     → 正好 ticketSize 个号（只买这 1 注，不自动展开成 35 注）
  //   直选分组 → 正好 size 个号
  const picks = normalizeNumbers(options.customNumbers || [], { sort: true });
  const expected = spec.layout === 'complex' ? (spec.ticketSize || size) : size;
  if (spec.id === 'special') {
    if (picks.length < 1 || picks.length > size) return [];
  } else if (picks.length !== expected) {
    return [];
  }

  const records = [];
  for (const draw of targets) {
    if (!draw) continue;
    const ev = evaluateTickets([picks], draw, { stake, odds3, odds4, oddsSpecial, playMode: spec.id, targetSize: expected });
    const detail = ev.details[0] || { hitNums: [], hitCount: 0, isWin: false, payout: 0 };
    records.push({
      draw,
      consensus: [],
      size,
      mode: spec.id,
      five: [{
        id: 'custom',
        code: '自选',
        name: `当前自选 ${picks.length} 码`,
        icon: '✍️',
        random: false,
        numbers: picks,
        hitNums: detail.hitNums,
        hitCount: detail.hitCount,
        isWin: detail.isWin,
        payout: detail.payout,
        matchedNormals: detail.hitNums,
        matchedNormalCount: detail.hitCount,
        // 注数：特码 1 中 1（N 个号 = N 注）；三中三 / 四中四自选就是 1 注
        bets: spec.id === 'special' ? picks.length : 1
      }]
    });
  }
  return records;
}

/**
 * 汇总 5 注的表现
 *
 * 每注就是 1 注投注；成本 = 期数 × 单注本金；返奖 = 命中期数 × 单注本金 × 赔率。
 *  - 特码玩法：命中 = 开奖特码正好等于这 1 个号（1 中 1）
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

  const betsPerOption = betsPerTicket(spec.id);
  const catalog = catalogForMode(spec.id).map((m) => ({
    ...m,
    periods: 0,
    hitSum: 0,
    winPeriods: 0,
    bets: 0,
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
      bets: 0,
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
      // 注数：优先用记录里算好的实际注数（复式 35 注 / 特码 12 注 / 自选按实际号码个数）
      const betsThis = Number.isFinite(e.bets) && e.bets > 0
        ? e.bets
        : (spec.id === 'special'
          ? Math.max(1, (e.numbers || []).length)
          : betsPerOption);
      agg.bets += betsThis;
      agg.cost += stake * betsThis;
      agg.payout += e.payout || 0;
    }
  }

  for (const agg of catalog) {
    agg.avgHits = agg.periods ? Number((agg.hitSum / agg.periods).toFixed(3)) : 0;
    agg.net = agg.payout - agg.cost;
    agg.roi = agg.cost > 0 ? Number(((agg.net / agg.cost) * 100).toFixed(2)) : 0;
    agg.winRate = agg.periods ? Number(((agg.winPeriods / agg.periods) * 100).toFixed(3)) : 0;
    agg.avgBets = agg.periods ? Number((agg.bets / agg.periods).toFixed(2)) : 0;
  }

  const totalCost = catalog.reduce((a, c) => a + c.cost, 0);
  const totalPayout = catalog.reduce((a, c) => a + c.payout, 0);
  return {
    size,
    betsPerOption,
    totalBets: catalog.reduce((a, c) => a + c.bets, 0),
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
