/**
 * 「每日 5 注」引擎单测
 * 模式参考 https://whitworthbassalips894-crypto.github.io/lottery-tool/
 *   #1 🎲 随机基线（纯随机对照，可重摇） + #2~#5 精选
 *
 * 三种玩法（playMode）：
 *   special 特码：**一张 12 号清单**（1 个号 = 1 注，共 12 注），
 *                命中 = 开奖的最后一个号码（特码）落在清单里
 *   pick3   三中三：每注 3 个号，全部落在 6 个正码里
 *   pick4   四中四：每注 4 个号，全部落在 6 个正码里
 *
 * 特码为什么是清单而不是 5 组：分组是「一组 = 一注组合」的形态（三中三 / 四中四），
 * 特码 1 个号就已经是一注，分组对它没有数学含义，只是从三中三继承下来的壳。
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
  anyHitProbability,
  randomExpectedHits,
  summarizeDailyFive
} from '../src/dailyfive.js';
import { getPriorDraws } from '../src/strategy.js';

const ALL = INITIAL_DB.draws;
const pick = (id) => ALL.find((d) => d.id === id);

const TARGET = { year: 2026, periodNum: 297, date: '2026-10-24' };
const MODES = [
  { mode: 'special', size: 12, odds: 48, bets: 12 },
  { mode: 'pick3', size: 3, odds: 650 },
  { mode: 'pick4', size: 4, odds: 7500 }
];
/** 走「5 组」骨架的玩法（特码在 r17 起改成一张 12 号清单） */
const GROUP_MODES = MODES.filter((m) => m.mode !== 'special');

test('目录：1 注纯随机 + 4 注精选，编号 #1~#5', () => {
  assert.equal(DAILY_FIVE_CATALOG.length, 5);
  assert.deepEqual(DAILY_FIVE_CATALOG.map((m) => m.code), ['#1', '#2', '#3', '#4', '#5']);
  assert.equal(DAILY_FIVE_CATALOG.filter((m) => m.random).length, 1);
  assert.equal(DAILY_FIVE_CATALOG[0].id, 'random');
  assert.equal(DAILY_FIVE_CATALOG[0].random, true);
  for (const m of DAILY_FIVE_CATALOG.slice(1)) assert.equal(m.random, false);
});

test('直选支持 3 码（三中三）/ 4 码（四中四）；特码走 1 中 1，不在直选口径里', () => {
  assert.deepEqual(DIRECT_SIZES, [3, 4]);
});

test('generateDailyFive：直选 5 组 / 特码 1 张清单，号码个数正确、合法且不重复', () => {
  // 特码：1 张清单、12 个号、12 注
  const special = generateDailyFive(ALL, TARGET, { mode: 'special' });
  assert.equal(special.mode, 'special');
  assert.equal(special.size, 12);
  assert.equal(special.layout, 'list');
  assert.equal(special.five.length, 1, '特码只应有 1 张清单');
  const list = special.five[0];
  assert.equal(list.numbers.length, 12);
  assert.equal(new Set(list.numbers).size, 12, '12 个号必须互不重复（不浪费任何一注）');
  assert.ok(list.numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 49));
  assert.equal(list.shape.odd + list.shape.even, 12);
  assert.equal(list.shape.zone1 + list.shape.zone2 + list.shape.zone3, 12);
  assert.equal(list.shape.red + list.shape.blue + list.shape.green, 12);
  assert.equal(list.shape.hot + list.shape.warm + list.shape.cold, 12);
  assert.deepEqual(list.breakdown.map((b) => b.count), [3, 3, 2, 4], '🎲3 / 🔥3 / 🎯2 / ⚖️4');

  for (const { mode, size } of GROUP_MODES) {
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

test('默认玩法 = 特码（1 中 1：一张 12 号清单 = 12 注）', () => {
  const plan = generateDailyFive(ALL, TARGET);
  assert.equal(plan.mode, 'special');
  assert.equal(plan.size, 12);
  assert.equal(plan.coverage.betsPerOption, 12, '1 个号 = 1 注 → 12 个号 = 12 注');
  assert.equal(plan.coverage.totalBets, 12);
  assert.equal(plan.coverage.distinct, 12);
  assert.equal(plan.coverage.overlap, 0, '随机号先选、精选避开它 → 不重复');
  assert.ok(plan.five.every((e) => e.numbers.length === 12));
  assert.ok(plan.five.every((e) => e.numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 49)));
});

test('直选 5 注固定为：完全随机 / 热号 / 冷号 / 形态均衡 / 补位覆盖；特码是 1 张清单', () => {
  for (const mode of ['pick3', 'pick4']) {
    const plan = generateDailyFive(ALL, TARGET, { mode });
    assert.deepEqual(plan.five.map((e) => e.id), ['random', 'hot', 'cold', 'shape', 'cover']);
    assert.deepEqual(plan.five.map((e) => e.code), ['#1', '#2', '#3', '#4', '#5']);
    assert.deepEqual(plan.five.map((e) => e.name), ['完全随机', '热号', '冷号', '形态均衡', '补位覆盖']);
    assert.equal(plan.five.filter((e) => e.random).length, 1);
  }
  // 特码：只有一张清单，四个风格都在清单内部（🎲3 / 🔥3 / 🎯2 / ⚖️4）
  const special = generateDailyFive(ALL, TARGET, { mode: 'special' });
  assert.equal(special.five.length, 1);
  assert.equal(special.five[0].id, 'specialList');
  assert.deepEqual(special.five[0].breakdown.map((b) => b.id), ['random', 'hot', 'cold', 'balance']);
  assert.ok(special.five[0].rationale.includes('特码'), '特码清单的说明要用特码口径');
  const pick3 = generateDailyFive(ALL, TARGET, { mode: 'pick3' });
  assert.ok(!pick3.five[1].rationale.includes('特码'), '正码玩法不该出现特码口径的说明');
});

test('特码 12 号整体形态：奇偶 6:6、大小 6:6、三区 4:4:4（不再是一堆中位号）', () => {
  for (const target of ALL.slice(1, 81).map((d) => ({ year: d.year, periodNum: d.periodNum, date: d.date }))) {
    const plan = generateDailyFive(ALL, target, { mode: 'special' });
    const nums = plan.five[0].numbers;
    assert.equal(nums.length, 12);
    assert.equal(nums.filter((n) => n % 2 === 1).length, 6, `${target.periodNum} 期奇偶不是 6:6`);
    assert.equal(nums.filter((n) => n >= 25).length, 6, `${target.periodNum} 期大小不是 6:6`);
    assert.equal(nums.filter((n) => n <= 16).length, 4, `${target.periodNum} 期一区不是 4 个`);
    assert.equal(nums.filter((n) => n > 16 && n <= 33).length, 4, `${target.periodNum} 期二区不是 4 个`);
    assert.equal(nums.filter((n) => n > 33).length, 4, `${target.periodNum} 期三区不是 4 个`);
  }
});

test('回归：特码清单不再「每期都差不多」（旧版 300 期里 24% 是同一组 16·25·35）', () => {
  const seen = new Set();
  for (const d of ALL.slice(1, 201)) {
    const plan = generateDailyFive(ALL, { year: d.year, periodNum: d.periodNum, date: d.date }, { mode: 'special' });
    seen.add(plan.five[0].numbers.join(','));
  }
  assert.equal(seen.size, 200, `200 期应有 200 种不同清单，实际 ${seen.size} 种`);
});

test('4 注精选之间互不重叠；随机注不受限制（可以有重叠）', () => {
  for (const target of ALL.slice(1, 41).map((d) => ({ year: d.year, periodNum: d.periodNum, date: d.date }))) {
    // 特码：整张清单 12 个号互不重复
    const listPlan = generateDailyFive(ALL, target, { mode: 'special' });
    const allList = listPlan.five.flatMap((e) => e.numbers);
    assert.equal(new Set(allList).size, allList.length, '特码清单出现了重复号码');
    assert.equal(new Set(allList).size, 12);

    for (const mode of ['pick3', 'pick4']) {
      const plan = generateDailyFive(ALL, target, { mode });
      const size = plan.size;

      // #2~#5：互不重复，并集正好 4 × size
      const picked = plan.five.slice(1).flatMap((e) => e.numbers);
      assert.equal(new Set(picked).size, picked.length, `${mode} 的精选四注出现了重复号码`);
      assert.equal(new Set(picked).size, size * 4);

      // 每一注自身号码数正确、内部不重复
      for (const e of plan.five) {
        assert.equal(e.numbers.length, size);
        assert.equal(new Set(e.numbers).size, size);
        assert.ok(e.numbers.every((n) => n >= 1 && n <= 49));
      }

      // 5 注整体：允许重叠，但不会超过 5 × size
      const all = plan.five.flatMap((e) => e.numbers);
      assert.ok(new Set(all).size <= size * 5);
      assert.equal(plan.coverage.distinct, new Set(all).size);
      assert.equal(plan.coverage.overlap, size * 5 - plan.coverage.distinct);

      // 不再有「杀号」这类伪优化
      assert.deepEqual(plan.killedNumbers, []);
      for (const e of plan.five) assert.deepEqual(e.killed, []);
      assert.deepEqual(plan.consensus, []);
    }
  }
});

test('特码清单里的 🎲 随机号：纯 49 选 3，覆盖均匀，且重摇只动这 3 个号', () => {
  // 统计 200 期里每个号被随机抽中的次数，应当接近 200×3/49 ≈ 12.2
  const hits = new Array(50).fill(0);
  for (const d of ALL.slice(1, 201)) {
    const plan = generateDailyFive(ALL, { year: d.year, periodNum: d.periodNum, date: d.date }, { mode: 'special' });
    const randoms = (plan.five[0].breakdown || []).find((b) => b.id === 'random').numbers;
    assert.equal(randoms.length, 3, '随机号必须正好 3 个');
    for (const n of randoms) hits[n]++;
  }
  let used = 0;
  let sum = 0;
  for (let n = 1; n <= 49; n++) {
    if (hits[n] > 0) used++;
    sum += hits[n];
  }
  assert.equal(used, 49, `49 个号都应该被随机抽到过，实际 ${used} 个`);
  assert.equal(sum, 200 * 3);
  const avg = sum / 49;
  assert.ok(avg > 10 && avg < 15, `随机均值异常：${avg.toFixed(2)}`);

  // 重摇只影响 🎲 三个号，精选 9 个号不动
  const base = generateDailyFive(ALL, TARGET, { mode: 'special', randomSalt: 0 });
  const rerolled = generateDailyFive(ALL, TARGET, { mode: 'special', randomSalt: 3 });
  const rand = (p) => (p.five[0].breakdown.find((b) => b.id === 'random') || {}).numbers || [];
  assert.notDeepEqual(rand(base), rand(rerolled), '重摇必须换掉随机号');
  assert.notDeepEqual(base.five[0].numbers, rerolled.five[0].numbers);
});

test('coverage：特码 = 并集/49，直选 = 容斥精确值（≤ 5 × 单注，且 ≥ 单注）', () => {
  for (const mode of ['special', 'pick3', 'pick4']) {
    for (const target of ALL.slice(1, 21).map((d) => ({ year: d.year, periodNum: d.periodNum, date: d.date }))) {
      const plan = generateDailyFive(ALL, target, { mode });
      const cov = plan.coverage;
      const tickets = plan.five.map((e) => e.numbers);
      assert.ok(Math.abs(cov.anyHit - anyHitProbability(tickets, mode)) < 1e-12, 'coverage 必须与容斥公式一致');

      if (mode === 'special') {
        assert.ok(Math.abs(cov.perBet - 1 / 49) < 1e-15, '特码：单注（1 个号）命中 = 1/49');
        assert.ok(Math.abs(cov.perTicket - 12 / 49) < 1e-15, '特码：整张清单 12 个号至少中 1 注 = 12/49');
        assert.equal(cov.betsPerOption, 12);
        assert.equal(cov.totalBets, 12);
        assert.ok(Math.abs(cov.anyHit - cov.distinct / 49) < 1e-15, '特码：并集号码数 / 49');
      } else {
        const single = mode === 'pick3' ? 20 / 18424 : 15 / 211876;
        assert.ok(Math.abs(cov.perTicket - single) < 1e-15);
        assert.ok(cov.anyHit >= single - 1e-12, '5 注至少不比 1 注差');
        assert.ok(cov.anyHit <= 5 * single + 1e-12, '不能超过 5 × 单注的上界');
      }
      assert.ok(cov.allBlank > 0 && cov.allBlank < 1);
    }
  }
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

test('buildDailyFiveRecords 特码口径：命中 = 开奖特码落在这张清单里', () => {
  const target = pick('2026-287'); // 特码 08
  const rec = buildDailyFiveRecords(ALL, [target], { mode: 'special', oddsSpecial: 48 })[0];
  assert.equal(rec.five.length, 1, '特码只有一张清单');
  const e = rec.five[0];
  assert.equal(e.numbers.length, 12);
  const covers = e.numbers.includes(8);
  assert.equal(e.isWin, covers);
  assert.equal(e.hitCount, covers ? 1 : 0);
  assert.equal(e.payout, covers ? 10 * 48 : 0, '每中 1 注返 本金 × 特码赔率');
  // 正码命中个数不参与特码判定
  assert.ok(e.matchedNormalCount <= 1);
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

test('summarizeDailyFive：成本按注数算（特码 1 张清单 12 注），返奖 = 中奖注数 × 本金 × 赔率', () => {
  const targets = ALL.slice(0, 60);
  for (const { mode, size, odds, bets = 1 } of MODES) {
    const records = buildDailyFiveRecords(ALL, targets, { stake: 10, odds3: 650, odds4: 7500, oddsSpecial: 48, mode });
    const summary = summarizeDailyFive(records, { stake: 10, odds3: 650, odds4: 7500, oddsSpecial: 48, mode });

    assert.equal(summary.periods, records.length);
    // 特码只有一张清单（1 行汇总），直选 5 组（5 行）
    assert.equal(summary.catalog.length, mode === 'special' ? 1 : 5);
    assert.equal(summary.size, size);
    assert.equal(summary.mode, mode);
    assert.equal(summary.odds, odds);

    assert.equal(summary.betsPerOption, bets);
    for (const agg of summary.catalog) {
      assert.equal(agg.periods, records.length);
      // 特码每期 12 注 → 成本 = 期数 × 12 × 本金；直选每组 1 注
      assert.equal(agg.cost, records.length * bets * 10);
      assert.equal(agg.bets, records.length * bets);
      let winPeriods = 0;
      let hitBets = 0;
      for (const r of records) {
        const e = r.five.find((x) => x.id === agg.id);
        if (e.isWin) winPeriods++;
        hitBets += e.hitCount || 0;
      }
      assert.equal(agg.winPeriods, winPeriods);
      // 特码：hitSum = 中奖注数；直选：hitCount = 命中的正码个数，中奖注数 = 命中组数
      const winBetsCount = bets > 1 ? hitBets : winPeriods;
      assert.equal(agg.payout, winBetsCount * 10 * odds, '返奖 = 中奖注数 × 本金 × 赔率');
      assert.equal(agg.net, agg.payout - agg.cost);
      assert.equal(agg.roi, Number(((agg.net / agg.cost) * 100).toFixed(2)));
    }
    assert.equal(summary.totalCost, summary.catalog.reduce((a, c) => a + c.cost, 0));
    assert.equal(summary.totalPayout, summary.catalog.reduce((a, c) => a + c.payout, 0));
    assert.equal(summary.totalNet, summary.totalPayout - summary.totalCost);
  }
});

test('随机期望：特码每期 12/49 ≈ 0.245 注，三中三 18/49 ≈ 0.367，四中四 24/49 ≈ 0.490', () => {
  assert.ok(Math.abs(randomExpectedHits('special') - 12 / 49) < 1e-12);
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
  // 特码玩法：1 中 1（1 个号 = 1 注），自选允许 1 ~ 12 个号
  const records3s = buildCustomRecords(ALL, targets, { customNumbers: [6, 26, 29], stake: 10, mode: 'special' });
  assert.equal(records3s.length, targets.length);
  assert.deepEqual(records3s[0].five[0].numbers, [6, 26, 29]);
  assert.equal(records3s[0].size, 12);
  assert.equal(buildCustomRecords(ALL, targets, { customNumbers: [8], mode: 'special' }).length, targets.length, '单个号也能自选');
  assert.equal(
    buildCustomRecords(ALL, targets, { customNumbers: Array.from({ length: 13 }, (_, i) => i + 1), mode: 'special' }).length,
    0,
    '超过 12 个号不生成记录'
  );
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
