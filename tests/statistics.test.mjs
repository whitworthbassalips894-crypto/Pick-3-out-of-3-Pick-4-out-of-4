import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_BASELINE_3,
  DIRECT_BASELINE_4,
  comb,
  directBaseline,
  specialBaseline,
  expectedReturnRate,
  formatPercent
} from '../src/statistics.js';

test('comb() computes binomial coefficients for the 49-number lottery range', () => {
  assert.equal(comb(7, 3), 35);
  assert.equal(comb(49, 3), 18424);
  assert.equal(comb(49, 4), 211876);
  assert.equal(comb(6, 3), 20);
  assert.equal(comb(6, 4), 15);
  assert.equal(comb(49, 6), 13983816);
});

test('三中三直选基线：P = C(6,3)/C(49,3) ≈ 0.1086%，公平赔率 ≈ 921 倍', () => {
  const base = DIRECT_BASELINE_3;
  assert.equal(base.size, 3);
  assert.ok(Math.abs(base.hitProb - 20 / 18424) < 1e-15);
  assert.ok(Math.abs(base.hitProb - 0.0010857) < 0.00001);
  assert.ok(Math.abs(base.fairOdds - 18424 / 20) < 1e-9);
  assert.ok(Math.abs(base.fairOdds - 921.2) < 0.5);
  // 场均命中号码期望 = 3 * 6 / 49
  assert.ok(Math.abs(base.expectedHits - 18 / 49) < 1e-12);
});

test('四中四直选基线：P = C(6,4)/C(49,4) ≈ 0.0071%，公平赔率 ≈ 14125 倍', () => {
  const base = DIRECT_BASELINE_4;
  assert.equal(base.size, 4);
  assert.ok(Math.abs(base.hitProb - 15 / 211876) < 1e-15);
  assert.ok(Math.abs(base.fairOdds - 211876 / 15) < 1e-6);
  assert.ok(Math.abs(base.expectedHits - 24 / 49) < 1e-12);
  // 四中四基线必须远小于三中三
  assert.ok(DIRECT_BASELINE_4.hitProb < DIRECT_BASELINE_3.hitProb);
});

test('期望回报率：当前赔率下长期必然低于 1（诚实展示，不美化亏损）', () => {
  const r3 = expectedReturnRate(3, 650);
  const r4 = expectedReturnRate(4, 7500);
  assert.ok(Math.abs(r3 - 650 * (20 / 18424)) < 1e-12);
  assert.ok(Math.abs(r4 - 7500 * (15 / 211876)) < 1e-12);
  assert.ok(r3 < 1, '三中三期望回报率必须小于 1');
  assert.ok(r4 < 1, '四中四期望回报率必须小于 1');
  assert.ok(r3 > 0.6 && r3 < 0.8, `三中三期望回报率应在 60%~80% 之间，实际 ${r3}`);
  assert.ok(r4 > 0.4 && r4 < 0.6, `四中四期望回报率应在 40%~60% 之间，实际 ${r4}`);
  // 公平赔率下期望回报率恰好 = 1
  assert.ok(Math.abs(expectedReturnRate(3, DIRECT_BASELINE_3.fairOdds) - 1) < 1e-9);
  assert.ok(Math.abs(expectedReturnRate(4, DIRECT_BASELINE_4.fairOdds) - 1) < 1e-9);
});

test('directBaseline 对非法 size 回落成 3 码', () => {
  assert.equal(directBaseline(7).size, 3);
  assert.equal(directBaseline(undefined).size, 3);
  assert.equal(directBaseline(4).size, 4);
});

test('formatPercent 输出百分比字符串', () => {
  assert.equal(formatPercent(0.0010857), '0.11%');
  assert.equal(formatPercent(0.5, 1), '50.0%');
  assert.equal(formatPercent(NaN), '—');
});

test('特码基线：P = 5/49 ≈ 10.204%，公平赔率 9.8 倍', () => {
  const b = specialBaseline();
  assert.equal(b.size, 5);
  assert.ok(Math.abs(b.hitProb - 5 / 49) < 1e-12);
  assert.ok(Math.abs(b.hitProb - 0.10204081632653061) < 1e-12);
  assert.ok(Math.abs(b.fairOdds - 9.8) < 1e-9);
});

test('特码期望回报率：默认 9.6 倍 ⇒ ≈98%，9.8 倍 ⇒ 100%，48 倍 ⇒ ≈489.8%（不现实）', () => {
  const ev48 = expectedReturnRate('special', 48);
  assert.ok(Math.abs(ev48 - 48 * (5 / 49)) < 1e-12);
  assert.ok(Math.abs(ev48 - 4.897959183673469) < 1e-9, `实际 ${ev48}`);
  assert.ok(ev48 > 1, '48 倍的期望回报率必然高于 100%，页面要显式提示');

  const ev96 = expectedReturnRate('special', 9.6);
  assert.ok(Math.abs(ev96 - 0.9795918367346939) < 1e-9);
  // 默认赔率下期望回报率必须低于 100%（不制造“稳赚”的错觉）
  assert.ok(ev96 < 1, '默认 9.6 倍的期望回报率必须小于 1');

  const ev98 = expectedReturnRate('special', 9.8);
  assert.ok(Math.abs(ev98 - 1) < 1e-9, '公平赔率下期望回报率 = 1');

  // 传 size（3 / 4 / 5）也能取到对应口径，兼容旧调用
  assert.ok(Math.abs(expectedReturnRate(5, 9.8) - 1) < 1e-9);
  assert.ok(Math.abs(expectedReturnRate(3, 650) - 650 * (20 / 18424)) < 1e-12);
});

test('directBaseline 特码口径（size=5）返回 10.204% 与 9.8 倍公平赔率', () => {
  const b = directBaseline('special');
  assert.equal(b.size, 5);
  assert.ok(Math.abs(b.hitProb - 5 / 49) < 1e-12);
  assert.ok(Math.abs(b.fairOdds - 9.8) < 1e-9);
  assert.ok(Math.abs(directBaseline(5).fairOdds - 9.8) < 1e-9);
});
