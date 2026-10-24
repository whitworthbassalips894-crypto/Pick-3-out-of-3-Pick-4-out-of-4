import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import {
  generatePeriodPlan,
  getPriorDraws,
  runHistoricalBacktest
} from '../src/strategy.js';

test('generatePeriodPlan produces deterministic 7-code compound, 5 Pick-3, 5 Pick-4, and 5 strategies', () => {
  const draws = INITIAL_DB.draws.slice(0, 100);
  const target = { year: 2026, periodNum: 297, date: '2026-10-24' };

  const planA = generatePeriodPlan(draws, target, { strategyId: 'composite' });
  const planB = generatePeriodPlan(draws, target, { strategyId: 'composite' });

  // 100% 确定性可复现
  assert.deepEqual(planA.primary7, planB.primary7);
  assert.equal(planA.primary7.length, 7);
  assert.equal(new Set(planA.primary7).size, 7);
  assert.ok(planA.primary7.every((n) => n >= 1 && n <= 49));

  // 5 注精选三中三 + 5 注精选四中四
  assert.equal(planA.featuredPick3.length, 5);
  assert.ok(planA.featuredPick3.every((t) => t.length === 3));
  assert.equal(planA.featuredPick4.length, 5);
  assert.ok(planA.featuredPick4.every((t) => t.length === 4));

  // 5 组策略方案 (S1 ~ S5)
  assert.equal(planA.strategies.length, 5);
  for (const s of planA.strategies) {
    assert.equal(s.numbers.length, 7);
    assert.equal(new Set(s.numbers).size, 7);
    assert.equal(s.top5Pick3.length, 5);
    assert.equal(s.top5Pick4.length, 5);
  }
});

test('generatePeriodPlan respects pinnedNumbers (胆码锁定)', () => {
  const draws = INITIAL_DB.draws.slice(0, 80);
  const pinned = [7, 23, 49];
  const plan = generatePeriodPlan(
    draws,
    { year: 2026, periodNum: 297, date: '2026-10-24' },
    { pinnedNumbers: pinned }
  );

  assert.equal(plan.primary7.length, 7);
  for (const p of pinned) {
    assert.ok(plan.primary7.includes(p), `Expected pinned number ${p} in ${plan.primary7}`);
  }
});

test('getPriorDraws strictly excludes target and future periods (no data leakage)', () => {
  const draws = INITIAL_DB.draws.slice(0, 50);
  const target = { year: 2026, periodNum: 280 };
  const prior = getPriorDraws(draws, target);
  assert.ok(prior.length > 0);
  assert.ok(
    prior.every((d) => d.year < 2026 || (d.year === 2026 && d.periodNum < 280))
  );
});

test('runHistoricalBacktest computes accurate summary and per-period hit details', () => {
  const sampleDraws = INITIAL_DB.draws.slice(0, 60);
  const bt = runHistoricalBacktest(sampleDraws, {
    year: 2026,
    limit: 25,
    strategyId: 'composite',
    stake: 10,
    odds3: 650,
    odds4: 7500,
    betMode: 'compound7'
  });

  assert.equal(bt.summary.totalPeriods, 25);
  assert.equal(bt.records.length, 25);
  assert.equal(bt.summary.pick3.totalCost, 25 * 35 * 10);
  assert.equal(
    bt.summary.pick3.netProfit,
    bt.summary.pick3.totalPayout - bt.summary.pick3.totalCost
  );
});
