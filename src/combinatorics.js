/**
 * 组合数学与「直选 · 三中三 / 四中四」命中核对与收益计算引擎
 * 严格遵循传统连码规则：仅核对开出的前 6 个正码（平一～平六），特码不计入三中三/四中四命中
 *
 * 直选口径：一张注单 = size 个号码（3 = 三中三，4 = 四中四），
 * 这 size 个号码**全部**落在 6 个正码里才算命中，返奖 = 本金 × 赔率。
 *
 * 特码口径（1 中 1）：**1 个号码 = 1 注**。开奖的**最后一个号码（特码）**等于注里的某个号码，
 * 那个号码就中，返奖 = 命中号码个数 × 本金 × 特码赔率（市面常见 48 倍）；
 * 6 个正码不参与特码玩法的判定。一个选项给几个号就是几注（本工具每组 3 个号 = 3 注）。
 */

import { DEFAULT_CONFIG } from './constants.js';

/**
 * 计算组合数 C(n, k)
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
export function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const m = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= m; i++) {
    result = Math.round((result * (n - m + i)) / i);
  }
  return result;
}

/**
 * 「选的号里至少有 need 个被抽中」的概率（超几何分布，精确值）
 *
 * 用于 7 码复式：选出 7 个号、开奖抽出 6 个正码，
 * 7 个号里至少 3 个被抽中 → 至少有一注三中三命中。
 *   1 - P(k ≤ 2) = 3.095%
 *
 * @param {number} selected 自己选的号码个数（7）
 * @param {number} [drawn=6] 开奖抽出的号码个数（6 个正码）
 * @param {number} [need=3] 每注需要几个号（三中三 = 3，四中四 = 4）
 * @param {number} [population=49] 号码池
 * @returns {number} 0~1
 */
export function atLeastMatchProbability(selected, drawn = 6, need = 3, population = 49) {
  const sel = Math.trunc(Number(selected));
  const drew = Math.trunc(Number(drawn));
  const k0 = Math.trunc(Number(need));
  const pop = Math.trunc(Number(population));
  if (!(sel > 0) || !(drew > 0) || !(pop > 0) || k0 > Math.min(sel, drew)) return 0;
  const total = binomial(pop, drew);
  if (!(total > 0)) return 0;
  let favorable = 0;
  for (let k = Math.max(0, k0); k <= Math.min(sel, drew); k++) {
    favorable += binomial(sel, k) * binomial(pop - sel, drew - k);
  }
  return Math.min(1, favorable / total);
}

/**
 * 生成数组的所有 C(n, k) 组合（字典序升序）
 * @template T
 * @param {T[]} items
 * @param {number} k
 * @returns {T[][]}
 */
export function combinations(items, k) {
  const arr = Array.isArray(items) ? items.slice() : [];
  const n = arr.length;
  if (k <= 0 || k > n) return [];
  const results = [];
  const current = new Array(k);

  function backtrack(start, depth) {
    if (depth === k) {
      results.push(current.slice());
      return;
    }
    const maxStart = n - (k - depth);
    for (let i = start; i <= maxStart; i++) {
      current[depth] = arr[i];
      backtrack(i + 1, depth + 1);
    }
  }

  backtrack(0, 0);
  return results;
}

/**
 * 清洗并规范化号码列表（1..49 整数、去重、可选排序）
 * @param {Array<number|string>} rawNums
 * @param {{ sort?: boolean, maxCount?: number }} [options]
 * @returns {number[]}
 */
export function normalizeNumbers(rawNums, options = {}) {
  const { sort = true, maxCount = 49 } = options;
  if (!Array.isArray(rawNums)) return [];
  const seen = new Set();
  const out = [];
  for (const item of rawNums) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= 49 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
      if (out.length >= maxCount) break;
    }
  }
  if (sort) {
    out.sort((a, b) => a - b);
  }
  return out;
}

/**
 * 提取某期开奖的正码集合（严格仅取前 6 个正码：平一～平六）
 * @param {{ numbers?: Array<number|string>, special?: number|string } | Array<number|string>} draw
 * @returns {{ normalList: number[], normalSet: Set<number>, special: number|null }}
 */
export function extractDrawNormals(draw) {
  if (!draw) {
    return { normalList: [], normalSet: new Set(), special: null };
  }
  const rawNormals = Array.isArray(draw)
    ? draw.slice(0, 6)
    : Array.isArray(draw.numbers)
      ? draw.numbers.slice(0, 6)
      : [];
  const normalList = [];
  const normalSet = new Set();
  for (const item of rawNormals) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= 49) {
      normalList.push(n);
      normalSet.add(n);
    }
  }
  const rawSpecial = !Array.isArray(draw) && draw.special != null ? Number(draw.special) : null;
  const special = Number.isInteger(rawSpecial) && rawSpecial >= 1 && rawSpecial <= 49 ? rawSpecial : null;
  return { normalList, normalSet, special };
}

/**
 * 核对一组直选注单（例如每期推荐的 5 注三中三组合 或 5 注四中四组合）
 * 严格仅按前 6 个正码核对命中
 *
 * @param {Array<Array<number|string>>} tickets 直选组合数组（每注 3 个或 4 个号码）
 * @param {{ numbers: number[], special?: number } | null} draw 开奖结果
 * @param {{ stake?: number, odds3?: number, odds4?: number, targetSize?: 3|4 }} [userConfig]
 */
export function evaluateDirectTickets(tickets, draw, userConfig = {}) {
  const stake = Math.max(0, Number(userConfig.stake ?? DEFAULT_CONFIG.stake));
  const odds3 = Math.max(0, Number(userConfig.odds3 ?? DEFAULT_CONFIG.odds3));
  const odds4 = Math.max(0, Number(userConfig.odds4 ?? DEFAULT_CONFIG.odds4));

  const { normalList, normalSet, special } = extractDrawNormals(draw);
  const hasDraw = normalList.length > 0;

  const normalizedTickets = (Array.isArray(tickets) ? tickets : [])
    .map((t) => normalizeNumbers(t, { sort: true }))
    .filter((t) => t.length === 3 || t.length === 4);

  const targetSize = userConfig.targetSize || (normalizedTickets[0]?.length ?? 3);
  const odds = targetSize === 4 ? odds4 : odds3;

  const details = normalizedTickets.map((nums, idx) => {
    const hitNums = hasDraw ? nums.filter((n) => normalSet.has(n)) : [];
    const isWin = hasDraw && hitNums.length === nums.length;
    return {
      index: idx + 1,
      nums,
      hitNums,
      hitCount: hitNums.length,
      isWin,
      payout: isWin ? stake * odds : 0
    };
  });

  const winningTickets = details.filter((d) => d.isWin);
  const totalBets = details.length;
  const winCount = winningTickets.length;
  const cost = totalBets * stake;
  const payout = hasDraw ? winCount * stake * odds : 0;
  const netProfit = hasDraw ? payout - cost : 0;
  const roi = hasDraw && cost > 0 ? Number(((netProfit / cost) * 100).toFixed(2)) : 0;

  return {
    targetSize,
    hasDraw,
    normalList,
    special,
    totalBets,
    winCount,
    cost,
    payout,
    netProfit,
    roi,
    stake,
    odds,
    details,
    winningTickets
  };
}

/**
 * 核对一组「特码」注单（1 中 1：**1 个号码 = 1 注**）
 *
 * 命中规则：开奖的最后一个号码（特码）等于注里的某个号码，那个号码就中；
 * 6 个正码不参与判定。一个选项给了几个号就是几注，中几个号就返几份：
 *   成本 = 号码个数 × 本金
 *   返奖 = 命中号码个数 × 本金 × 赔率
 *
 * @param {Array<Array<number|string>>} tickets 每个选项一组号码（1~N 个号，每个号 1 注）
 * @param {{ numbers?: number[], special?: number } | null} draw 开奖结果
 * @param {{ stake?: number, oddsSpecial?: number, targetSize?: number }} [userConfig]
 *        targetSize：每个选项最多几个号（默认不截断，按传入号码算）
 */
export function evaluateSpecialTickets(tickets, draw, userConfig = {}) {
  const stake = Math.max(0, Number(userConfig.stake ?? DEFAULT_CONFIG.stake));
  const odds = Math.max(0, Number(userConfig.oddsSpecial ?? DEFAULT_CONFIG.oddsSpecial ?? 48));
  const rawSize = Math.trunc(Number(userConfig.targetSize ?? userConfig.size ?? 0));
  const maxSize = rawSize > 0 ? Math.min(49, rawSize) : 49;

  const { normalList, special } = extractDrawNormals(draw);
  const hasSpecial = Number.isInteger(special) && special >= 1 && special <= 49;

  // 关键：不再按「每注 5 个号」过滤。每个号码都是独立的一注，号码个数 = 注数。
  const normalizedTickets = (Array.isArray(tickets) ? tickets : [])
    .map((t) => normalizeNumbers(t, { sort: true, maxCount: maxSize }))
    .filter((t) => t.length > 0);

  const details = normalizedTickets.map((nums, idx) => {
    const hitNums = hasSpecial && nums.includes(special) ? [special] : [];
    const hitCount = hitNums.length;
    const bets = nums.length;
    return {
      index: idx + 1,
      nums,
      bets, // 这一组折算成几注（特码：号码个数）
      hitNums,
      hitCount, // 中了几注（特码：中了的号码个数）
      isWin: hitCount > 0,
      cost: bets * stake,
      payout: hitCount * stake * odds
    };
  });

  const winningTickets = details.filter((d) => d.isWin);
  const totalBets = details.reduce((sum, d) => sum + d.bets, 0);
  const winCount = details.reduce((sum, d) => sum + d.hitCount, 0);
  const cost = totalBets * stake;
  const payout = hasSpecial ? winCount * stake * odds : 0;
  const netProfit = hasSpecial ? payout - cost : 0;
  const roi = hasSpecial && cost > 0 ? Number(((netProfit / cost) * 100).toFixed(2)) : 0;

  return {
    targetSize: maxSize,
    playMode: 'special',
    hasDraw: hasSpecial,
    hasSpecial,
    normalList,
    special,
    totalBets,
    winCount,
    cost,
    payout,
    netProfit,
    roi,
    stake,
    odds,
    details,
    winningTickets
  };
}

/**
 * 按玩法分发的注单核对
 *
 *  - playMode = 'special' → 特码口径（1 个号码 = 1 注，号等于开奖特码即中该注）
 *  - 其余（pick3 / pick4）→ 直选口径（号码全部落在 6 个正码里）
 *
 * @param {Array<Array<number|string>>} tickets
 * @param {object|null} draw
 * @param {{ stake?: number, odds3?: number, odds4?: number, oddsSpecial?: number, playMode?: string, targetSize?: number }} [userConfig]
 */
export function evaluateTickets(tickets, draw, userConfig = {}) {
  const mode = String(userConfig.playMode || '').trim();
  if (mode === 'special') return evaluateSpecialTickets(tickets, draw, userConfig);
  return evaluateDirectTickets(tickets, draw, userConfig);
}
