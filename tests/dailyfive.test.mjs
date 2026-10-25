/**
 * 「每日 5 注」引擎单测
 * 模式参考 https://whitworthbassalips894-crypto.github.io/lottery-tool/
 *   #1 🎲 随机基线（纯随机对照，可重摇） + #2~#5 精选
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import {
  DAILY_FIVE_CATALOG,
  RANDOM_EXPECTED_HITS,
  buildCustomRecords,
  buildDailyFiveRecords,
  computeDailyFiveFeatures,
  generateDailyFive,
  summarizeDailyFive
} from '../src/dailyfive.js';
import { getPriorDraws } from '../src/strategy.js';

const ALL = INITIAL_DB.draws;
const pick = (id) => ALL.find((d) => d.id === id);

const TARGET = { year: 2026, periodNum: 297, date: '2026-10-24' };

test('目录：1 注纯随机 + 4 注精选，编号 #1~#5', () => {
  assert.equal(DAILY_FIVE_CATALOG.length, 5);
  assert.deepEqual(DAILY_FIVE_CATALOG.map((m) => m.code), ['#1', '#2', '#3', '#4', '#5']);
  assert.equal(DAILY_FIVE_CATALOG.filter((m) => m.random).length, 1);
  assert.equal(DAILY_FIVE_CATALOG[0].id, 'random');
  assert.equal(DAILY_FIVE_CATALOG[0].random, true);
  for (const m of DAILY_FIVE_CATALOG.slice(1)) assert.equal(m.random, false);
});

test('generateDailyFive 输出 5 注，每注 7 个合法不重复号码 + 5 注三中三 + 5 注四中四', () => {
  const plan = generateDailyFive(ALL, TARGET);
  assert.equal(plan.five.length, 5);
  for (const e of plan.five) {
    assert.equal(e.numbers.length, 7);
    assert.equal(new Set(e.numbers).size, 7);
    assert.ok(e.numbers.every((n) => n >= 1 && n <= 49));
    assert.equal(e.featuredPick3.length, 5);
    assert.ok(e.featuredPick3.every((t) => t.length === 3 && t.every((n) => e.numbers.includes(n))));
    assert.equal(e.featuredPick4.length, 5);
    assert.ok(e.featuredPick4.every((t) => t.length === 4 && t.every((n) => e.numbers.includes(n))));
    // 形态统计：奇偶合计 = 7，三区合计 = 7，波色合计 = 7
    assert.equal(e.shape.odd + e.shape.even, 7);
    assert.equal(e.shape.zone1 + e.shape.zone2 + e.shape.zone3, 7);
    assert.equal(e.shape.red + e.shape.blue + e.shape.green, 7);
    // 热 / 温 / 冷必须互斥，不能出现负数
    assert.ok(e.shape.hot >= 0 && e.shape.warm >= 0 && e.shape.cold >= 0);
    assert.equal(e.shape.hot + e.shape.warm + e.shape.cold, 7);
  }
});

test('同一期 + 同一盐值 → 完全可复现（确定性）', () => {
  const a = generateDailyFive(ALL, TARGET);
  const b = generateDailyFive(ALL, TARGET);
  assert.deepEqual(a.five.map((e) => e.numbers), b.five.map((e) => e.numbers));
  assert.deepEqual(a.consensus, b.consensus);
});

test('重摇随机注只改变 #1，四注精选保持不变', () => {
  const base = generateDailyFive(ALL, TARGET, { randomSalt: 0 });
  const rerolled = generateDailyFive(ALL, TARGET, { randomSalt: 1 });
  assert.notDeepEqual(base.five[0].numbers, rerolled.five[0].numbers);
  for (let i = 1; i < 5; i++) {
    assert.deepEqual(base.five[i].numbers, rerolled.five[i].numbers);
  }
  // 再摇一次又不相同
  const rerolled2 = generateDailyFive(ALL, TARGET, { randomSalt: 2 });
  assert.notDeepEqual(rerolled.five[0].numbers, rerolled2.five[0].numbers);
});

test('共识号 = 至少 2 注精选同时选中的号码（不含随机注）', () => {
  const plan = generateDailyFive(ALL, TARGET);
  const counts = new Map();
  for (const e of plan.five.slice(1)) {
    for (const n of e.numbers) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const expected = [...counts.entries()].filter(([, c]) => c >= 2).map(([n]) => n).sort((a, b) => a - b);
  assert.deepEqual([...plan.consensus].sort((a, b) => a - b), expected);
  // 共识号必须出现在至少两注精选里
  for (const n of plan.consensus) {
    const hitCount = plan.five.slice(1).filter((e) => e.numbers.includes(n)).length;
    assert.ok(hitCount >= 2);
  }
});

test('computeDailyFiveFeatures 的频率表与遗漏表都不越界', () => {
  const prior = getPriorDraws(ALL, TARGET);
  const f = computeDailyFiveFeatures(prior, TARGET);
  for (let n = 1; n <= 49; n++) {
    const st = f.stats[n];
    assert.ok(st, `缺少 ${n} 号的特征`);
    assert.ok(st.freq30 >= 0 && st.freq30 <= 30);
    assert.ok(st.freq180 >= 0 && st.freq180 <= 180);
    assert.ok(st.omission >= 0);
    assert.ok(st.color === 'red' || st.color === 'blue' || st.color === 'green');
    assert.ok([1, 2, 3].includes(st.zone));
  }
  assert.ok(f.pairCount.length >= 50);
});

test('buildDailyFiveRecords 逐期回放：命中只按前 6 个正码计算，特码不计入', () => {
  const target = pick('2026-287');
  assert.deepEqual(target.numbers, [19, 47, 38, 35, 6, 17]);
  assert.equal(target.special, 8);

  const rec = buildDailyFiveRecords(ALL, [target])[0];
  assert.equal(rec.five.length, 5);
  for (const e of rec.five) {
    // 特码 08 绝不能被算作命中
    assert.ok(!e.matchedNormals.includes(8));
    assert.equal(e.matchedNormalCount, e.matchedNormals.length);
    assert.equal(e.compoundEval.pick3.winCount, e.compoundEval.pick3.expectedFormulaCount);
    assert.equal(e.compoundEval.pick4.winCount, e.compoundEval.pick4.expectedFormulaCount);
  }
});

test('无未来函数：把未来开奖全部改掉，T 期推荐不变', () => {
  const target = pick('2026-287');
  const idx = ALL.findIndex((d) => d.id === target.id);
  const rot = (n) => (n % 49) + 1;
  const mutated = ALL.map((d, i) => (i < idx
    ? { ...d, numbers: d.numbers.map(rot), special: rot(d.special) }
    : d));

  const recFull = buildDailyFiveRecords(ALL, [target])[0];
  const recMutated = buildDailyFiveRecords(mutated, [mutated[idx]])[0];
  assert.deepEqual(
    recFull.five.map((e) => e.numbers),
    recMutated.five.map((e) => e.numbers),
    '推荐不应受之后开奖数据影响'
  );
});

test('无未来函数：只保留 T 期之前的数据，T 期推荐不变', () => {
  const target = pick('2026-287');
  const priorOnly = ALL.filter((d) => d.year < target.year || (d.year === target.year && d.periodNum < target.periodNum));
  const recFull = buildDailyFiveRecords(ALL, [target])[0];
  const recPriorOnly = buildDailyFiveRecords(priorOnly, [target])[0];
  assert.deepEqual(
    recFull.five.map((e) => e.numbers),
    recPriorOnly.five.map((e) => e.numbers)
  );
});

test('summarizeDailyFive：逐注汇总与逐期记录一一对应', () => {
  const targets = ALL.slice(0, 60);
  const records = buildDailyFiveRecords(ALL, targets, { stake: 10, odds3: 650, odds4: 7500 });
  const summary = summarizeDailyFive(records, { stake: 10, odds3: 650, odds4: 7500, betMode: 'compound7' });

  assert.equal(summary.periods, records.length);
  assert.equal(summary.catalog.length, 5);

  for (const agg of summary.catalog) {
    assert.equal(agg.periods, records.length);
    // 复式：每注每期 35 注三中三 + 35 注四中四 = 70 注
    assert.equal(agg.cost, records.length * 70 * 10);
    const manual3 = records.reduce((s, r) => {
      const e = r.five.find((x) => x.id === agg.id);
      return s + e.compoundEval.pick3.winCount;
    }, 0);
    assert.equal(agg.winBets3, manual3);
    const manual4 = records.reduce((s, r) => {
      const e = r.five.find((x) => x.id === agg.id);
      return s + e.compoundEval.pick4.winCount;
    }, 0);
    assert.equal(agg.winBets4, manual4);
    assert.equal(agg.payout, agg.winBets3 * 10 * 650 + agg.winBets4 * 10 * 7500);
    assert.equal(agg.net, agg.payout - agg.cost);
  }
  assert.equal(summary.totalCost, summary.catalog.reduce((a, c) => a + c.cost, 0));
  assert.equal(summary.totalPayout, summary.catalog.reduce((a, c) => a + c.payout, 0));
  assert.equal(summary.totalNet, summary.totalPayout - summary.totalCost);
});

test('精选 5 注模式：统计口径切换到直选注单（每注每期 5 注）', () => {
  const targets = ALL.slice(0, 40);
  const records = buildDailyFiveRecords(ALL, targets, { stake: 10, odds3: 650, odds4: 7500 });
  const summary = summarizeDailyFive(records, { stake: 10, odds3: 650, odds4: 7500, betMode: 'featured5' });
  for (const agg of summary.catalog) {
    assert.equal(agg.cost, targets.length * 10 * 10);
    assert.ok(agg.winBets3 <= targets.length * 5);
    assert.ok(agg.winBets4 <= targets.length * 5);
  }
});

test('随机期望：7 码对 6 个正码的期望命中为 42/49 ≈ 0.857', () => {
  assert.ok(Math.abs(RANDOM_EXPECTED_HITS - 42 / 49) < 1e-12);
});

test('buildCustomRecords：自选 7 码每期都用同一组号码，且不偷看当期数据', () => {
  const custom = [6, 26, 29, 32, 36, 38, 47];
  const targets = ALL.slice(0, 20);
  const records = buildCustomRecords(ALL, targets, { customNumbers: custom, stake: 10 });
  assert.equal(records.length, targets.length);
  for (const r of records) {
    assert.equal(r.five.length, 1);
    assert.deepEqual(r.five[0].numbers, custom);
    assert.equal(r.five[0].id, 'custom');
  }
  // 自选不足 7 码时直接返回空
  assert.equal(buildCustomRecords(ALL, targets, { customNumbers: [1, 2, 3] }).length, 0);
});
