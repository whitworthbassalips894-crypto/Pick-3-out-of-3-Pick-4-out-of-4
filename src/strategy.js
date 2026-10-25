/**
 * 六合彩「7码复式 · 三中三 / 四中四」公共推荐件
 *
 * 说明：早期的 S1~S5 五组策略已下线，改为「每日 5 注」模式
 *      （1 注纯随机 + 4 注精选），具体引擎见 src/dailyfive.js。
 *      本模块只保留与策略无关的公共能力：
 *        - getPriorDraws：取严格早于目标期的历史（无未来函数的地基）
 *        - selectFeaturedCombinations：从 7 码里挑 5 注三中三 / 5 注四中四
 *        - selectBalanced7Numbers：按分数选 7 码（带区间/波色/奇偶平衡）
 */

import { ALL_NUMBERS } from './constants.js';
import { combinations, normalizeNumbers } from './combinatorics.js';

/**
 * 过滤出严格早于目标期号的历史开奖记录（假设 draws 按时间降序排列，最新在前）
 * @param {object[]} allDraws
 * @param {{ year: number, periodNum: number }} target
 * @returns {object[]}
 */
export function getPriorDraws(allDraws, target) {
  if (!Array.isArray(allDraws) || allDraws.length === 0) return [];
  const tYear = Number(target?.year || 2026);
  const tPeriod = Number(target?.periodNum || 999);

  const prior = [];
  for (let i = 0; i < allDraws.length; i++) {
    const d = allDraws[i];
    if (d.year < tYear || (d.year === tYear && d.periodNum < tPeriod)) {
      prior.push(d);
    }
  }
  return prior;
}

/**
 * 在保证三区/波色/奇偶相对均衡的前提下，从候选评分中选出 7 个号码
 * @param {Record<number, number>} scoreMap
 * @param {{ stats: Record<number, object>, pairCount: Uint16Array[] }} features
 * @param {{ pinned?: number[], quota?: boolean, usedElsewhere?: Set<number> }} [opts]
 * @returns {number[]}
 */
export function selectBalanced7Numbers(scoreMap, features, opts = {}) {
  const { stats, pairCount } = features;
  const { quota = false, usedElsewhere = new Set() } = opts;
  const chosen = normalizeNumbers(opts.pinned || [], { sort: false, maxCount: 7 });
  const chosenSet = new Set(chosen);
  const candidates = ALL_NUMBERS.filter((n) => !chosenSet.has(n)).sort(
    (a, b) => scoreMap[b] - scoreMap[a]
  );

  while (chosen.length < 7 && candidates.length > 0) {
    const zoneCounts = { 1: 0, 2: 0, 3: 0 };
    const colorCounts = { red: 0, blue: 0, green: 0 };
    let oddCount = 0;
    for (const c of chosen) {
      zoneCounts[stats[c].zone]++;
      colorCounts[stats[c].color]++;
      if (stats[c].odd) oddCount++;
    }

    let bestIdx = 0;
    let bestDynamicScore = -Infinity;

    const searchLimit = Math.min(candidates.length, 24);
    for (let i = 0; i < searchLimit; i++) {
      const cand = candidates[i];
      const st = stats[cand];
      let dynScore = scoreMap[cand];

      // 与已选号码的历史共现加分
      let pairBonus = 0;
      for (const c of chosen) {
        pairBonus += pairCount[cand][c] * 0.4;
      }
      dynScore += pairBonus;

      // 同尾 / 连号协同
      if (chosen.length >= 2) {
        if (chosen.some((c) => c % 10 === st.tail)) dynScore += 0.55;
        if (chosen.some((c) => Math.abs(c - cand) === 1)) dynScore += 0.45;
      }

      // 区间均衡奖励（避免 7 个号全挤在同一区）
      if (zoneCounts[st.zone] === 0) dynScore += 1.3;
      else if (zoneCounts[st.zone] >= 3) dynScore -= 1.7;

      // 波色均衡奖励（避免单一波色超过 3 个）
      if (colorCounts[st.color] === 0) dynScore += 1.0;
      else if (colorCounts[st.color] >= 3) dynScore -= 1.4;

      // 奇偶均衡
      if (oddCount >= 5) dynScore -= st.odd ? 0.9 : 0;
      if (oddCount <= 1) dynScore += st.odd ? 0.9 : 0;

      // 等隔韵律：间距接近时小幅加分
      if (chosen.length >= 3) {
        const gaps = chosen.map((c) => Math.abs(c - cand)).filter((g) => g > 0).sort((a, b) => a - b);
        if (gaps.length) {
          const med = gaps[Math.floor(gaps.length / 2)];
          if (med >= 2 && Math.abs(med - 4) <= 2) dynScore += 0.35;
        }
      }

      // 跨注去重
      if (usedElsewhere.has(cand)) dynScore -= 0.9;

      if (quota) {
        const zoneQuota = { 1: 3, 2: 2, 3: 2 };
        if (zoneCounts[st.zone] < zoneQuota[st.zone]) dynScore += 0.8;
        if (oddCount < 4 && st.odd) dynScore += 0.5;
      }

      if (dynScore > bestDynamicScore) {
        bestDynamicScore = dynScore;
        bestIdx = i;
      }
    }

    const picked = candidates.splice(bestIdx, 1)[0];
    chosen.push(picked);
    chosenSet.add(picked);
  }

  return chosen.sort((a, b) => a - b);
}

/**
 * 从 7 码复式（共 35 注三中三、35 注四中四）中优选出得分最高的 5 注三中三与 5 注四中四
 * @param {Array<number|string>} sevenNumbers
 * @param {Record<number, number>} scoreMap
 * @param {Uint16Array[]} [pairCount]
 * @returns {{ top5Pick3: number[][], top5Pick4: number[][] }}
 */
export function selectFeaturedCombinations(sevenNumbers, scoreMap, pairCount) {
  const nums = normalizeNumbers(sevenNumbers, { sort: true, maxCount: 7 });
  const all3 = combinations(nums, 3);
  const all4 = combinations(nums, 4);

  const scored3 = all3
    .map((triplet) => {
      const [a, b, c] = triplet;
      const base = (scoreMap[a] || 1) + (scoreMap[b] || 1) + (scoreMap[c] || 1);
      const synergy =
        ((pairCount?.[a]?.[b] || 0) + (pairCount?.[a]?.[c] || 0) + (pairCount?.[b]?.[c] || 0)) *
        0.8;
      // 区间跨度奖励：覆盖至少 2 个区间
      const zones = new Set([
        a <= 16 ? 1 : a <= 33 ? 2 : 3,
        b <= 16 ? 1 : b <= 33 ? 2 : 3,
        c <= 16 ? 1 : c <= 33 ? 2 : 3
      ]).size;
      return {
        nums: triplet,
        score: Number((base + synergy + zones * 0.9).toFixed(2))
      };
    })
    .sort((x, y) => y.score - x.score);

  // 挑选前 5 注三中三（兼顾号码覆盖度，避免 5 注全围绕同 2 个号）
  const top5Pick3 = [];
  const usedCount3 = {};
  for (const item of scored3) {
    if (top5Pick3.length >= 5) break;
    const overloaded = item.nums.some((n) => (usedCount3[n] || 0) >= 3);
    if (!overloaded || scored3.length <= 5) {
      top5Pick3.push(item.nums);
      item.nums.forEach((n) => {
        usedCount3[n] = (usedCount3[n] || 0) + 1;
      });
    }
  }
  for (const item of scored3) {
    if (top5Pick3.length >= 5) break;
    const key = item.nums.join(',');
    if (!top5Pick3.some((t) => t.join(',') === key)) {
      top5Pick3.push(item.nums);
    }
  }

  const scored4 = all4
    .map((quad) => {
      const [a, b, c, d] = quad;
      const base =
        (scoreMap[a] || 1) + (scoreMap[b] || 1) + (scoreMap[c] || 1) + (scoreMap[d] || 1);
      const synergy =
        ((pairCount?.[a]?.[b] || 0) +
          (pairCount?.[a]?.[c] || 0) +
          (pairCount?.[a]?.[d] || 0) +
          (pairCount?.[b]?.[c] || 0) +
          (pairCount?.[b]?.[d] || 0) +
          (pairCount?.[c]?.[d] || 0)) *
        0.65;
      return {
        nums: quad,
        score: Number((base + synergy).toFixed(2))
      };
    })
    .sort((x, y) => y.score - x.score);

  const top5Pick4 = [];
  const usedCount4 = {};
  for (const item of scored4) {
    if (top5Pick4.length >= 5) break;
    const overloaded = item.nums.some((n) => (usedCount4[n] || 0) >= 3);
    if (!overloaded || scored4.length <= 5) {
      top5Pick4.push(item.nums);
      item.nums.forEach((n) => {
        usedCount4[n] = (usedCount4[n] || 0) + 1;
      });
    }
  }
  for (const item of scored4) {
    if (top5Pick4.length >= 5) break;
    const key = item.nums.join(',');
    if (!top5Pick4.some((t) => t.join(',') === key)) {
      top5Pick4.push(item.nums);
    }
  }

  return {
    top5Pick3,
    top5Pick4
  };
}
