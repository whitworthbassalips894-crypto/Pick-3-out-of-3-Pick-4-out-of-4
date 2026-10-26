/**
 * 「连空 / 中奖间隔」体检
 *
 * 用户最关心的其实不是命中率，而是「最多会空多久、一般空多久、现在空了多久」。
 * 这里把回放记录（buildDailyFiveRecords 的输出，最新在前）折算成：
 *   - 合并口径（5 注里至少中 1 注）
 *   - 逐注口径（每注自己的连空）
 *
 * 注意：连空只是过去的事实，**不构成「该反弹了」的理由**——每期独立，
 * 空了 12 期之后下一期的命中率仍然是 size/49。页面必须同时给出理论值对照。
 */

/** 把一组「是否命中」序列折成连空指标 */
function droughtOf(flags) {
  let current = 0;
  let longest = 0;
  let longestEnd = -1;
  let run = 0;
  const gaps = [];
  let sinceLastHit = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      gaps.push(sinceLastHit);
      sinceLastHit = 0;
      run = 0;
    } else {
      run++;
      sinceLastHit++;
      if (run > longest) {
        longest = run;
        longestEnd = i;
      }
    }
  }
  // 当前连空 = 从最新一期（下标 0）开始连续未命中的期数
  for (let i = 0; i < flags.length && !flags[i]; i++) current++;
  return { current, longest, longestEnd, gaps, trailing: sinceLastHit };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** 间隔分布分桶：0,1,2,3,4,5,6-10,11+ */
function bucketOf(gap) {
  if (gap <= 5) return String(gap);
  if (gap <= 10) return '6-10';
  return '11+';
}

const BUCKET_ORDER = ['0', '1', '2', '3', '4', '5', '6-10', '11+'];

/**
 * 汇总连空体检
 * @param {Array<{ draw: {id?: string, date?: string, year?: number, period?: string}, five: Array<{id: string, code?: string, name?: string, numbers: number[], isWin: boolean}> }>} records
 *        回放记录，**最新在前**
 * @param {{ population?: number }} [options]
 */
export function summarizeDroughts(records = [], options = {}) {
  const population = Number(options.population) || 49;
  const list = Array.isArray(records) ? records : [];
  const periods = list.length;

  const label = (i) => {
    const d = list[i]?.draw || {};
    return d.year && d.period ? `${d.year}年第${d.period}期` : String(d.id || `#${i + 1}`);
  };

  const combinedFlags = list.map((r) => (r.five || []).some((e) => e.isWin));
  const combinedDrought = droughtOf(combinedFlags);

  // 覆盖率（用于理论值对照）：每期 5 注合起来覆盖多少个不同号码
  let coverageSum = 0;
  for (const r of list) {
    const set = new Set();
    for (const e of r.five || []) for (const n of e.numbers || []) set.add(Number(n));
    coverageSum += set.size;
  }
  const avgCoverage = periods ? coverageSum / periods : 0;
  const theoreticalAnyHit = Math.min(1, avgCoverage / population);
  const theoreticalEmptyRate = 1 - theoreticalAnyHit;

  const gapsSorted = [...combinedDrought.gaps].sort((a, b) => a - b);
  const distribution = BUCKET_ORDER.map((b) => ({ bucket: b, count: 0, rate: 0 }));
  for (const g of combinedDrought.gaps) {
    const b = distribution.find((x) => x.bucket === bucketOf(g));
    if (b) b.count++;
  }
  for (const b of distribution) b.rate = combinedDrought.gaps.length ? b.count / combinedDrought.gaps.length : 0;

  // 逐注
  const ticketMeta = [];
  for (const r of list) {
    for (const e of r.five || []) {
      if (ticketMeta.some((t) => t.id === e.id)) continue;
      ticketMeta.push({ id: e.id, code: e.code || '—', name: e.name || e.id, random: !!e.random });
    }
  }
  const perTicket = ticketMeta.map((meta) => {
    const flags = list.map((r) => !!(r.five || []).find((e) => e.id === meta.id)?.isWin);
    const d = droughtOf(flags);
    const sorted = [...d.gaps].sort((a, b) => a - b);
    const wins = flags.filter(Boolean).length;
    return {
      ...meta,
      periods,
      winPeriods: wins,
      winRate: periods ? Number(((wins / periods) * 100).toFixed(2)) : 0,
      currentDrought: d.current,
      longestDrought: d.longest,
      longestDroughtTo: d.longest >= 0 && d.longestEnd >= 0 ? label(d.longestEnd) : '',
      meanGap: d.gaps.length ? Number((d.gaps.reduce((a, b) => a + b, 0) / d.gaps.length).toFixed(2)) : 0,
      medianGap: percentile(sorted, 0.5),
      p90Gap: percentile(sorted, 0.9),
      p95Gap: percentile(sorted, 0.95)
    };
  });

  return {
    periods,
    combined: {
      hitPeriods: combinedFlags.filter(Boolean).length,
      emptyPeriods: combinedFlags.filter((x) => !x).length,
      emptyRate: periods ? Number(((combinedFlags.filter((x) => !x).length / periods) * 100).toFixed(2)) : 0,
      currentDrought: combinedDrought.current,
      longestDrought: combinedDrought.longest,
      longestDroughtTo: combinedDrought.longest > 0 && combinedDrought.longestEnd >= 0 ? label(combinedDrought.longestEnd) : '',
      gapCount: combinedDrought.gaps.length,
      meanGap: combinedDrought.gaps.length
        ? Number((combinedDrought.gaps.reduce((a, b) => a + b, 0) / combinedDrought.gaps.length).toFixed(2))
        : 0,
      medianGap: percentile(gapsSorted, 0.5),
      p90Gap: percentile(gapsSorted, 0.9),
      p95Gap: percentile(gapsSorted, 0.95),
      distribution,
      avgCoverage: Number(avgCoverage.toFixed(2)),
      theoreticalAnyHit: Number((theoreticalAnyHit * 100).toFixed(2)),
      theoreticalEmptyRate: Number((theoreticalEmptyRate * 100).toFixed(2))
    },
    perTicket
  };
}

/**
 * 当前连空在历史里算什么水平（用几何分布估「至少空这么久」的概率）
 * @param {number} currentDrought 当前连空期数
 * @param {number} hitProb 每期至少中 1 注的概率（0~1）
 * @returns {{ atLeast: number, label: string }}
 */
export function droughtRarity(currentDrought, hitProb) {
  const p = Math.min(0.999, Math.max(0.001, Number(hitProb) || 0));
  const n = Math.max(0, Number(currentDrought) || 0);
  const atLeast = Math.pow(1 - p, n);
  const label = atLeast >= 0.2 ? '很常见（属于日常波动）'
    : atLeast >= 0.05 ? '偏长，但仍在正常范围'
      : atLeast >= 0.01 ? '少见（约 1%~5% 才会空这么久）'
        : '罕见（<1%，历史级长空）';
  return { atLeast: Number((atLeast * 100).toFixed(2)), label };
}
