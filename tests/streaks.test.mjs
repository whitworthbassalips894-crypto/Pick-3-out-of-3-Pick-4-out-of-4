/**
 * 连空体检单测
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import { buildDailyFiveRecords } from '../src/dailyfive.js';
import { droughtRarity, summarizeDroughts } from '../src/streaks.js';

const ALL = INITIAL_DB.draws;

/** 造一条回放记录：wins 为该期 5 注是否命中 */
const rec = (id, wins) => ({
  draw: { id, year: 2026, period: String(id).padStart(3, '0'), date: '2026-01-01' },
  five: wins.map((w, i) => ({ id: i === 0 ? 'random' : `t${i}`, code: `#${i + 1}`, name: `注${i + 1}`, numbers: [1, 2, 3, 4, 5], isWin: w }))
});

test('summarizeDroughts：当前连空 / 最长连空 / 间隔分布', () => {
  // 最新在前：空、空、中、空、中、空、空、空、中
  const records = [
    rec('009', [false, false, false, false, false]),
    rec('008', [false, false, false, false, false]),
    rec('007', [true, false, false, false, false]),
    rec('006', [false, false, false, false, false]),
    rec('005', [true, false, false, false, false]),
    rec('004', [false, false, false, false, false]),
    rec('003', [false, false, false, false, false]),
    rec('002', [false, false, false, false, false]),
    rec('001', [true, false, false, false, false])
  ];
  const s = summarizeDroughts(records);
  assert.equal(s.periods, 9);
  assert.equal(s.combined.currentDrought, 2, '最新两期都没中');
  assert.equal(s.combined.longestDrought, 3, '历史最长连空 3 期');
  assert.equal(s.combined.longestDroughtTo, '2026年第002期');
  assert.equal(s.combined.hitPeriods, 3);
  assert.equal(s.combined.emptyPeriods, 6);
  // 间隔序列（两次中奖之间空了几期）：007 之前空 2、005→007 空 1、001→005 空 3
  const gapTotal = s.combined.distribution.reduce((a, b) => a + b.count, 0);
  assert.equal(gapTotal, 3, '共有 3 个间隔');
  assert.equal(s.combined.meanGap, 2);
  assert.equal(s.combined.medianGap, 2);
});

test('summarizeDroughts：逐注连空独立统计', () => {
  const records = [
    rec('003', [false, true, false, false, false]),
    rec('002', [false, false, false, false, false]),
    rec('001', [true, true, false, false, false])
  ];
  const s = summarizeDroughts(records);
  const t2 = s.perTicket.find((t) => t.code === '#2');
  assert.equal(t2.winPeriods, 2);
  assert.equal(t2.currentDrought, 0, '#2 最新一期就中了');
  const t3 = s.perTicket.find((t) => t.code === '#3');
  assert.equal(t3.winPeriods, 0);
  assert.equal(t3.currentDrought, 3);
  assert.equal(t3.longestDrought, 3);
  assert.equal(s.perTicket.length, 5);
});

test('summarizeDroughts：理论全空率与平均覆盖一致', () => {
  const s = summarizeDroughts([rec('001', [false, false, false, false, false])]);
  assert.equal(s.combined.avgCoverage, 5, '5 注都是 [1,2,3,4,5]，只覆盖 5 个号');
  assert.equal(s.combined.theoreticalAnyHit, Number(((5 / 49) * 100).toFixed(2)));
  assert.ok(s.combined.theoreticalEmptyRate > 89 && s.combined.theoreticalEmptyRate < 90);
});

test('droughtRarity：连空越久越罕见，但绝不改变下一期概率', () => {
  const p = 19 / 49; // 每期至少中 1 注 ≈ 38.8%
  assert.ok(droughtRarity(0, p).atLeast > 99);
  assert.ok(droughtRarity(3, p).atLeast < 30);
  assert.ok(droughtRarity(12, p).atLeast < 1);
  assert.ok(droughtRarity(12, p).label.includes('罕见'));
  // 单调递减
  let prev = 101;
  for (let n = 0; n <= 15; n++) {
    const cur = droughtRarity(n, p).atLeast;
    assert.ok(cur <= prev, `连空 ${n} 期的概率不该比上一档更大`);
    prev = cur;
  }
});

test('真实回放：300 期的连空统计自洽（最长连空 >= 当前连空，分布占比合计 100%）', () => {
  const records = buildDailyFiveRecords(ALL, ALL.slice(0, 300), { mode: 'special' });
  const s = summarizeDroughts(records);
  assert.equal(s.periods, 300);
  assert.ok(s.combined.longestDrought >= s.combined.currentDrought);
  assert.equal(s.combined.hitPeriods + s.combined.emptyPeriods, 300);
  const rateSum = s.combined.distribution.reduce((a, b) => a + b.rate, 0);
  assert.ok(Math.abs(rateSum - 1) < 1e-9, `分布占比合计应为 1，实际 ${rateSum}`);
  // 实测全空率应接近理论全空率（允许 8 个百分点误差）
  assert.ok(Math.abs(s.combined.emptyRate - s.combined.theoreticalEmptyRate) < 8,
    `实测全空率 ${s.combined.emptyRate}% 与理论 ${s.combined.theoreticalEmptyRate}% 差太多`);
  for (const t of s.perTicket) {
    assert.ok(t.longestDrought >= t.currentDrought);
    assert.ok(t.p90Gap >= t.medianGap - 1e-9);
  }
});
