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
 * @param {{
 *   size?: number,
 *   pinned?: number[],
 *   quota?: boolean,
 *   usedElsewhere?: Set<number>|Map<number, number>,
 *   excluded?: Iterable<number>,
 *   maxShared?: number
 * }} [opts]
 *        excluded：硬性排除的号码（如特码玩法的「上期特码」），永远不会进入候选池。
 *        usedElsewhere：前面几注已经用过的号码（Set 或「号码 → 已用次数」的 Map），
 *                       用于控制跨注重复：用过 1 次轻微减分，用过 2 次以上重罚；
 *        maxShared：跨注重复硬上限。某个号已经被前几注用过 maxShared 次，就不再进候选池，
 *                   保证「4 注精选里同一个号最多被 2 注选中」，把 5 注的面铺得更开。
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
  // size 下限必须是 1：特码玩法每注就 1 个号（1 中 1）
  const size = Math.max(1, Math.min(6, Math.trunc(Number(opts.size ?? 3))));
  const { quota = false, usedElsewhere = new Set(), excluded = [], maxShared = 0 } = opts;

  // 跨注已用次数：Set → 记账，Map 直接沿用
  const usedCount = usedElsewhere instanceof Map ? usedElsewhere : new Map([...usedElsewhere].map((n) => [n, 1]));
  // 硬性排除（例如特码玩法的上期特码）
  const excludedSet = new Set();
  for (const raw of excluded || []) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 49) excludedSet.add(n);
  }

  // 每注允许的同区/同色上限：3 码注不许两码同区，4 码注最多两码同区
  const maxPerZone = size <= 3 ? 1 : 2;
  const maxPerColor = size <= 3 ? 1 : 2;

  const chosen = normalizeNumbers(opts.pinned || [], { sort: false, maxCount: size })
    .filter((n) => !excludedSet.has(n));
  const chosenSet = new Set(chosen);
  const capHit = (n) => maxShared > 0 && (usedCount.get(n) || 0) >= maxShared;
  const sortByScore = (a, b) => (scoreMap[b] || 0) - (scoreMap[a] || 0);
  const candidates = ALL_NUMBERS
    .filter((n) => !chosenSet.has(n) && !excludedSet.has(n) && !capHit(n))
    .sort(sortByScore);
  // 兜底池：万一候选被「跨注上限 / 排除」挤空（例如固定号码占位），仍能凑满一注
  const fallback = ALL_NUMBERS
    .filter((n) => !chosenSet.has(n) && !excludedSet.has(n))
    .sort(sortByScore);

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

    // 三区满额后该区的号码不再可选，但前提是「其他区还装得下剩余号码」，
    // 否则宁可放宽，也不能让这一注凑不满号码。
    const slotsLeft = size - chosen.length;
    const zoneCapacity = [1, 2, 3].reduce((sum, z) => sum + Math.max(0, maxPerZone - zoneCounts[z]), 0);
    const zoneLocked = (st) => zoneCounts[st.zone] >= maxPerZone && zoneCapacity >= slotsLeft;

    let bestIdx = -1;
    let bestDynamicScore = -Infinity;

    const searchLimit = Math.min(candidates.length, 24);
    for (let i = 0; i < searchLimit; i++) {
      const cand = candidates[i];
      const st = statOf(cand);
      if (zoneLocked(st)) continue;
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

      // 三区均衡：空区加分（3 码注自然收敛成 1-1-1，5 码注收敛成 2-2-1）
      if (zoneCounts[st.zone] === 0) dynScore += 1.1;

      // 波色均衡
      if (colorCounts[st.color] === 0) dynScore += 0.7;
      else if (colorCounts[st.color] >= maxPerColor) dynScore -= 1.1;

      // 奇偶均衡：奇偶数量越接近 size/2 越好（3 码 1:2 / 2:1，4 码 2:2，5 码 2:3 / 3:2）。
      // 惩罚按偏离距离的平方增长，所以选号会稳步往对半走，不会出现 5:0 这种极端票。
      const distAfter = Math.abs(oddCount + (st.odd ? 1 : 0) - size / 2);
      dynScore -= 1.1 * distAfter * distAfter;

      // 跨注去重：被前面几注用过的号码减分，重复越多扣得越狠（避免 4 注全压在同一个号上）
      const shared = usedCount.get(cand) || 0;
      if (shared === 1) dynScore -= 0.9;
      else if (shared >= 2) dynScore -= 3.2;

      // 均衡注额外按配额再推一把（配额按每注号码数自适应）
      if (quota) {
        const zoneQuota = size >= 5 ? { 1: 2, 2: 2, 3: 1 } : { 1: 2, 2: 1, 3: 1 };
        if (zoneCounts[st.zone] < zoneQuota[st.zone]) dynScore += 0.6;
      }

      if (dynScore > bestDynamicScore) {
        bestDynamicScore = dynScore;
        bestIdx = i;
      }
    }

    // 前 24 名恰好都落在已满的三区：把搜索范围放宽到整个候选池再试一次
    if (bestIdx < 0) {
      for (let i = searchLimit; i < candidates.length; i++) {
        const cand = candidates[i];
        const st = statOf(cand);
        if (zoneLocked(st)) continue;
        const dynScore = (scoreMap[cand] || 0) - (usedCount.get(cand) || 0) * 0.9;
        if (dynScore > bestDynamicScore) {
          bestDynamicScore = dynScore;
          bestIdx = i;
        }
      }
    }

    // 依然选不出来（极端数据）才彻底放宽三区限制，保证一定凑满号码
    if (bestIdx < 0) {
      bestDynamicScore = -Infinity;
      for (let i = 0; i < searchLimit; i++) {
        const cand = candidates[i];
        const dynScore = (scoreMap[cand] || 0) - (usedCount.get(cand) || 0) * 0.9;
        if (dynScore > bestDynamicScore) {
          bestDynamicScore = dynScore;
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) bestIdx = 0;

    const picked = candidates.splice(bestIdx, 1)[0];
    chosen.push(picked);
    chosenSet.add(picked);
  }

  // 候选不足时从兜底池补齐（不违反硬排除规则）
  for (let i = 0; chosen.length < size && i < fallback.length; i++) {
    const n = fallback[i];
    if (chosenSet.has(n) || excludedSet.has(n)) continue;
    chosen.push(n);
    chosenSet.add(n);
  }

  return chosen.sort((a, b) => a - b);
}
