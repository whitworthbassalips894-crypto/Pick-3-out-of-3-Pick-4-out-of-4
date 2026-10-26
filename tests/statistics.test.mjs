import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_BASELINE_3,
  DIRECT_BASELINE_4,
  anyHitBaseline,
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

test('特码基线（1 中 1）：每组 3 个号 = 3 注，单注 P = 1/49 ≈ 2.0408%，公平赔率 49 倍', () => {
  const b = specialBaseline();
  assert.equal(b.size, 3, '特码每组 3 个号');
  assert.equal(b.bets, 3, '3 个号 = 3 注');
  assert.ok(Math.abs(b.hitProb - 1 / 49) < 1e-12, '单注 = 单个号码');
  assert.ok(Math.abs(b.hitProb - 0.02040816326530612) < 1e-12);
  assert.equal(b.fairOdds, 49, '公平赔率 = 49 倍');
  // 每组 3 个号：各号互斥，可相加 → 3/49
  assert.ok(Math.abs(b.hitProbPerTicket - 3 / 49) < 1e-12);
  // 5 组 15 注（号码不重复）→ 15/49
  assert.ok(Math.abs(b.anyHitProb - 15 / 49) < 1e-12);
});

test('特码期望回报率：默认 48 倍 ⇒ ≈97.96%，49 倍 ⇒ 100%（公平）', () => {
  const ev48 = expectedReturnRate('special', 48);
  assert.ok(Math.abs(ev48 - 48 / 49) < 1e-12, '1 中 1：EV = 赔率 × 1/49');
  assert.ok(Math.abs(ev48 - 0.9795918367346939) < 1e-9, `实际 ${ev48}`);
  // 默认赔率下期望回报率必须低于 100%（不制造「稳赚」的错觉）
  assert.ok(ev48 < 1, '默认 48 倍的期望回报率必须小于 1');

  const ev49 = expectedReturnRate('special', 49);
  assert.ok(Math.abs(ev49 - 1) < 1e-9, '49 倍即公平赔率');

  assert.ok(expectedReturnRate('special', 60) > 1, '高于 49 倍时页面要提示超过公平值');

  // 传玩法名 / 旧写法都能取到特码口径（EV 仍按「1 注 = 1 个号」算）
  assert.ok(Math.abs(expectedReturnRate(1, 49) - 1) < 1e-9);
  assert.ok(Math.abs(expectedReturnRate(5, 49) - 1) < 1e-9);
  assert.ok(Math.abs(expectedReturnRate(3, 650) - 650 * (20 / 18424)) < 1e-12);
});

test('directBaseline 特码口径（每组 3 号）返回单注 2.0408% / 每组 6.1224% 与 49 倍公平赔率', () => {
  const b = directBaseline('special');
  assert.equal(b.size, 3);
  assert.ok(Math.abs(b.hitProb - 1 / 49) < 1e-12);
  assert.ok(Math.abs(b.hitProbPerTicket - 3 / 49) < 1e-12);
  assert.equal(b.fairOdds, 49);
  assert.equal(directBaseline(1).fairOdds, 49);
});

/* ------------------------------------------- 「N 注至少中 1 注」的两种口径 */

test('anyHitBaseline：特码 5 组覆盖 15 个号 → 15/49（各号互斥可相加）', () => {
  const base = specialBaseline();
  const a = anyHitBaseline(base, 5);
  // 特码：5 组 × 3 个号 = 15 个号，完全不重叠
  assert.equal(a.coverageNumbers, 15);
  assert.ok(Math.abs(a.coverage - 15 / 49) < 1e-12);
  // 独立近似按「每组至少中 1 注 = 3/49」
  assert.ok(Math.abs(a.independent - (1 - (1 - 3 / 49) ** 5)) < 1e-12);
  assert.ok(a.independent > 0.27 && a.independent < 0.28);
  assert.ok(a.coverage > 0.306 && a.coverage < 0.307);
});

test('anyHitBaseline：注数/号码数会被 population 截断', () => {
  const base = specialBaseline();
  const many = anyHitBaseline(base, 40); // 40 组 × 3 个号 = 120 个号 > 49
  assert.equal(many.coverageNumbers, 49);
  assert.equal(many.coverage, 1);
});
