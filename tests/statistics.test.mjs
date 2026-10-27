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

test('特码基线（1 中 1）：一张 12 号清单 = 12 注，单注 P = 1/49 ≈ 2.0408%，公平赔率 49 倍', () => {
  const b = specialBaseline();
  assert.equal(b.size, 12, '每期清单 12 个号');
  assert.equal(b.bets, 12, '1 个号 = 1 注 → 12 注');
  assert.ok(Math.abs(b.hitProb - 1 / 49) < 1e-12, '单注 = 单个号码');
  assert.ok(Math.abs(b.hitProb - 0.02040816326530612) < 1e-12);
  assert.equal(b.fairOdds, 49, '公平赔率 = 49 倍');
  // 12 个号：各号互斥，可相加 → 12/49 ≈ 24.49%
  assert.ok(Math.abs(b.hitProbPerTicket - 12 / 49) < 1e-12);
  assert.ok(Math.abs(b.anyHitProb - 12 / 49) < 1e-12);
  // 中了净赚 48 - 12 = 36 注（收益率 300%）
  assert.equal(48 - b.bets, 36);
});

test('特码注数与收益率：12 注是「甜点区」，15 / 24 / 49 注收益率明显更差', () => {
  const odds = 48;
  const p = (n) => n / 49;
  const roi = (n) => (n * odds) / n; // 中奖返 48 注 / 成本 n 注 —— 仅在 n=1 时等于赔率
  // 单注命中时：净赚 = 48 - n
  const net = (n) => 48 - n;
  assert.equal(net(12), 36);
  assert.equal(net(15), 33);
  assert.equal(net(24), 24);
  assert.equal(net(48), 0);
  // 中奖率
  assert.ok(Math.abs(p(12) - 0.24489795918367346) < 1e-12);
  assert.ok(Math.abs(p(15) - 0.30612244897959184) < 1e-12);
  // 收益率 = (48 - n) / n
  assert.ok(Math.abs((net(12) / 12) - 3) < 1e-12, '12 注：中了赚 3 倍');
  assert.ok(Math.abs((net(15) / 15) - 2.2) < 1e-12, '15 注：只赚 2.2 倍');
  assert.ok(((net(24) / 24)) < (net(15) / 15), '注数越多收益率越低');
  void roi;
  void odds;
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

test('directBaseline 特码口径（12 号清单）返回单注 2.0408% / 整张 24.4898% 与 49 倍公平赔率', () => {
  const b = directBaseline('special');
  assert.equal(b.size, 12);
  assert.ok(Math.abs(b.hitProb - 1 / 49) < 1e-12);
  assert.ok(Math.abs(b.hitProbPerTicket - 12 / 49) < 1e-12);
  assert.equal(b.fairOdds, 49);
  assert.equal(directBaseline(1).fairOdds, 49);
});

/* ------------------------------------------- 「N 注至少中 1 注」的两种口径 */

test('anyHitBaseline：特码 1 张清单覆盖 12 个号 → 12/49（各号互斥可相加）', () => {
  const base = specialBaseline();
  const a = anyHitBaseline(base, 1);
  // 特码：1 张清单 × 12 个号，完全不重叠
  assert.equal(a.coverageNumbers, 12);
  assert.ok(Math.abs(a.coverage - 12 / 49) < 1e-12);
  // 独立近似按「整张至少中 1 注 = 12/49」
  assert.ok(Math.abs(a.independent - 12 / 49) < 1e-12);
  assert.ok(a.coverage > 0.244 && a.coverage < 0.245);
});

test('anyHitBaseline：注数/号码数会被 population 截断', () => {
  const base = specialBaseline();
  const many = anyHitBaseline(base, 5); // 5 × 12 个号 = 60 个号 > 49
  assert.equal(many.coverageNumbers, 49);
  assert.equal(many.coverage, 1);
});
