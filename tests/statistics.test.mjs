import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RANDOM_BASELINE_7_CODE,
  comb,
  formatPercent,
  hypergeometricPmf,
  hypergeometricTail
} from '../src/statistics.js';

test('comb() computes binomial coefficients for the 49-number lottery range', () => {
  assert.equal(comb(7, 3), 35);
  assert.equal(comb(7, 4), 35);
  assert.equal(comb(49, 6), 13983816);
  assert.equal(comb(42, 6), 5245786);
  assert.equal(comb(42, 5), 850668);
  assert.equal(comb(42, 4), 111930);
  assert.equal(comb(42, 3), 11480);
  assert.equal(comb(42, 2), 861);
});

test('hypergeometricPmf matches the closed-form 7-of-49 draw-6 distribution', () => {
  const expectedCounts = [
    5245786, // C(7,0)*C(42,6)
    5954676, // C(7,1)*C(42,5)
    2350530, // C(7,2)*C(42,4)
    401800,  // C(7,3)*C(42,3)
    30135,   // C(7,4)*C(42,2)
    882,     // C(7,5)*C(42,1)
    7        // C(7,6)*C(42,0)
  ];
  const total = 13983816;
  let sum = 0;
  expectedCounts.forEach((count, k) => {
    const p = hypergeometricPmf(k, 49, 7, 6);
    assert.ok(Math.abs(p - count / total) < 1e-12, `P(k=${k}) 期望 ${count / total}，实际 ${p}`);
    sum += p;
  });
  assert.ok(Math.abs(sum - 1) < 1e-12, '概率分布之和必须为 1');
});

test('random baseline P(k>=3) and P(k>=4) use the 7-of-49 hypergeometric, NOT the 7/49 single-number baseline', () => {
  const p3 = 432824 / 13983816; // C(7,3)C(42,3)+C(7,4)C(42,2)+C(7,5)C(42,1)+C(7,6)C(42,0)
  const p4 = 31024 / 13983816;  // C(7,4)C(42,2)+C(7,5)C(42,1)+C(7,6)C(42,0)
  assert.ok(Math.abs(RANDOM_BASELINE_7_CODE.pick3 - p3) < 1e-12);
  assert.ok(Math.abs(RANDOM_BASELINE_7_CODE.pick4 - p4) < 1e-12);
  assert.equal(formatPercent(RANDOM_BASELINE_7_CODE.pick3), '3.10%');
  assert.equal(formatPercent(RANDOM_BASELINE_7_CODE.pick4), '0.22%');

  // 明确排除 222.html 的特码 7/49 = 14.29% 基线
  assert.notEqual(formatPercent(RANDOM_BASELINE_7_CODE.pick3), '14.29%');
  assert.notEqual(formatPercent(RANDOM_BASELINE_7_CODE.pick4), '14.29%');
  // 四中四基线必须远小于三中三
  assert.ok(RANDOM_BASELINE_7_CODE.pick4 < RANDOM_BASELINE_7_CODE.pick3);
  // 期望命中个数 = 7*6/49
  assert.ok(Math.abs(RANDOM_BASELINE_7_CODE.expectedHits - 42 / 49) < 1e-12);
});

test('hypergeometricTail sums the right tail and rejects invalid k', () => {
  const all = hypergeometricTail(0, 49, 7, 6);
  assert.ok(Math.abs(all - 1) < 1e-12);
  assert.equal(hypergeometricTail(7, 49, 7, 6), 0);
  assert.equal(hypergeometricPmf(-1, 49, 7, 6), 0);
  assert.equal(hypergeometricPmf(7, 49, 7, 6), 0);
});
