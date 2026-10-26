/**
 * 组合数学与「直选 · 三中三 / 四中四」命中核对与收益计算引擎
 * 严格遵循传统连码规则：仅核对开出的前 6 个正码（平一～平六），特码不计入三中三/四中四命中
 *
 * 直选口径：一张注单 = size 个号码（3 = 三中三，4 = 四中四），
 * 这 size 个号码**全部**落在 6 个正码里才算命中，返奖 = 本金 × 赔率。
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
