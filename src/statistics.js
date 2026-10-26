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
 * 直选基线：三中三（选 3 个号）/ 四中四（选 4 个号）
 *
 * 玩法：49 选 size，开奖开出 6 个正码（平一～平六），命中 = size 个号全部落在正码里。
 * 期望回报率 = 赔率 × 命中概率（直选长期必然低于 1，页面必须如实呈现）。
 *
 * @param {number} size 3 = 三中三，4 = 四中四
 */
export function directBaseline(size = 3) {
  const population = 49;
  const draws = 6;
  const marked = Math.trunc(Number(size)) === 4 ? 4 : 3;
  const hitProb = comb(draws, marked) / comb(population, marked);
  const fairOdds = comb(population, marked) / comb(draws, marked);
  return {
    size: marked,
    population,
    draws,
    marked,
    /** 单注命中概率 */
    hitProb,
    /** 理论公平赔率（1 : 1 的公平值） */
    fairOdds,
    /** 场均命中号码数期望 */
    expectedHits: (marked * draws) / population,
    /** 每期 5 注里至少中 1 注的概率（用于对照） */
    anyHitProb: 1 - (1 - hitProb) ** 5
  };
}

/** 三中三直选基线 */
export const DIRECT_BASELINE_3 = directBaseline(3);
/** 四中四直选基线 */
export const DIRECT_BASELINE_4 = directBaseline(4);

/**
 * 按当前赔率计算期望回报率（赔率 × 命中概率）
 * @param {number} size
 * @param {number} odds
 * @returns {number} 0~1 之间的期望回报比例（1 = 公平）
 */
export function expectedReturnRate(size = 3, odds = 650) {
  const base = directBaseline(size);
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 0) return 0;
  return base.hitProb * o;
}
