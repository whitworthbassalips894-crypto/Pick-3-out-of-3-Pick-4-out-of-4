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

  // 四中四：4 个号 = 1 注，全中才算中
  {
    const rec = buildDailyFiveRecords(ALL, [target], { mode: 'pick4' })[0];
    for (const e of rec.five) {
      assert.ok(!e.matchedNormals.includes(target.special), '特码绝不能计入命中');
      assert.equal(e.matchedNormalCount, e.numbers.filter((n) => target.numbers.slice(0, 6).includes(n)).length);
      assert.equal(e.isWin, e.matchedNormalCount === 4);
      assert.equal(e.hitCount, e.isWin ? 1 : 0, '四中四一组只买 1 注');
      assert.equal(e.payout, e.isWin ? 10 * 7500 : 0);
    }
  }
  // 三中三：7 码复式 35 注，中 k 个正码 → 中 C(k,3) 注
  {
    const rec = buildDailyFiveRecords(ALL, [target], { mode: 'pick3' })[0];
    assert.equal(rec.five.length, 1);
    const e = rec.five[0];
    assert.equal(e.bets, 35);
    assert.ok(!e.matchedNormals.includes(target.special), '特码绝不能计入命中');
    const k = e.matchedNormalCount;
    const c3 = (n) => (n < 3 ? 0 : (n * (n - 1) * (n - 2)) / 6);
    assert.equal(e.hitCount, c3(k), `中 ${k} 个正码应中 C(${k},3) 注`);
    assert.equal(e.isWin, e.hitCount > 0);
    assert.equal(e.payout, e.hitCount * 10 * 650);
  }
});

test('回归样例 2026-287：特码口径只认开奖的最后一个号码，且逐号结算', () => {
  const target = pick('2026-287'); // 特码 08
  const rec = buildDailyFiveRecords(ALL, [target], { mode: 'special', oddsSpecial: 48 })[0];
  for (const e of rec.five) {
    const hits = e.numbers.filter((n) => n === target.special).length;
    assert.equal(e.isWin, hits > 0);
    assert.equal(e.hitCount, hits);
    assert.equal(e.payout, hits * 10 * 48, '中几个号就返几份');
  }
});

test('特码回放不是 0 命中：300 期里命中注数应接近 12/49', () => {
  // 旧版把注单写死成 5 个号，导致所有 1/3 个号的注单被丢弃 → 1759 期全 0。这里做真实回归。
  const targets = ALL.slice(0, 300);
  const records = buildDailyFiveRecords(ALL, targets, { mode: 'special', oddsSpecial: 48 });
  const summary = summarizeDailyFive(records, { mode: 'special', oddsSpecial: 48, stake: 10 });
  const expected = targets.length * (12 / 49); // 期望中奖注数 ≈ 73.5
  assert.equal(summary.catalog.length, 1, '特码只有一张清单');
  for (const agg of summary.catalog) {
    assert.ok(agg.hitSum > 0, `${agg.code} ${agg.name} 300 期一次都没中，说明命中判定坏了`);
    assert.ok(agg.hitSum > expected * 0.5 && agg.hitSum < expected * 1.6,
      `${agg.code} ${agg.name} 命中 ${agg.hitSum} 注，偏离理论值 ${expected.toFixed(1)} 太多`);
    assert.ok(agg.winPeriods > 0);
    assert.ok(agg.payout > 0);
  }
  // 整体 ROI 应落在理论值 48/49 - 1 = -2.04% 附近的小样本波动内
  assert.ok(summary.totalRoi > -60 && summary.totalRoi < 60, `300 期整体 ROI 异常：${summary.totalRoi}%`);
  assert.equal(summary.totalCost, targets.length * 12 * 10, '成本 = 期数 × 12 注 × 本金');
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
    // 特码：1 张清单 × 12 注；三中三：1 张 7 码复式 × 35 注；四中四：5 组 × 每组 1 注
    const bets = summary.betsPerOption;
    const groups = mode === 'pick4' ? 5 : 1;
    assert.equal(summary.totalCost, records.length * groups * bets * 10);

    for (const agg of summary.catalog) {
      let manualWins = 0;
      let manualBets = 0;
      for (const r of records) {
        const e = r.five.find((x) => x.id === agg.id);
        if (e.isWin) manualWins++;
        // 命中「注数」：特码 / 三中三复式按实际中奖注数，四中四一组只有 1 注
        manualBets += mode === 'pick4' ? (e.isWin ? 1 : 0) : (e.hitCount || 0);
      }
      assert.equal(agg.winPeriods, manualWins);
      assert.equal(agg.payout, manualBets * 10 * odds);
      assert.equal(agg.cost, records.length * bets * 10);
      assert.equal(agg.net, agg.payout - agg.cost);
    }
    assert.equal(summary.totalNet, summary.totalPayout - summary.totalCost);
  }
});

test('自选直选回放：每期都用同一组号码，且不偷看当期数据', () => {
  const targets = ALL.slice(0, 30);
  // 特码是 1 中 1：自选 3 个号 = 3 注（清单里只有 3 个号）
  for (const [mode, custom] of [['pick3', [6, 26, 29]], ['special', [6, 26, 29]]]) {
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
    // 特码的自选只按实际填的号码计注（3 个号 = 3 注），不是整张 12 注
    assert.equal(customAgg.cost, targets.length * (mode === 'special' ? custom.length : 1) * 10);
  }
});
