import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import { classifyHitCount, evaluate7CodeCompound } from '../src/combinatorics.js';
import { buildReplayRecords, summarizeReplay } from '../src/strategy.js';

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
    const recFull = buildReplayRecords(ALL, [target])[0];
    const recPriorOnly = buildReplayRecords(priorOnly, [target])[0];
    assert.deepEqual(
      recFull.sevenNumbers,
      recPriorOnly.sevenNumbers,
      `${target.id} 的推荐不应受未来数据影响`
    );

    // 2) 把 T 期之后（时间上更晚）的所有开奖数据全部改掉，T 期推荐仍须一致
    //    底库按时间降序排列，下标越小越新，因此下标 < idx 的才是「之后」的数据
    const mutated = ALL.map((d, i) => (i < idx ? mutateDraw(d) : d));
    const recMutated = buildReplayRecords(mutated, [mutated[idx]])[0];
    assert.deepEqual(recFull.sevenNumbers, recMutated.sevenNumbers, `${target.id} 的推荐不应受之后开奖数据影响`);

    // 3) 把 T 期自己的开奖结果改掉，T 期推荐仍须一致（推荐不能偷看当期结果）
    const selfMutated = { ...target, ...mutateDraw(target) };
    const recSelfMutated = buildReplayRecords(ALL, [selfMutated])[0];
    assert.deepEqual(recFull.sevenNumbers, recSelfMutated.sevenNumbers, `${target.id} 的推荐不应受当期开奖结果影响`);
  }
});

test('无未来函数：回放使用的历史样本严格早于目标期', () => {
  const target = pick('2026-287');
  const rec = buildReplayRecords(ALL, [target])[0];
  assert.ok(rec.priorSampleCount > 0);
  assert.ok(rec.priorSampleCount <= 64);

  const priorIds = ALL
    .filter((d) => d.year < target.year || (d.year === target.year && d.periodNum < target.periodNum))
    .slice(0, rec.priorSampleCount)
    .map((d) => d.id);
  assert.ok(priorIds.length === rec.priorSampleCount);
  assert.ok(!priorIds.includes(target.id));
});

test('回归样例 2026-287：S1 推荐 06 26 29 32 36 38 47，命中 3 个正码，三中三 1 注、四中四未中', () => {
  const target = pick('2026-287');
  assert.deepEqual(target.numbers, [19, 47, 38, 35, 6, 17]);
  assert.equal(target.special, 8);

  const rec = buildReplayRecords(ALL, [target])[0];
  assert.deepEqual(rec.sevenNumbers, [6, 26, 29, 32, 36, 38, 47]);
  assert.deepEqual(rec.matchedNormals, [6, 38, 47]);
  assert.equal(rec.matchedNormalCount, 3);
  // 特码 08 不在选号内；即便在选号内也绝不计入命中
  assert.equal(rec.specialMatched, false);

  const cls = classifyHitCount(rec.matchedNormalCount);
  assert.equal(cls.pick3.isHit, true);
  assert.equal(cls.pick3.betCount, 1);
  assert.equal(cls.pick4.isHit, false);
  assert.equal(cls.pick4.betCount, 0);

  assert.equal(rec.compoundEval.pick3.winCount, 1);
  assert.deepEqual(rec.compoundEval.pick3.winningCombos.map((c) => c.nums), [[6, 38, 47]]);
  assert.equal(rec.compoundEval.pick4.winCount, 0);
  assert.equal(rec.compoundEval.pick4.winningCombos.length, 0);
});

test('命中分类与注数：k=0..6 时三中三/四中四结论与 C(k,3)/C(k,4) 完全一致', () => {
  const expected3 = [0, 0, 0, 1, 4, 10, 20];
  const expected4 = [0, 0, 0, 0, 1, 5, 15];
  for (let k = 0; k <= 6; k++) {
    const cls = classifyHitCount(k);
    assert.equal(cls.k, k);
    assert.equal(cls.pick3.betCount, expected3[k]);
    assert.equal(cls.pick4.betCount, expected4[k]);
    assert.equal(cls.pick3.isHit, k >= 3);
    assert.equal(cls.pick4.isHit, k >= 4);

    // 与引擎实际展开的组合数量互相印证
    const picks = [1, 2, 3, 4, 5, 6, 7];
    const hitPart = picks.slice(0, k);
    const missPart = [20, 21, 22, 23, 24, 25].slice(0, 6 - k);
    const ev = evaluate7CodeCompound(picks, { numbers: [...hitPart, ...missPart], special: 49 }, { stake: 10 });
    assert.equal(ev.pick3.winCount, cls.pick3.betCount);
    assert.equal(ev.pick4.winCount, cls.pick4.betCount);
  }
});

test('汇总统计与逐期记录一一对应（表格数字 = 指标卡数字）', () => {
  const targets = ALL.slice(0, 120);
  const records = buildReplayRecords(ALL, targets, { strategyId: 'composite', stake: 10, odds3: 650, odds4: 7500 });
  const summary = summarizeReplay(records, { stake: 10, odds3: 650, odds4: 7500, betMode: 'compound7' });

  assert.equal(summary.totalPeriods, records.length);

  const manual3 = records.filter((r) => r.compoundEval.pick3.winCount > 0);
  const manual4 = records.filter((r) => r.compoundEval.pick4.winCount > 0);
  assert.equal(summary.pick3.hitPeriods, manual3.length);
  assert.equal(summary.pick4.hitPeriods, manual4.length);
  assert.equal(
    summary.pick3.totalWinBets,
    manual3.reduce((s, r) => s + r.compoundEval.pick3.winCount, 0)
  );
  assert.equal(
    summary.pick4.totalWinBets,
    manual4.reduce((s, r) => s + r.compoundEval.pick4.winCount, 0)
  );
  assert.equal(summary.pick3.totalCost, records.length * 35 * 10);
  assert.equal(summary.pick3.netProfit, summary.pick3.totalPayout - summary.pick3.totalCost);
  assert.equal(summary.pick4.netProfit, summary.pick4.totalPayout - summary.pick4.totalCost);
});

test('精选 5 注模式：统计口径切换到直选注单（5 注/期）', () => {
  const targets = ALL.slice(0, 60);
  const records = buildReplayRecords(ALL, targets, { strategyId: 'composite', stake: 10, odds3: 650, odds4: 7500 });
  const featured = summarizeReplay(records, { stake: 10, odds3: 650, odds4: 7500, betMode: 'featured5' });
  assert.equal(featured.pick3.totalCost, records.length * 5 * 10);
  assert.equal(featured.pick4.totalCost, records.length * 5 * 10);
  assert.ok(featured.pick3.totalWinBets <= records.length * 5);
  assert.ok(featured.pick4.totalWinBets <= records.length * 5);
});

test('自选 7 码回放：每期都用同一组号码，且不偷看当期数据', () => {
  const custom = [6, 26, 29, 32, 36, 38, 47];
  const targets = ALL.slice(0, 30);
  const records = buildReplayRecords(ALL, targets, { customNumbers: custom, stake: 10 });
  for (const r of records) {
    assert.deepEqual(r.sevenNumbers, custom);
    assert.equal(r.strategyId, 'custom');
  }
});
