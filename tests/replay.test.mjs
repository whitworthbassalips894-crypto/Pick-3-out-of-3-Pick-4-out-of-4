/**
 * 历史回放单测：逐期回放必须无未来函数，且「表格数字 = 指标卡数字」
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import { buildCustomRecords, buildDailyFiveRecords, summarizeDailyFive } from '../src/dailyfive.js';

const ALL = INITIAL_DB.draws;
const pick = (id) => ALL.find((d) => d.id === id);

/** 把一期开奖号码整体轮换一位（保持 6 个不重复的合法正码），用于构造「未来数据不同」的对照库 */
function mutateDraw(draw) {
  const rot = (n) => (n % 49) + 1;
  return {
    ...draw,
    numbers: draw.numbers.map(rot),
    special: rot(draw.special)
  };
}

test('无未来函数：第 T 期推荐不依赖 T 期及之后的任何数据', () => {
  const samples = ['2026-287', '2026-200', '2025-100', '2024-050', '2023-001'].map(pick).filter(Boolean);

  for (const target of samples) {
    const idx = ALL.findIndex((d) => d.id === target.id);

    // 1) 只保留 T 期之前的数据作为底库，重新生成 T 期推荐
    const priorOnly = ALL.filter((d) => d.year < target.year || (d.year === target.year && d.periodNum < target.periodNum));
    const recFull = buildDailyFiveRecords(ALL, [target])[0];
    const recPriorOnly = buildDailyFiveRecords(priorOnly, [target])[0];
    assert.deepEqual(
      recFull.five.map((e) => e.numbers),
      recPriorOnly.five.map((e) => e.numbers),
      `${target.id} 的推荐不应受未来数据影响`
    );

    // 2) 把 T 期之后（时间上更晚）的所有开奖数据全部改掉，T 期推荐仍须一致
    //    底库按时间降序排列，下标越小越新，因此下标 < idx 的才是「之后」的数据
    const mutated = ALL.map((d, i) => (i < idx ? mutateDraw(d) : d));
    const recMutated = buildDailyFiveRecords(mutated, [mutated[idx]])[0];
    assert.deepEqual(
      recFull.five.map((e) => e.numbers),
      recMutated.five.map((e) => e.numbers),
      `${target.id} 的推荐不应受之后开奖数据影响`
    );

    // 3) 把 T 期自己的开奖结果改掉，T 期推荐仍须一致（推荐不能偷看当期结果）
    const selfMutated = { ...target, ...mutateDraw(target) };
    const recSelfMutated = buildDailyFiveRecords(ALL, [selfMutated])[0];
    assert.deepEqual(
      recFull.five.map((e) => e.numbers),
      recSelfMutated.five.map((e) => e.numbers),
      `${target.id} 的推荐不应受当期开奖结果影响`
    );
  }
});

test('回归样例 2026-287：直选命中口径正确（特码不计入，号码全中才算中）', () => {
  const target = pick('2026-287');
  assert.deepEqual(target.numbers, [19, 47, 38, 35, 6, 17]);
  assert.equal(target.special, 8);

  for (const [mode, size, odds] of [['pick3', 3, 650], ['pick4', 4, 7500]]) {
    const rec = buildDailyFiveRecords(ALL, [target], { mode })[0];
    for (const e of rec.five) {
      assert.ok(!e.matchedNormals.includes(target.special), '特码绝不能计入命中');
      assert.equal(e.hitCount, e.numbers.filter((n) => target.numbers.slice(0, 6).includes(n)).length);
      // 直选：这一注号码全部落在 6 个正码里才算命中
      assert.equal(e.isWin, e.hitCount === size);
      assert.equal(e.payout, e.isWin ? 10 * odds : 0);
    }
  }
});

test('回归样例 2026-287：特码口径只认开奖的最后一个号码', () => {
  const target = pick('2026-287');
  const rec = buildDailyFiveRecords(ALL, [target], { mode: 'special', oddsSpecial: 48 })[0];
  for (const e of rec.five) {
    assert.equal(e.isWin, e.numbers.includes(target.special));
    assert.equal(e.hitCount, e.isWin ? 1 : 0);
    assert.equal(e.payout, e.isWin ? 10 * 48 : 0);
  }
});

test('汇总统计与逐期记录一一对应（表格数字 = 指标卡数字）', () => {
  const targets = ALL.slice(0, 120);
  const cases = [
    { mode: 'pick3', odds: 650 },
    { mode: 'pick4', odds: 7500 },
    { mode: 'special', odds: 48 }
  ];
  for (const { mode, odds } of cases) {
    const records = buildDailyFiveRecords(ALL, targets, { stake: 10, odds3: 650, odds4: 7500, oddsSpecial: 48, mode });
    const summary = summarizeDailyFive(records, { stake: 10, odds3: 650, odds4: 7500, oddsSpecial: 48, mode });

    assert.equal(summary.periods, records.length);
    // 每注 1 注/期 → 5 注 × 1 注 × 本金
    assert.equal(summary.totalCost, records.length * 5 * 10);

    for (const agg of summary.catalog) {
      const manualWins = records.reduce((s, r) => {
        const e = r.five.find((x) => x.id === agg.id);
        return s + (e.isWin ? 1 : 0);
      }, 0);
      assert.equal(agg.winPeriods, manualWins);
      assert.equal(agg.payout, manualWins * 10 * odds);
      assert.equal(agg.cost, records.length * 10);
      assert.equal(agg.net, agg.payout - agg.cost);
    }
    assert.equal(summary.totalNet, summary.totalPayout - summary.totalCost);
  }
});

test('自选直选回放：每期都用同一组号码，且不偷看当期数据', () => {
  const targets = ALL.slice(0, 30);
  for (const [mode, custom] of [['pick3', [6, 26, 29]], ['special', [6, 26, 29, 32, 38]]]) {
    const records = buildCustomRecords(ALL, targets, { customNumbers: custom, stake: 10, mode });
    for (const r of records) {
      assert.deepEqual(r.five[0].numbers, custom);
      assert.equal(r.five[0].id, 'custom');
    }
    // 汇总时也要能统计这个自定义方案
    const summary = summarizeDailyFive(records, { stake: 10, odds3: 650, odds4: 7500, oddsSpecial: 48, mode });
    const customAgg = summary.catalog.find((c) => c.id === 'custom');
    assert.ok(customAgg);
    assert.equal(customAgg.periods, targets.length);
    assert.equal(customAgg.cost, targets.length * 10);
  }
});
