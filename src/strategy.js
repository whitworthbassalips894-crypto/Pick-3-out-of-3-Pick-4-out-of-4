/**
 * 六合彩「7码复式 · 三中三 / 四中四」多策略推荐引擎与历史回测模块
 * 严格遵循无未来函数原则：针对第 T 期的推荐仅使用 < T 期的历史正码数据计算
 */

import { ALL_NUMBERS, getColorForNumber, getZodiacForNumber, pad2 } from './constants.js';
import { combinations, evaluate7CodeCompound, evaluateDirectTickets, normalizeNumbers } from './combinatorics.js';

export const STRATEGY_CATALOG = [
  {
    id: 'composite',
    code: 'S1',
    name: '综合量化主推',
    shortName: '综合主推',
    badge: '核心7码',
    description: '融合近30期正码热度、黄金遗漏回补、高频共现对子及三区波色均衡的综合模型'
  },
  {
    id: 'hot_warm',
    code: 'S2',
    name: '热温动量策略',
    shortName: '热温动量',
    badge: '趋势追踪',
    description: '聚焦近15~30期高频活跃正码与温码惯性，捕捉强者恒强与重码延续趋势'
  },
  {
    id: 'cold_rebound',
    code: 'S3',
    name: '遗漏回补策略',
    shortName: '遗漏回补',
    badge: '均值回归',
    description: '锁定遗漏周期达临界值的冷码回补窗口，搭配上期邻码构建攻守兼备组合'
  },
  {
    id: 'tail_synergy',
    code: 'S4',
    name: '同尾连码共振',
    shortName: '同尾连码',
    badge: '结构关联',
    description: '挖掘近期强势尾数族群（同尾）与相邻连码结构，强化三中三/四中四成组率'
  },
  {
    id: 'zodiac_wave',
    code: 'S5',
    name: '生肖波色动量',
    shortName: '生肖波色',
    badge: '波肖均衡',
    description: '依据旺肖正码出球密度与红蓝绿三波配比优化，筛选高协同度7码复式'
  }
];

/**
 * 确定性伪随机微调哈希（同一年份+期号+策略下100%可复现）
 * @param {number} year
 * @param {number} periodNum
 * @param {number} num
 * @param {number} salt
 * @returns {number} [0, 1)
 */
function deterministicJitter(year, periodNum, num, salt = 1) {
  let x = ((year * 1009 + periodNum * 9176 + num * 379 + salt * 131071) >>> 0) || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) % 10000) / 10000;
}

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

  // 如果 allDraws 已经按 (year DESC, periodNum DESC) 排列，快速二分或线性定位
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
 * 基于历史前置开奖数据计算 01~49 号码正码统计特征（仅统计前6个正码）
 * @param {object[]} priorDraws 最新在前
 * @param {{ year?: number, periodNum?: number, date?: string }} [targetMeta]
 */
export function computeNumberFeatures(priorDraws = [], targetMeta = {}) {
  const window60 = priorDraws.slice(0, 60);
  const window30 = priorDraws.slice(0, 30);
  const window15 = priorDraws.slice(0, 15);
  const lastDraw = priorDraws[0] || null;
  const dateOrYear = targetMeta.date || targetMeta.year || lastDraw?.date || 2026;

  const freq60 = new Array(50).fill(0);
  const freq30 = new Array(50).fill(0);
  const freq15 = new Array(50).fill(0);
  const omission = new Array(50).fill(window60.length);
  const seenOmission = new Array(50).fill(false);

  // 统计尾数 (0~9) 与生肖热度
  const tailFreq25 = new Array(10).fill(0);
  const zodiacFreq25 = {};

  // 共现矩阵（近 60 期正码成对共现次数）
  const pairCount = Array.from({ length: 50 }, () => new Uint16Array(50));

  for (let idx = 0; idx < window60.length; idx++) {
    const draw = window60[idx];
    const normals = Array.isArray(draw.numbers) ? draw.numbers.slice(0, 6) : [];
    const uniqueNormals = Array.from(new Set(normals));

    for (let i = 0; i < uniqueNormals.length; i++) {
      const n = uniqueNormals[i];
      if (n < 1 || n > 49) continue;
      freq60[n]++;
      if (idx < 30) freq30[n]++;
      if (idx < 15) freq15[n]++;
      if (idx < 25) {
        tailFreq25[n % 10]++;
        const z = getZodiacForNumber(n, dateOrYear);
        zodiacFreq25[z] = (zodiacFreq25[z] || 0) + 1;
      }
      if (!seenOmission[n]) {
        omission[n] = idx;
        seenOmission[n] = true;
      }
      for (let j = i + 1; j < uniqueNormals.length; j++) {
        const m = uniqueNormals[j];
        if (m >= 1 && m <= 49) {
          pairCount[n][m]++;
          pairCount[m][n]++;
        }
      }
    }
  }

  // 上期正码与邻码集合
  const lastNormals = new Set(lastDraw?.numbers?.slice(0, 6) || []);
  const neighborSet = new Set();
  for (const n of lastNormals) {
    if (n > 1) neighborSet.add(n - 1);
    if (n < 49) neighborSet.add(n + 1);
  }

  const stats = {};
  for (const n of ALL_NUMBERS) {
    const f30 = freq30[n];
    const f15 = freq15[n];
    const om = omission[n];
    const color = getColorForNumber(n);
    const zodiac = getZodiacForNumber(n, dateOrYear);
    const tail = n % 10;

    let tag = '温码';
    if (f30 >= 5 || f15 >= 3) tag = '热码';
    else if (om >= 10 || f30 <= 2) tag = '冷码';

    stats[n] = {
      num: n,
      color,
      zodiac,
      tail,
      zone: n <= 16 ? 1 : n <= 33 ? 2 : 3,
      freq60: freq60[n],
      freq30: f30,
      freq15: f15,
      omission: om,
      isRepeatCandidate: lastNormals.has(n),
      isNeighborCandidate: neighborSet.has(n),
      tailScore: tailFreq25[tail],
      zodiacScore: zodiacFreq25[zodiac] || 0,
      tag
    };
  }

  return {
    stats,
    pairCount,
    tailFreq25,
    zodiacFreq25,
    sampleSize: window60.length
  };
}

/**
 * 在保证三区/波色相对均衡与共现协同的前提下，从候选评分中选出 7 个号码
 */
function selectBalanced7Numbers(scoreMap, features, pinnedNumbers = [], salt = 1) {
  const chosen = normalizeNumbers(pinnedNumbers, { sort: false, maxCount: 7 });
  const chosenSet = new Set(chosen);
  const { stats, pairCount } = features;

  const candidates = ALL_NUMBERS.filter((n) => !chosenSet.has(n)).sort(
    (a, b) => scoreMap[b] - scoreMap[a]
  );

  while (chosen.length < 7 && candidates.length > 0) {
    // 统计当前已选中的区间与波色分布
    const zoneCounts = { 1: 0, 2: 0, 3: 0 };
    const colorCounts = { red: 0, blue: 0, green: 0 };
    for (const c of chosen) {
      zoneCounts[stats[c].zone]++;
      colorCounts[stats[c].color]++;
    }

    let bestIdx = 0;
    let bestDynamicScore = -Infinity;

    const searchLimit = Math.min(candidates.length, 22);
    for (let i = 0; i < searchLimit; i++) {
      const cand = candidates[i];
      const st = stats[cand];
      let dynScore = scoreMap[cand];

      // 与已选号码的历史共现加分
      let pairBonus = 0;
      for (const c of chosen) {
        pairBonus += pairCount[cand][c] * 0.45;
      }
      dynScore += pairBonus;

      // 区间均衡奖励（避免7个号全挤在同一区）
      if (zoneCounts[st.zone] === 0) dynScore += 1.4;
      else if (zoneCounts[st.zone] >= 3) dynScore -= 1.8;

      // 波色均衡奖励（避免单一波色超过4个）
      if (colorCounts[st.color] === 0) dynScore += 1.1;
      else if (colorCounts[st.color] >= 3) dynScore -= 1.5;

      // 在第 5~6 个位置适度鼓励产生 1 对同尾或邻码以提升三中三协同度
      if (chosen.length >= 3 && chosen.length <= 5 && salt !== 99) {
        const hasSameTail = chosen.some((c) => c % 10 === st.tail);
        const hasConsecutive = chosen.some((c) => Math.abs(c - cand) === 1);
        if (hasSameTail) dynScore += 0.65;
        if (hasConsecutive) dynScore += 0.55;
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
      // 区间跨度奖励：覆盖至少2个区间、多波色
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

  // 挑选前 5 注三中三（兼顾号码覆盖度，避免5注全围绕同2个号）
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
  // 若不足5注则按高分补齐
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

/**
 * 为指定期号生成完整的「7码复式 + 5组策略方案 + 5注三中三/四中四精选」
 * @param {object[]} allDraws 历史底库（降序）
 * @param {{ year?: number, periodNum?: number, date?: string }} [targetMeta]
 * @param {{ pinnedNumbers?: number[], strategyId?: string }} [options]
 */
export function generatePeriodPlan(allDraws = [], targetMeta = {}, options = {}) {
  const latestDraw = allDraws[0] || { year: 2026, periodNum: 296, date: '2026-10-23' };
  const year = Number(targetMeta.year || latestDraw.year || 2026);
  const periodNum = Number(targetMeta.periodNum || (latestDraw.periodNum || 0) + 1);
  const date = targetMeta.date || latestDraw.date || `${year}-10-24`;
  const pinnedNumbers = normalizeNumbers(options.pinnedNumbers || [], { sort: true, maxCount: 6 });

  const priorDraws = getPriorDraws(allDraws, { year, periodNum });
  const features = computeNumberFeatures(priorDraws, { year, periodNum, date });
  const { stats, pairCount } = features;

  // 构建 5 套策略的评分表
  const scoresByStrategy = {
    composite: {},
    hot_warm: {},
    cold_rebound: {},
    tail_synergy: {},
    zodiac_wave: {}
  };

  for (const n of ALL_NUMBERS) {
    const st = stats[n];
    const j1 = deterministicJitter(year, periodNum, n, 11);
    const j2 = deterministicJitter(year, periodNum, n, 23);
    const j3 = deterministicJitter(year, periodNum, n, 37);
    const j4 = deterministicJitter(year, periodNum, n, 53);
    const j5 = deterministicJitter(year, periodNum, n, 71);

    // 黄金遗漏区间评分（遗漏 4~9 期往往处于温热回补甜点区）
    const sweetOmissionBonus =
      st.omission >= 3 && st.omission <= 9
        ? 2.6
        : st.omission >= 10 && st.omission <= 16
          ? 1.9
          : st.omission === 0
            ? 1.2
            : 0.7;

    // S1: 综合量化主推
    scoresByStrategy.composite[n] =
      st.freq30 * 1.35 +
      st.freq15 * 1.65 +
      sweetOmissionBonus +
      (st.isNeighborCandidate ? 1.35 : 0) +
      (st.isRepeatCandidate ? 0.85 : 0) +
      st.tailScore * 0.22 +
      j1 * 1.4;

    // S2: 热温动量策略
    scoresByStrategy.hot_warm[n] =
      st.freq15 * 2.4 +
      st.freq30 * 1.7 +
      (st.omission <= 5 ? 2.1 : 0.3) +
      (st.isRepeatCandidate ? 1.4 : 0) +
      j2 * 1.35;

    // S3: 遗漏回补策略
    const coldReboundScore =
      st.omission >= 9 && st.omission <= 24
        ? 4.8 + Math.min(st.omission, 22) * 0.28
        : st.omission >= 6
          ? 3.1
          : 0.9;
    scoresByStrategy.cold_rebound[n] =
      coldReboundScore +
      st.freq60 * 0.55 +
      (st.isNeighborCandidate ? 1.85 : 0) +
      j3 * 1.45;

    // S4: 同尾连码共振
    scoresByStrategy.tail_synergy[n] =
      st.tailScore * 1.25 +
      st.freq30 * 1.15 +
      (st.isNeighborCandidate ? 2.1 : 0) +
      sweetOmissionBonus * 0.8 +
      j4 * 1.5;

    // S5: 生肖波色动量
    scoresByStrategy.zodiac_wave[n] =
      st.zodiacScore * 1.1 +
      st.freq30 * 1.2 +
      st.freq15 * 1.1 +
      sweetOmissionBonus * 0.9 +
      j5 * 1.55;
  }

  const strategies = STRATEGY_CATALOG.map((meta, idx) => {
    const scoreMap = scoresByStrategy[meta.id];
    const seven = selectBalanced7Numbers(scoreMap, features, pinnedNumbers, idx + 1);
    const { top5Pick3, top5Pick4 } = selectFeaturedCombinations(seven, scoreMap, pairCount);

    const hotCount = seven.filter((n) => stats[n].tag === '热码').length;
    const coldCount = seven.filter((n) => stats[n].tag === '冷码').length;
    const warmCount = 7 - hotCount - coldCount;
    const waveSummary = {
      red: seven.filter((n) => stats[n].color === 'red').length,
      blue: seven.filter((n) => stats[n].color === 'blue').length,
      green: seven.filter((n) => stats[n].color === 'green').length
    };

    const rationale = `热/温/冷比 ${hotCount}:${warmCount}:${coldCount} · 波色 红${waveSummary.red}/蓝${waveSummary.blue}/绿${waveSummary.green} · 精选7码 [${seven.map(pad2).join(' ')}]`;

    return {
      ...meta,
      numbers: seven,
      top5Pick3,
      top5Pick4,
      rationale,
      waveSummary,
      tagSummary: { hot: hotCount, warm: warmCount, cold: coldCount }
    };
  });

  const activeStrategyId = options.strategyId || 'composite';
  const primaryStrategy =
    strategies.find((s) => s.id === activeStrategyId) || strategies[0];

  // 同时生成跨策略优选的 5 注三中三 & 5 注四中四（每个策略各贡献 1 注最强代表组合）
  const crossStrategyPick3 = strategies.map((s) => s.top5Pick3[0]);
  const crossStrategyPick4 = strategies.map((s) => s.top5Pick4[0]);

  return {
    target: {
      year,
      periodNum,
      period: String(periodNum).padStart(3, '0'),
      date
    },
    priorSampleCount: priorDraws.length,
    pinnedNumbers,
    primaryStrategyId: primaryStrategy.id,
    primary7: primaryStrategy.numbers,
    featuredPick3: primaryStrategy.top5Pick3,
    featuredPick4: primaryStrategy.top5Pick4,
    crossStrategyPick3,
    crossStrategyPick4,
    strategies,
    numberStats: stats
  };
}

/**
 * 为一批目标期号生成「逐期回放」记录
 *
 * 无未来函数保证：第 T 期的推荐只使用严格早于 T 期的历史正码（getPriorDraws 过滤 year/periodNum），
 * 当期开奖结果与之后的数据一律不会参与当期推荐的计算。
 *
 * @param {object[]} allDraws 完整历史底库（任意顺序均可，内部按 year/periodNum 判定先后）
 * @param {object[]} targets 需要回放的期次（必须来自 allDraws）
 * @param {{
 *   strategyId?: string,
 *   customNumbers?: number[] | null,
 *   stake?: number,
 *   odds3?: number,
 *   odds4?: number
 * }} [options]
 * @returns {object[]}
 */
export function buildReplayRecords(allDraws = [], targets = [], options = {}) {
  const {
    strategyId = 'composite',
    customNumbers = null,
    stake = 10,
    odds3 = 650,
    odds4 = 7500
  } = options;

  const fixedCustom =
    Array.isArray(customNumbers) && customNumbers.length >= 4
      ? normalizeNumbers(customNumbers, { sort: true, maxCount: 7 })
      : null;

  const records = [];

  for (const draw of targets) {
    if (!draw) continue;

    // 只取严格早于当期的前 64 期（特征统计最多用 60 期）
    const priorDraws = getPriorDraws(allDraws, {
      year: draw.year,
      periodNum: draw.periodNum
    }).slice(0, 64);

    let plan = null;
    let sevenNumbers = fixedCustom;
    if (!sevenNumbers) {
      plan = generatePeriodPlan(
        priorDraws,
        { year: draw.year, periodNum: draw.periodNum, date: draw.date },
        { strategyId }
      );
      sevenNumbers = plan.primary7;
    }

    const compoundEval = evaluate7CodeCompound(sevenNumbers, draw, { stake, odds3, odds4 });
    const featured3Tickets = plan
      ? plan.featuredPick3
      : selectFeaturedCombinations(sevenNumbers, {}, null).top5Pick3;
    const featured4Tickets = plan
      ? plan.featuredPick4
      : selectFeaturedCombinations(sevenNumbers, {}, null).top5Pick4;

    const direct3Eval = evaluateDirectTickets(featured3Tickets, draw, {
      stake,
      odds3,
      odds4,
      targetSize: 3
    });
    const direct4Eval = evaluateDirectTickets(featured4Tickets, draw, {
      stake,
      odds3,
      odds4,
      targetSize: 4
    });

    records.push({
      draw,
      strategyId: fixedCustom ? 'custom' : strategyId,
      sevenNumbers,
      priorSampleCount: priorDraws.length,
      matchedNormals: compoundEval.matchedNormals,
      matchedNormalCount: compoundEval.matchedNormalCount,
      specialMatched: compoundEval.specialMatched,
      compoundEval,
      direct3Eval,
      direct4Eval,
      featured3Tickets,
      featured4Tickets,
      strategies: plan ? plan.strategies : null
    });
  }

  return records;
}

/**
 * 汇总逐期回放记录：命中期数 / 命中率 / 中奖注数 / 成本 / 返奖 / 净盈亏 / ROI
 * 三中三与四中四分开统计，避免混在一起看不懂。
 *
 * @param {object[]} records buildReplayRecords 的输出
 * @param {{stake?: number, odds3?: number, odds4?: number, betMode?: 'compound7'|'featured5'}} [options]
 */
export function summarizeReplay(records = [], options = {}) {
  const {
    stake = 10,
    odds3 = 650,
    odds4 = 7500,
    betMode = 'compound7',
    strategyId = 'composite'
  } = options;

  let hitPeriods3 = 0;
  let totalWinBets3 = 0;
  let totalCost3 = 0;
  let totalPayout3 = 0;
  let hitPeriods4 = 0;
  let totalWinBets4 = 0;
  let totalCost4 = 0;
  let totalPayout4 = 0;
  let hitNormalGe2Periods = 0;
  let maxSingleWinBets3 = 0;

  for (const r of records) {
    const active3 = betMode === 'featured5' ? r.direct3Eval : r.compoundEval.pick3;
    const active4 = betMode === 'featured5' ? r.direct4Eval : r.compoundEval.pick4;

    if (r.matchedNormalCount >= 2) hitNormalGe2Periods++;
    if (active3.winCount > 0) {
      hitPeriods3++;
      totalWinBets3 += active3.winCount;
      if (active3.winCount > maxSingleWinBets3) maxSingleWinBets3 = active3.winCount;
    }
    totalCost3 += active3.totalBets * stake;
    totalPayout3 += active3.winCount * stake * odds3;

    if (active4.winCount > 0) {
      hitPeriods4++;
      totalWinBets4 += active4.winCount;
    }
    totalCost4 += active4.totalBets * stake;
    totalPayout4 += active4.winCount * stake * odds4;
  }

  const totalPeriods = records.length;
  const netProfit3 = totalPayout3 - totalCost3;
  const netProfit4 = totalPayout4 - totalCost4;

  return {
    totalPeriods,
    betMode,
    strategyId,
    stake,
    odds3,
    odds4,
    hitNormalGe2Periods,
    pick3: {
      hitPeriods: hitPeriods3,
      hitRate: totalPeriods > 0 ? Number(((hitPeriods3 / totalPeriods) * 100).toFixed(2)) : 0,
      totalWinBets: totalWinBets3,
      maxSingleWinBets: maxSingleWinBets3,
      totalCost: totalCost3,
      totalPayout: totalPayout3,
      netProfit: netProfit3,
      roi: totalCost3 > 0 ? Number(((netProfit3 / totalCost3) * 100).toFixed(2)) : 0
    },
    pick4: {
      hitPeriods: hitPeriods4,
      hitRate: totalPeriods > 0 ? Number(((hitPeriods4 / totalPeriods) * 100).toFixed(2)) : 0,
      totalWinBets: totalWinBets4,
      totalCost: totalCost4,
      totalPayout: totalPayout4,
      netProfit: netProfit4,
      roi: totalCost4 > 0 ? Number(((netProfit4 / totalCost4) * 100).toFixed(2)) : 0
    }
  };
}

/**
 * 历史回测与命中明细计算引擎
 * 支持按指定年份/期数范围、指定策略（或固定自定义7码）对每期开出的正码计算「三中三」与「四中四」命中组数及收益统计
 *
 * @param {object[]} allDraws 完整历史底库（降序，最新在前）
 * @param {{
 *   year?: number | 'all',
 *   limit?: number,
 *   strategyId?: string,
 *   customNumbers?: number[] | null,
 *   stake?: number,
 *   odds3?: number,
 *   odds4?: number,
 *   betMode?: 'compound7' | 'featured5'
 * }} [options]
 */
export function runHistoricalBacktest(allDraws = [], options = {}) {
  const {
    year = 'all',
    limit = 300,
    strategyId = 'composite',
    customNumbers = null,
    stake = 10,
    odds3 = 650,
    odds4 = 7500,
    betMode = 'compound7'
  } = options;

  const filteredDraws = allDraws.filter((d) => {
    if (year !== 'all' && Number(year) !== d.year) return false;
    return true;
  });

  const targetDraws = limit > 0 ? filteredDraws.slice(0, limit) : filteredDraws;

  const records = buildReplayRecords(allDraws, targetDraws, {
    strategyId,
    customNumbers,
    stake,
    odds3,
    odds4
  });

  const summary = summarizeReplay(records, {
    stake,
    odds3,
    odds4,
    betMode,
    strategyId: customNumbers ? 'custom' : strategyId
  });

  return { summary, records };
}
