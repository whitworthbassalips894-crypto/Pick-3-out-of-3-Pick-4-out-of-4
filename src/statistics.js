/**
 * 统计基线工具：超几何分布（Hypergeometric Distribution）
 *
 * 背景：本工具的玩法是「先选 7 个号码（49 选 7），开奖开出 6 个正码（平一～平六）」，
 *      命中个数 k 服从超几何分布，而不是 222.html 特码工具那种「7/49 单号覆盖」的二项分布。
 *
 *      P(k) = C(7, k) * C(42, 6 - k) / C(49, 6)
 *      P(k >= 3) ≈ 3.0951%   （三中三命中概率基线）
 *      P(k >= 4) ≈ 0.2219%   （四中四命中概率基线）
 *
 * 统计表述必须严谨：历史回放只是对既有数据的回测，不能理解为「未来必中」。
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
 * 超几何分布概率质量函数 P(X = k)
 * @param {number} k 命中个数
 * @param {number} population 总号码数（49）
 * @param {number} marked 已选号码数（7）
 * @param {number} draws 开出的号码数（6 个正码）
 * @returns {number}
 */
export function hypergeometricPmf(k, population, marked, draws) {
  const K = Math.trunc(Number(k));
  const N = Math.trunc(Number(population));
  const M = Math.trunc(Number(marked));
  const n = Math.trunc(Number(draws));
  if (K < 0 || K > M || K > n || K > N - M) return 0;
  return (comb(M, K) * comb(N - M, n - K)) / comb(N, n);
}

/**
 * 超几何分布右尾概率 P(X >= minK)
 * @param {number} minK
 * @param {number} population
 * @param {number} marked
 * @param {number} draws
 * @returns {number}
 */
export function hypergeometricTail(minK, population, marked, draws) {
  const M = Math.trunc(Number(marked));
  const n = Math.trunc(Number(draws));
  const start = Math.max(0, Math.trunc(Number(minK)));
  let sum = 0;
  for (let k = start; k <= Math.min(M, n); k++) {
    sum += hypergeometricPmf(k, population, marked, draws);
  }
  return sum;
}

/**
 * 「49 选 7，开 6 个正码」随机基线
 * 用于把回测命中率与纯随机选号的期望做对照，避免把回测包装成「保证中奖」。
 */
export const RANDOM_BASELINE_7_CODE = (() => {
  const population = 49;
  const marked = 7;
  const draws = 6;
  const distribution = [];
  for (let k = 0; k <= Math.min(marked, draws); k++) {
    distribution.push({ k, p: hypergeometricPmf(k, population, marked, draws) });
  }
  return {
    population,
    marked,
    draws,
    expectedHits: (marked * draws) / population,
    distribution,
    /** P(k >= 3)：三中三命中基线 */
    pick3: hypergeometricTail(3, population, marked, draws),
    /** P(k >= 4)：四中四命中基线 */
    pick4: hypergeometricTail(4, population, marked, draws)
  };
})();

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
