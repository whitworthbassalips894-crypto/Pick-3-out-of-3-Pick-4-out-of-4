/**
 * 六合彩「直选 · 三中三 / 四中四」公共推荐件
 *
 * 说明：选号模型为「每日 5 注」直选（1 注纯随机 + 4 注精选），每注就是
 *      3 个号码（三中三）或 4 个号码（四中四），具体引擎见 src/dailyfive.js。
 *      本模块只保留与策略无关的公共能力：
 *        - getPriorDraws：取严格早于目标期的历史（无未来函数的地基）
 *        - selectDirectNumbers：按分数直选 N 个号码（带三区/波色/奇偶平衡）
 */

import { ALL_NUMBERS } from './constants.js';
import { normalizeNumbers } from './combinatorics.js';

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
 * 在保证三区/波色/奇偶相对均衡的前提下，从候选评分中直选 N 个号码
 *
 * 直选模型（size = 3 → 三中三，size = 4 → 四中四）：
 *   - 每注只推 size 个号码，命中判定 = 这 size 个号全部落在 6 个正码里；
 *   - size = 3 时尽量做到三区 1-1-1；size = 4 时做到 2-1-1；
 *   - 奇偶尽量接近对半、波色不集中在单一颜色。
 *
 * @param {Record<number, number>} scoreMap 号码 → 策略分数
 * @param {{ stats: Record<number, object>, pairCount: Uint16Array[] }} features
 * @param {{ size?: number, pinned?: number[], quota?: boolean, usedElsewhere?: Set<number> }} [opts]
 * @returns {number[]} 升序排列的号码
 */
export function selectDirectNumbers(scoreMap, features, opts = {}) {
  const { stats = {}, pairCount } = features || {};
  // 特征缺失时用中性兜底，避免页面因数据不全而崩
  const statOf = (n) => stats[n] || {
    num: n,
    color: 'red',
    zone: n <= 16 ? 1 : n <= 33 ? 2 : 3,
    odd: n % 2 === 1,
    tail: n % 10
  };
  const size = Math.max(2, Math.min(6, Math.trunc(Number(opts.size ?? 3))));
  const { quota = false, usedElsewhere = new Set() } = opts;

  // 每注允许的同区/同色上限：3 码注不许两码同区，4 码注最多两码同区
  const maxPerZone = size <= 3 ? 1 : 2;
  const maxPerColor = size <= 3 ? 1 : 2;

  const chosen = normalizeNumbers(opts.pinned || [], { sort: false, maxCount: size });
  const chosenSet = new Set(chosen);
  const candidates = ALL_NUMBERS.filter((n) => !chosenSet.has(n)).sort(
    (a, b) => (scoreMap[b] || 0) - (scoreMap[a] || 0)
  );

  while (chosen.length < size && candidates.length > 0) {
    const zoneCounts = { 1: 0, 2: 0, 3: 0 };
    const colorCounts = { red: 0, blue: 0, green: 0 };
    let oddCount = 0;
    for (const c of chosen) {
      const st = statOf(c);
      zoneCounts[st.zone]++;
      colorCounts[st.color]++;
      if (st.odd) oddCount++;
    }

    let bestIdx = 0;
    let bestDynamicScore = -Infinity;

    const searchLimit = Math.min(candidates.length, 24);
    for (let i = 0; i < searchLimit; i++) {
      const cand = candidates[i];
      const st = statOf(cand);
      let dynScore = scoreMap[cand] || 0;

      // 与已选号码的历史共现加分
      if (chosen.length >= 1) {
        for (const c of chosen) dynScore += (pairCount?.[cand]?.[c] || 0) * 0.35;
      }
      // 同尾 / 连号协同
      if (chosen.length >= 2) {
        if (chosen.some((c) => c % 10 === st.tail)) dynScore += 0.4;
        if (chosen.some((c) => Math.abs(c - cand) === 1)) dynScore += 0.35;
      }

      // 三区均衡：空区加分，超限减分（3 码注自然收敛成 1-1-1）
      if (zoneCounts[st.zone] === 0) dynScore += 1.1;
      else if (zoneCounts[st.zone] >= maxPerZone) dynScore -= 1.8;

      // 波色均衡
      if (colorCounts[st.color] === 0) dynScore += 0.7;
      else if (colorCounts[st.color] >= maxPerColor) dynScore -= 1.1;

      // 奇偶均衡：尽量接近对半
      const targetOdd = size % 2 === 0 ? size / 2 : (size + 1) / 2;
      if (oddCount >= targetOdd && st.odd) dynScore -= 0.85;
      if (oddCount < targetOdd && !st.odd) dynScore -= 0.85;

      // 跨注去重
      if (usedElsewhere.has(cand)) dynScore -= 0.9;

      // 均衡注额外按配额再推一把
      if (quota) {
        const zoneQuota = { 1: 2, 2: 1, 3: 1 };
        if (zoneCounts[st.zone] < zoneQuota[st.zone]) dynScore += 0.6;
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
