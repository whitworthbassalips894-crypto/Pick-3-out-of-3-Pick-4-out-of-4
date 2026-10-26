/**
 * 「每日 5 注」引擎单测
 * 模式参考 https://whitworthbassalips894-crypto.github.io/lottery-tool/
 *   #1 🎲 随机基线（纯随机对照，可重摇） + #2~#5 精选
 *
 * 三种玩法（playMode）：
 *   special 特码：每注 5 个号，命中 = 开奖的最后一个号码（特码）落在这 5 个号里
 *   pick3   三中三：每注 3 个号，全部落在 6 个正码里
 *   pick4   四中四：每注 4 个号，全部落在 6 个正码里
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import {
  DAILY_FIVE_CATALOG,
  DIRECT_SIZES,
  RANDOM_EXPECTED_HITS,
  buildCustomRecords,
  buildDailyFiveRecords,
  buildOmissionSeries,
  cleanNumbers,
  computeDailyFiveFeatures,
  generateDailyFive,
  omissionPercentile,
  randomExpectedHits,
  reboundStrength,
  summarizeDailyFive
} from '../src/dailyfive.js';
import { getPriorDraws } from '../src/strategy.js';

const ALL = INITIAL_DB.draws;
const pick = (id) => ALL.find((d) => d.id === id);

const TARGET = { year: 2026, periodNum: 297, date: '2026-10-24' };
const MODES = [
  { mode: 'special', size: 5, odds: 48 },
  { mode: 'pick3', size: 3, odds: 650 },
  { mode: 'pick4', size: 4, odds: 7500 }
];

test('目录：1 注纯随机 + 4 注精选，编号 #1~#5', () => {
  assert.equal(DAILY_FIVE_CATALOG.length, 5);
  assert.deepEqual(DAILY_FIVE_CATALOG.map((m) => m.code), ['#1', '#2', '#3', '#4', '#5']);
  assert.equal(DAILY_FIVE_CATALOG.filter((m) => m.random).length, 1);
  assert.equal(DAILY_FIVE_CATALOG[0].id, 'random');
  assert.equal(DAILY_FIVE_CATALOG[0].random, true);
  for (const m of DAILY_FIVE_CATALOG.slice(1)) assert.equal(m.random, false);
});

test('直选支持 5 码（特码）/ 3 码（三中三）/ 4 码（四中四）', () => {
  assert.deepEqual(DIRECT_SIZES, [3, 4, 5]);
});

test('generateDailyFive：三种玩法每注号码个数正确、合法且不重复', () => {
  for (const { mode, size } of MODES) {
    const plan = generateDailyFive(ALL, TARGET, { mode });
    assert.equal(plan.mode, mode);
    assert.equal(plan.size, size);
    assert.equal(plan.five.length, 5);
    for (const e of plan.five) {
      assert.equal(e.numbers.length, size, `${mode} 的 ${e.name} 号码个数应为 ${size}`);
      assert.equal(new Set(e.numbers).size, size);
      assert.ok(e.numbers.every((n) => n >= 1 && n <= 49));
      // 形态统计：奇偶 / 三区 / 波色合计 = 每注号码数
      assert.equal(e.shape.odd + e.shape.even, size);
      assert.equal(e.shape.zone1 + e.shape.zone2 + e.shape.zone3, size);
      assert.equal(e.shape.red + e.shape.blue + e.shape.green, size);
      // 热 / 温 / 冷必须互斥，不能出现负数
      assert.ok(e.shape.hot >= 0 && e.shape.warm >= 0 && e.shape.cold >= 0);
      assert.equal(e.shape.hot + e.shape.warm + e.shape.cold, size);
    }
  }
});

test('默认玩法 = 特码（每注 5 个号）', () => {
  const plan = generateDailyFive(ALL, TARGET);
  assert.equal(plan.mode, 'special');
  assert.ok(plan.five.every((e) => e.numbers.length === 5));
});

test('特码玩法的 4 注精选用的是特码自己的历史（名称与说明随之切换）', () => {
  const plan = generateDailyFive(ALL, TARGET, { mode: 'special' });
  const names = plan.five.slice(1).map((e) => e.name);
  assert.deepEqual(names, ['特码热势', '特码遗漏回补', '特码尾数共振', '特码三区均衡']);
  const pick3 = generateDailyFive(ALL, TARGET, { mode: 'pick3' });
  assert.deepEqual(pick3.five.slice(1).map((e) => e.name), ['热势恒强', '遗漏回补', '关联共振', '三区波色均衡']);
});

test('特码玩法的 4 注精选要照顾三区分布（每区最多 2 个号；随机注不设限）', () => {
  // 多期抽查，确认是「规则」而不是某一期的巧合
  for (const target of ALL.slice(1, 41).map((d) => ({ year: d.year, periodNum: d.periodNum, date: d.date }))) {
    const plan = generateDailyFive(ALL, target, { mode: 'special' });
    for (const e of plan.five.slice(1)) {
      const zoneCount = { 1: 0, 2: 0, 3: 0 };
      for (const n of e.numbers) zoneCount[n <= 16 ? 1 : n <= 33 ? 2 : 3]++;
      assert.ok(Math.max(...Object.values(zoneCount)) <= 2, `${target.periodNum} 期 ${e.name} 三区分布过于集中`);
    }
  }
});

test('特码玩法杀上期特码：5 注（含随机注）都不含上期特码，且重摇后依然不含', () => {
  for (const target of ALL.slice(1, 31).map((d) => ({ year: d.year, periodNum: d.periodNum, date: d.date }))) {
    const prior = getPriorDraws(ALL, target);
    const lastSpecial = prior[0].special;
    assert.ok(Number.isInteger(lastSpecial) && lastSpecial >= 1 && lastSpecial <= 49);

    for (const randomSalt of [0, 1, 2, 7]) {
      const plan = generateDailyFive(ALL, target, { mode: 'special', randomSalt });
      assert.deepEqual(plan.killedNumbers, [lastSpecial], '杀号信息应记录上期特码');
      assert.equal(plan.lastSpecial, lastSpecial);
      for (const e of plan.five) {
        assert.ok(!e.numbers.includes(lastSpecial), `${target.periodNum} 期 ${e.code} ${e.name} 含上期特码 ${lastSpecial}`);
        assert.deepEqual(e.killed, [lastSpecial]);
        assert.ok(e.rationale.includes('杀上期特码'), '说明里要写清已杀上期特码');
        assert.equal(e.numbers.length, 5);
      }
      // 随机注仍在 48 个号里机选，只是不含上期特码
      assert.equal(new Set(plan.five[0].numbers).size, 5);
    }
  }
});

test('特码玩法可以关掉杀号（excludeLastSpecial: false）', () => {
  const plan = generateDailyFive(ALL, TARGET, { mode: 'special', excludeLastSpecial: false });
  assert.deepEqual(plan.killedNumbers, []);
  for (const e of plan.five) assert.deepEqual(e.killed, []);
});

test('正码玩法（三中三 / 四中四）不杀号：上期特码不是命中对象', () => {
  for (const mode of ['pick3', 'pick4']) {
    const plan = generateDailyFive(ALL, TARGET, { mode });
    assert.deepEqual(plan.killedNumbers, []);
    assert.equal(plan.lastSpecial, null);
    for (const e of plan.five) assert.deepEqual(e.killed, []);
  }
});

test('4 注精选里同一个号码最多进 2 注（跨注重复硬上限）', () => {
  for (const target of ALL.slice(1, 61).map((d) => ({ year: d.year, periodNum: d.periodNum, date: d.date }))) {
    const plan = generateDailyFive(ALL, target, { mode: 'special' });
    const counts = new Map();
    for (const e of plan.five.slice(1)) for (const n of e.numbers) counts.set(n, (counts.get(n) || 0) + 1);
    for (const [n, c] of counts) {
      assert.ok(c <= 2, `${target.periodNum} 期号码 ${n} 出现在 ${c} 注精选里`);
    }
    // 共识号仍然是「≥2 注精选同选」，不会被这条规则吃掉
    const expected = [...counts.entries()].filter(([, c]) => c >= 2).map(([n]) => n).sort((a, b) => a - b);
    assert.deepEqual([...plan.consensus].sort((a, b) => a - b), expected);
    // 5 注合起来覆盖面应该比 4 注「无脑重复」更宽
    assert.ok(new Set(plan.five.flatMap((e) => e.numbers)).size >= 15);
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

test('特码特征表：统计的是「作为特码出现」的次数与遗漏', () => {
  const prior = getPriorDraws(ALL, TARGET);
  const f = computeDailyFiveFeatures(prior, TARGET);
  let total = 0;
  for (let n = 1; n <= 49; n++) {
    const st = f.specialStats[n];
    assert.ok(st, `缺少 ${n} 号的特码特征`);
    assert.ok(st.freq30 >= 0 && st.freq30 <= 30);
    assert.ok(st.freq180 >= 0 && st.freq180 <= 180);
    assert.ok(st.omission >= 0);
    assert.ok(st.omissionPct >= 0 && st.omissionPct <= 1);
    total += st.freq180;
  }
  // 180 期里最多出现 180 个特码
  assert.ok(total <= 180, `特码次数合计应 ≤ 180，实际 ${total}`);
});

test('buildDailyFiveRecords 逐期回放：直选命中 = 号码全部落在前 6 个正码里，特码不计入', () => {
  const target = pick('2026-287');
  assert.deepEqual(target.numbers, [19, 47, 38, 35, 6, 17]);
  assert.equal(target.special, 8);

  for (const { mode, size, odds } of MODES.filter((m) => m.mode !== 'special')) {
    const rec = buildDailyFiveRecords(ALL, [target], { mode })[0];
    assert.equal(rec.five.length, 5);
    assert.equal(rec.size, size);
    for (const e of rec.five) {
      assert.ok(!e.matchedNormals.includes(8), '特码 08 绝不能被算作命中');
      assert.equal(e.matchedNormalCount, e.matchedNormals.length);
      assert.ok(e.hitCount >= 0 && e.hitCount <= size);
      assert.equal(e.isWin, e.hitCount === size);
      assert.equal(e.payout, e.isWin ? 10 * odds : 0);
    }
  }
});

test('buildDailyFiveRecords 特码口径：命中 = 开奖特码落在这 5 个号里', () => {
  const target = pick('2026-287'); // 特码 08
  const rec = buildDailyFiveRecords(ALL, [target], { mode: 'special' })[0];
  assert.equal(rec.five.length, 5);
  for (const e of rec.five) {
    const covers = e.numbers.includes(8);
    assert.equal(e.isWin, covers);
    assert.equal(e.hitCount, covers ? 1 : 0);
    assert.equal(e.payout, covers ? 10 * 48 : 0);
    // 正码命中个数不参与特码判定
    assert.ok(e.matchedNormalCount <= 1);
  }
});

test('无未来函数：把未来开奖全部改掉，T 期推荐不变', () => {
  const target = pick('2026-287');
  const idx = ALL.findIndex((d) => d.id === target.id);
  const rot = (n) => (n % 49) + 1;
  const mutated = ALL.map((d, i) => (i < idx
    ? { ...d, numbers: d.numbers.map(rot), special: rot(d.special) }
    : d));

  for (const { mode } of MODES) {
    const recFull = buildDailyFiveRecords(ALL, [target], { mode })[0];
    const recMutated = buildDailyFiveRecords(mutated, [mutated[idx]], { mode })[0];
    assert.deepEqual(
      recFull.five.map((e) => e.numbers),
      recMutated.five.map((e) => e.numbers),
      `${mode} 的推荐不应受之后开奖数据影响`
    );
  }
});

test('无未来函数：只保留 T 期之前的数据，T 期推荐不变', () => {
  const target = pick('2026-287');
  const priorOnly = ALL.filter((d) => d.year < target.year || (d.year === target.year && d.periodNum < target.periodNum));
  for (const { mode } of MODES) {
    const recFull = buildDailyFiveRecords(ALL, [target], { mode })[0];
    const recPriorOnly = buildDailyFiveRecords(priorOnly, [target], { mode })[0];
    assert.deepEqual(
      recFull.five.map((e) => e.numbers),
      recPriorOnly.five.map((e) => e.numbers)
    );
  }
});

test('summarizeDailyFive：每注每期只算 1 注成本，返奖 = 本金 × 赔率', () => {
  const targets = ALL.slice(0, 60);
  for (const { mode, size, odds } of MODES) {
    const records = buildDailyFiveRecords(ALL, targets, { stake: 10, odds3: 650, odds4: 7500, oddsSpecial: 48, mode });
    const summary = summarizeDailyFive(records, { stake: 10, odds3: 650, odds4: 7500, oddsSpecial: 48, mode });

    assert.equal(summary.periods, records.length);
    assert.equal(summary.catalog.length, 5);
    assert.equal(summary.size, size);
    assert.equal(summary.mode, mode);
    assert.equal(summary.odds, odds);

    for (const agg of summary.catalog) {
      assert.equal(agg.periods, records.length);
      // 每注每期 1 注 → 成本 = 期数 × 本金
      assert.equal(agg.cost, records.length * 10);
      const manualWins = records.reduce((s, r) => {
        const e = r.five.find((x) => x.id === agg.id);
        return s + (e.isWin ? 1 : 0);
      }, 0);
      assert.equal(agg.winPeriods, manualWins);
      assert.equal(agg.payout, manualWins * 10 * odds);
      assert.equal(agg.net, agg.payout - agg.cost);
      assert.equal(agg.roi, Number(((agg.net / agg.cost) * 100).toFixed(2)));
    }
    assert.equal(summary.totalCost, summary.catalog.reduce((a, c) => a + c.cost, 0));
    assert.equal(summary.totalPayout, summary.catalog.reduce((a, c) => a + c.payout, 0));
    assert.equal(summary.totalNet, summary.totalPayout - summary.totalCost);
  }
});

test('随机期望：特码 5/49 ≈ 0.102，三中三 18/49 ≈ 0.367，四中四 24/49 ≈ 0.490', () => {
  assert.ok(Math.abs(randomExpectedHits('special') - 5 / 49) < 1e-12);
  assert.ok(Math.abs(randomExpectedHits('pick3') - 18 / 49) < 1e-12);
  assert.ok(Math.abs(randomExpectedHits('pick4') - 24 / 49) < 1e-12);
  assert.ok(Math.abs(RANDOM_EXPECTED_HITS - 18 / 49) < 1e-12);
});

test('buildCustomRecords：自选直选每期都用同一组号码，且不偷看当期数据', () => {
  const targets = ALL.slice(0, 20);
  const custom3 = [6, 26, 29];
  const records3 = buildCustomRecords(ALL, targets, { customNumbers: custom3, stake: 10, mode: 'pick3' });
  assert.equal(records3.length, targets.length);
  for (const r of records3) {
    assert.equal(r.five.length, 1);
    assert.deepEqual(r.five[0].numbers, custom3);
    assert.equal(r.five[0].id, 'custom');
    assert.equal(r.size, 3);
  }
  // 号码个数不足时不生成任何记录
  assert.equal(buildCustomRecords(ALL, targets, { customNumbers: [1, 2], mode: 'pick3' }).length, 0);
  assert.equal(buildCustomRecords(ALL, targets, { customNumbers: [1, 2, 3], mode: 'pick4' }).length, 0);
  // 特码玩法：5 个号
  const records5 = buildCustomRecords(ALL, targets, { customNumbers: [6, 26, 29, 32, 38], stake: 10, mode: 'special' });
  assert.equal(records5.length, targets.length);
  assert.deepEqual(records5[0].five[0].numbers, [6, 26, 29, 32, 38]);
  assert.equal(records5[0].size, 5);
  assert.equal(buildCustomRecords(ALL, targets, { customNumbers: [1, 2, 3, 4], mode: 'special' }).length, 0);
});

/* -------------------------------------------------- 遗漏 bug 回归（2026-10-26） */

test('buildOmissionSeries：当前遗漏 / 间距方向 / 最近一次出现都不能算反', () => {
  // 8 号在第 0、2、3、4 期出现（最新在前），第 1 期没有 → 当前遗漏 0，间距 [1,0,0]
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const row = new Array(50).fill(0);
    if (i !== 1) row[8] = 1;
    rows.push(row);
  }
  const { omission, gapHistory, lastSeen } = buildOmissionSeries(rows, 5);
  assert.equal(omission[8], 0, '最近一期就出现过，当前遗漏必须是 0');
  assert.equal(lastSeen[8], 0);
  assert.deepEqual(gapHistory[8], [1, 0, 0], '间距必须是正数且按新→旧排列');
  assert.ok(gapHistory[8].every((g) => g >= 0), '间距不能出现负数（旧 bug 就是负数）');

  // 9 号只在第 3 期出现 → 遗漏 3 期，没有间距样本
  const rows2 = [];
  for (let i = 0; i < 5; i++) {
    const row = new Array(50).fill(0);
    if (i === 3) row[9] = 1;
    rows2.push(row);
  }
  const o2 = buildOmissionSeries(rows2, 5);
  assert.equal(o2.omission[9], 3);
  assert.deepEqual(o2.gapHistory[9], []);

  // 号 10 从未出现 → 记满窗口
  assert.equal(o2.omission[10], 5);
  assert.equal(o2.lastSeen[10], -1);
});

test('omissionPercentile：分位数必须落在 0~1，且随当前遗漏单调不减', () => {
  const gaps = [0, 1, 2, 5, 9];
  assert.equal(omissionPercentile(gaps, 0), 0.2);
  assert.equal(omissionPercentile(gaps, 4), 0.6);
  assert.equal(omissionPercentile(gaps, 100), 1);
  assert.equal(omissionPercentile([], 3), 1);
  let prev = -1;
  for (let cur = 0; cur <= 12; cur++) {
    const p = omissionPercentile(gaps, cur);
    assert.ok(p >= prev && p >= 0 && p <= 1);
    prev = p;
  }
});

test('computeDailyFiveFeatures：遗漏/分位与真实历史一致（防止再退回恒为 1）', () => {
  const target = ALL.find((d) => d.id === '2026-287');
  const prior = getPriorDraws(ALL, target);
  const f = computeDailyFiveFeatures(prior, target);

  const truthNormal = (n) => {
    for (let i = 0; i < 180; i++) if (prior[i].numbers.slice(0, 6).map(Number).includes(n)) return i;
    return 180;
  };
  const truthSpecial = (n) => {
    for (let i = 0; i < Math.min(prior.length, 400); i++) if (Number(prior[i].special) === n) return i;
    return Math.min(prior.length, 400);
  };
  for (let n = 1; n <= 49; n++) {
    assert.equal(f.stats[n].omission, truthNormal(n), `${n} 号正码遗漏算错了`);
    assert.equal(f.specialStats[n].omission, truthSpecial(n), `${n} 号特码遗漏算错了`);
    assert.ok(f.stats[n].omissionPct >= 0 && f.stats[n].omissionPct <= 1);
    assert.ok(f.stats[n].gapCount >= 0);
  }
  // 旧 bug 的两个症状：分位恒为 1、短休窗恒为 false
  const pcts = new Set();
  for (let n = 1; n <= 49; n++) pcts.add(f.stats[n].omissionPct.toFixed(3));
  assert.ok(pcts.size > 5, `遗漏分位退化成了 ${pcts.size} 个取值`);
  const shortRests = Array.from({ length: 49 }, (_, i) => f.stats[i + 1].isShortRest).filter(Boolean).length;
  assert.ok(shortRests > 0, '短休回补窗（isShortRest）不该恒为 false');
});

test('遗漏分位分布要接近均匀（不能集中在 0 或 1）', () => {
  const buckets = new Array(10).fill(0);
  let total = 0;
  for (const draw of ALL.slice(1, 19)) {
    const f = computeDailyFiveFeatures(getPriorDraws(ALL, draw), draw);
    for (let n = 1; n <= 49; n++) {
      buckets[Math.min(9, Math.floor(f.stats[n].omissionPct * 10))]++;
      total++;
    }
  }
  for (const b of buckets) assert.ok(b / total > 0.02, `分位分布过于集中：${buckets.join(',')}`);
});

test('reboundStrength：80%~98% 递增，超过 98% 不再继续加码', () => {
  assert.ok(reboundStrength(0) === 0);
  assert.ok(reboundStrength(0.4) < reboundStrength(0.8));
  assert.ok(reboundStrength(0.8) < reboundStrength(0.9));
  assert.ok(reboundStrength(0.9) < reboundStrength(0.97));
  assert.equal(reboundStrength(0.99), 1.2, '极端长空不该拿最高分');
  assert.equal(reboundStrength(1), 1.2);
  assert.ok(reboundStrength(0.97) > reboundStrength(1));
});

test('cleanNumbers：去重 + 过滤非法号码 + 只取前 limit 个', () => {
  assert.deepEqual(cleanNumbers([15, 44, 27, 33, 33, 18]), [15, 44, 27, 33, 18]);
  assert.deepEqual(cleanNumbers([1, 0, 50, 'x', 2, 3]), [1, 2, 3]);
  assert.deepEqual(cleanNumbers([1, 2, 3, 4, 5, 6, 7], 6), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(cleanNumbers(null), []);
});

test('坏行（2022-132 正码重复）不会让同一个号被记两次频率', () => {
  const badRow = ALL.find((d) => d.id === '2022-132');
  assert.deepEqual(badRow.numbers, [15, 44, 27, 33, 33, 18]);
  const target = ALL.find((d) => d.id === '2022-133');
  const withBad = computeDailyFiveFeatures(getPriorDraws(ALL, target), target);
  // 把坏行整期去掉后，统计口径应当基本一致（坏行被隔离，不参与统计）
  const withoutBad = computeDailyFiveFeatures(
    getPriorDraws(ALL, target).filter((d) => d.id !== '2022-132'),
    target
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(withBad.stats).map((n) => [n, withBad.stats[n].omission])),
    Object.fromEntries(Object.keys(withoutBad.stats).map((n) => [n, withoutBad.stats[n].omission]))
  );
});
