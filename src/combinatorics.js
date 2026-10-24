/**
 * 组合数学与「7码复式 · 三中三 / 四中四」命中核对与收益计算引擎
 * 严格遵循传统连码规则：仅核对开出的前 6 个正码（平一～平六），特码不计入三中三/四中四命中
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
 * 命中分类：7 码中命中 k 个正码时的三中三 / 四中四命中结论与注数
 *
 * 规则（传统连码）：
 *   - 三中三：k >= 3 命中，注数 C(k, 3)
 *   - 四中四：k >= 4 命中，注数 C(k, 4)
 *   - 特码不参与判定
 *
 * @param {number} k 命中正码个数
 * @returns {{k: number, pick3: {isHit: boolean, betCount: number, required: number}, pick4: {isHit: boolean, betCount: number, required: number}}}
 */
export function classifyHitCount(k) {
  const kk = Math.max(0, Math.min(6, Math.trunc(Number(k) || 0)));
  return {
    k: kk,
    pick3: { isHit: kk >= 3, betCount: binomial(kk, 3), required: 3 },
    pick4: { isHit: kk >= 4, betCount: binomial(kk, 4), required: 4 }
  };
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
 * 计算单期「7码复式」（或任意 N 码复式，N>=4）在指定开奖下的三中三 & 四中四命中明细与收益统计
 * 严格仅按前 6 个正码核对命中
 *
 * @param {Array<number|string>} pickedNumbers 选号列表（标准为 7 个号码）
 * @param {{ numbers: number[], special?: number } | null} draw 开奖结果
 * @param {{ stake?: number, odds3?: number, odds4?: number }} [userConfig]
 */
export function evaluate7CodeCompound(pickedNumbers, draw, userConfig = {}) {
  const stake = Math.max(0, Number(userConfig.stake ?? DEFAULT_CONFIG.stake));
  const odds3 = Math.max(0, Number(userConfig.odds3 ?? DEFAULT_CONFIG.odds3));
  const odds4 = Math.max(0, Number(userConfig.odds4 ?? DEFAULT_CONFIG.odds4));

  const picks = normalizeNumbers(pickedNumbers, { sort: true, maxCount: 15 });
  const { normalList, normalSet, special } = extractDrawNormals(draw);
  const hasDraw = normalList.length > 0;

  // 命中的正码列表（严格不含特码）
  const matchedNormals = hasDraw ? picks.filter((n) => normalSet.has(n)) : [];
  const k = matchedNormals.length;

  // 特码是否出现在选号中（仅做提示，绝不计入三中三/四中四命中）
  const specialMatched = Boolean(hasDraw && special != null && picks.includes(special) && !normalSet.has(special));

  // 展开全部三中三组合 C(m, 3)（当 m=7 时共 35 注）
  const rawCombos3 = combinations(picks, 3);
  const combos3 = rawCombos3.map((nums, idx) => {
    const hitNums = hasDraw ? nums.filter((n) => normalSet.has(n)) : [];
    const isWin = hasDraw && hitNums.length === 3;
    return {
      index: idx + 1,
      nums,
      hitNums,
      hitCount: hitNums.length,
      isWin
    };
  });
  const winningCombos3 = combos3.filter((c) => c.isWin);

  // 展开全部四中四组合 C(m, 4)（当 m=7 时共 35 注）
  const rawCombos4 = combinations(picks, 4);
  const combos4 = rawCombos4.map((nums, idx) => {
    const hitNums = hasDraw ? nums.filter((n) => normalSet.has(n)) : [];
    const isWin = hasDraw && hitNums.length === 4;
    return {
      index: idx + 1,
      nums,
      hitNums,
      hitCount: hitNums.length,
      isWin
    };
  });
  const winningCombos4 = combos4.filter((c) => c.isWin);

  // 数学公式校验：三中三命中组数 = C(k, 3)，四中四命中组数 = C(k, 4)
  const totalBets3 = combos3.length; // 7码复式为 35 注
  const winCount3 = winningCombos3.length; // 等同于 binomial(k, 3)
  const cost3 = totalBets3 * stake;
  const payout3 = hasDraw ? winCount3 * stake * odds3 : 0;
  const netProfit3 = hasDraw ? payout3 - cost3 : 0;
  const roi3 = hasDraw && cost3 > 0 ? Number(((netProfit3 / cost3) * 100).toFixed(2)) : 0;

  const totalBets4 = combos4.length; // 7码复式为 35 注
  const winCount4 = winningCombos4.length; // 等同于 binomial(k, 4)
  const cost4 = totalBets4 * stake;
  const payout4 = hasDraw ? winCount4 * stake * odds4 : 0;
  const netProfit4 = hasDraw ? payout4 - cost4 : 0;
  const roi4 = hasDraw && cost4 > 0 ? Number(((netProfit4 / cost4) * 100).toFixed(2)) : 0;

  return {
    picks,
    hasDraw,
    normalList,
    special,
    matchedNormals,
    matchedNormalCount: k,
    specialMatched,
    stake,
    odds3,
    odds4,
    pick3: {
      totalBets: totalBets3,
      winCount: winCount3,
      expectedFormulaCount: binomial(k, 3),
      cost: cost3,
      payout: payout3,
      netProfit: netProfit3,
      roi: roi3,
      combos: combos3,
      winningCombos: winningCombos3
    },
    pick4: {
      totalBets: totalBets4,
      winCount: winCount4,
      expectedFormulaCount: binomial(k, 4),
      cost: cost4,
      payout: payout4,
      netProfit: netProfit4,
      roi: roi4,
      combos: combos4,
      winningCombos: winningCombos4
    }
  };
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
