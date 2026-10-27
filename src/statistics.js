/**
 * 统计基线工具：直选（三中三 / 四中四）的随机基线
 *
 * 玩法口径（直选）：49 选 size（3 = 三中三，4 = 四中四），每期开出 6 个正码（平一～平六）。
 * 一注命中 = 这 size 个号码**全部**落在 6 个正码里：
 *   P(中3) = C(6,3) / C(49,3) = 20 / 18424 ≈ 0.1086%
 *   P(中4) = C(6,4) / C(49,4) = 15 / 211876 ≈ 0.00708%
 * 理论公平赔率 = C(49,size) / C(6,size) ≈ 921 倍（选三）/ 14125 倍（选四）
 *
 * 统计表述必须严谨：历史回放只是对既有数据的回测，彩票结果随机，不能理解为「未来必中」；
 * 当前赔率对应的期望回报率长期小于 1，页面必须如实呈现，不美化亏损。
 */

/**
 * 组合数 C(n, k)（浮点精确到 1e-12 以内，本工具用到的规模远小于浮点精度边界）
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
export function comb(n, k) {
  const N = Math.trunc(Number(n));
  const K = Math.trunc(Number(k));
  if (!Number.isFinite(N) || !Number.isFinite(K) || K < 0 || K > N) return 0;
  const m = Math.min(K, N - K);
  let result = 1;
  for (let i = 1; i <= m; i++) {
    result = (result * (N - m + i)) / i;
  }
  return result;
}

/**
 * 「N 注里至少中 1 注」的概率
 *
 * 注意两个经典误区：
 *   1. 直接把单注概率当独立事件连乘 `1-(1-p)^N` —— 只在 N 注号码**完全不重叠**时才成立；
 *      实际 5 注会因为去重而共享号码，覆盖的号码数少于 N×size，真实概率要低一些；
 *   2. 反过来用「覆盖号码数 / 49」当作精确值 —— 这是**线性上界**（并集概率），
 *      仅在「命中事件彼此互斥」时相等，作为近似足够（误差 < 1 个百分点）。
 *
 * 所以这里两个都算出来，页面同时展示，并明确标注哪个是近似。
 *
 * @param {{ hitProb: number, size: number, population: number }} baseline
 * @param {number} [tickets=5] 注数
 * @returns {{ independent: number, coverage: number, coverageNumbers: number }}
 *   independent：假设各注完全不重叠（理论上界）
 *   coverage：按「每注 size 个号、互不重复」算出的并集近似
 *   coverageNumbers：N 注理论最多覆盖的不同号码数
 */
export function anyHitBaseline(baseline, tickets = 5) {
  // 特码：整张清单 = 12 注，用「整张至少中 1 注」的概率算独立近似
  const p = Number(baseline?.hitProbPerTicket ?? baseline?.hitProb) || 0;
  const size = Number(baseline?.size) || 0;
  const population = Number(baseline?.population) || 49;
  const coverageNumbers = Math.min(population, size * tickets);
  return {
    independent: 1 - (1 - p) ** tickets,
    coverage: coverageNumbers / population,
    coverageNumbers
  };
}

/**
 * 把概率格式化为百分比字符串（保留 2 位小数）
 * @param {number} p 0~1
 * @param {number} [digits=2]
 * @returns {string}
 */
export function formatPercent(p, digits = 2) {
  const v = Number(p);
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/* ------------------------------------------------------------------ 直选 */

/**
 * 特码基线：**1 中 1**——1 个号就是 1 注，开奖的特码正好是它才算命中
 *
 * 本工具每期给一张 **12 个号** 的清单（= 12 注）：
 *   单注（1 个号）P = 1/49 ≈ 2.0408%，公平赔率 49 倍
 *   整张清单 12 个号至少中 1 注 = 12/49 ≈ 24.489%（各号互斥，可直接相加）
 *   中了净赚 48 − 12 = 36 注（收益率 300%）
 * 市面常见 48 倍 → 期望回报率 48/49 ≈ 97.96%（抽水约 2%）
 *
 * 为什么是 12：
 *   期望值 EV = −n/49（n = 注数），**永远是负的且与 n 成正比** —— 买越多亏越多，
 *   任何 n 都不存在「最优」。n = 24 只是让「中奖概率 × 命中净利」最大（体验指标），
 *   不是收益指标。12 落在「中了赚 3 倍、约 4 期中 1 次」的实操甜点区，
 *   再往上（15 / 24 / 49 注）收益率会一路掉到 220% / 100% / 0%。
 *
 * 注意：这不是「12 个号包一个特码、赔 48」，而是 12 个号各算 1 注、各赔 48 倍。
 */
export function specialBaseline() {
  const population = 49;
  const size = 12; // 每期清单 12 个号
  const bets = 12; // 1 个号 = 1 注 → 12 注
  const hitProb = 1 / population; // 单注 = 单个号码
  return {
    size,
    bets,
    population,
    draws: 1,
    marked: 1,
    playMode: 'special',
    /** 单注（1 个号）命中概率 */
    hitProb,
    /** 整张清单（size 个号）至少中 1 注的概率 */
    hitProbPerTicket: Math.min(1, size * hitProb),
    /** 理论公平赔率（1 : 1 的公平值） */
    fairOdds: population,
    /** 整张清单场均中奖注数的期望 */
    expectedHits: size * hitProb,
    /**
     * 每期清单里至少中 1 注的概率：特码各号互斥，号码不重复时可直接相加 → 12/49。
     * （若随机号与精选撞号，实际值见 anyHitProbability() 的并集口径。）
     */
    anyHitProb: Math.min(1, size * hitProb)
  };
}

/**
 * 直选基线：三中三（选 3 个号）/ 四中四（选 4 个号）
 *
 * 玩法：49 选 size，开奖开出 6 个正码（平一～平六），命中 = size 个号全部落在正码里。
 *   P(中3) = C(6,3) / C(49,3) = 20 / 18424 ≈ 0.1086%
 *   P(中4) = C(6,4) / C(49,4) = 15 / 211876 ≈ 0.00708%
 * 理论公平赔率 = C(49,size) / C(6,size) ≈ 921 倍（选三）/ 14125 倍（选四）
 *
 * 期望回报率 = 赔率 × 命中概率（页面必须如实呈现，不能美化亏损）。
 *
 * @param {number|string} mode 3 / 4（每注号码个数）或 'special' / 'pick3' / 'pick4'（玩法）
 */
export function directBaseline(mode = 3) {
  const raw = String(mode ?? '').trim();
  // 1 = 特码（1 中 1）；5 是旧版「5 个号包 1 个特码」的写法，保留兼容
  if (raw === 'special' || raw === '特码' || raw === 1 || raw === '1' || raw === 5 || raw === '5') {
    return specialBaseline();
  }

  const population = 49;
  const draws = 6;
  const marked = raw === 'pick4' || raw === 4 || raw === '4' ? 4 : 3;
  const hitProb = comb(draws, marked) / comb(population, marked);
  const fairOdds = comb(population, marked) / comb(draws, marked);
  return {
    size: marked,
    population,
    draws,
    marked,
    playMode: marked === 4 ? 'pick4' : 'pick3',
    /** 单注命中概率 */
    hitProb,
    /** 理论公平赔率（1 : 1 的公平值） */
    fairOdds,
    /** 场均命中号码数期望 */
    expectedHits: (marked * draws) / population,
    /**
     * 每期 5 注里至少中 1 注的概率：**假设 5 注号码互不重叠**的上界。
     * 实际 5 注会共享部分号码（去重后平均覆盖 19 个号），真实值见 anyHitBaseline()。
     */
    anyHitProb: 1 - (1 - hitProb) ** 5
  };
}

/** 三中三直选基线 */
export const DIRECT_BASELINE_3 = directBaseline(3);
/** 四中四直选基线 */
export const DIRECT_BASELINE_4 = directBaseline(4);
/** 特码基线 */
export const SPECIAL_BASELINE = specialBaseline();

/**
 * 按当前赔率计算期望回报率（赔率 × 命中概率）
 * @param {number|string} mode 3 / 4 或 'special' / 'pick3' / 'pick4'
 * @param {number} odds
 * @returns {number} 期望回报比例（1 = 公平；> 1 说明赔率设得比公平值还高）
 */
export function expectedReturnRate(mode = 3, odds = 650) {
  const base = directBaseline(mode);
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 0) return 0;
  return base.hitProb * o;
}
