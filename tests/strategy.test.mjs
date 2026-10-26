/**
 * 公共推荐件单测（S1~S5 下线后，src/strategy.js 只剩与策略无关的取数 + 直选选号能力）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import {
  getPriorDraws,
  selectDirectNumbers
} from '../src/strategy.js';
import { computeDailyFiveFeatures } from '../src/dailyfive.js';

const ALL = INITIAL_DB.draws;

const makeFeatures = (target = { year: 2026, periodNum: 297 }) => {
  const prior = getPriorDraws(ALL, target);
  return computeDailyFiveFeatures(prior, target);
};

test('getPriorDraws 严格排除目标期与之后的期次（无未来函数的地基）', () => {
  const draws = ALL.slice(0, 50);
  const prior = getPriorDraws(draws, { year: 2026, periodNum: 280 });
  assert.ok(prior.length > 0);
  assert.ok(
    prior.every((d) => d.year < 2026 || (d.year === 2026 && d.periodNum < 280)),
    '历史样本必须全部早于目标期'
  );
});

test('getPriorDraws 在跨年目标期时仍然只取更早的记录', () => {
  const prior = getPriorDraws(ALL, { year: 2023, periodNum: 1 });
  assert.ok(prior.every((d) => d.year < 2023));
});

test('selectDirectNumbers：选三每注 3 个号、选四每注 4 个号，合法且不重复', () => {
  const features = makeFeatures();
  const scoreMap = {};
  for (let n = 1; n <= 49; n++) scoreMap[n] = n % 7;

  for (const size of [3, 4]) {
    const nums = selectDirectNumbers(scoreMap, features, { size });
    assert.equal(nums.length, size);
    assert.equal(new Set(nums).size, size);
    assert.ok(nums.every((n) => n >= 1 && n <= 49));
  }
});

test('selectDirectNumbers 选三时三区各 1 个号（1-1-1）', () => {
  const features = makeFeatures();
  const scoreMap = {};
  for (let n = 1; n <= 49; n++) scoreMap[n] = n % 11;

  const nums = selectDirectNumbers(scoreMap, features, { size: 3 });
  const zones = nums.map((n) => features.stats[n].zone).sort();
  assert.deepEqual(zones, [1, 2, 3], `三区应各 1 个号，实际 ${zones.join('-')}`);
});

test('selectDirectNumbers 选四时最多两码同区', () => {
  const features = makeFeatures();
  const scoreMap = {};
  for (let n = 1; n <= 49; n++) scoreMap[n] = n % 13;

  const nums = selectDirectNumbers(scoreMap, features, { size: 4 });
  const zoneCount = { 1: 0, 2: 0, 3: 0 };
  for (const n of nums) zoneCount[features.stats[n].zone]++;
  assert.ok(Math.max(...Object.values(zoneCount)) <= 2, `四码注不应有三码同区：${JSON.stringify(zoneCount)}`);
});

test('selectDirectNumbers 尊重 pinned 号码', () => {
  const features = makeFeatures();
  const scoreMap = {};
  for (let n = 1; n <= 49; n++) scoreMap[n] = n % 7;

  const nums = selectDirectNumbers(scoreMap, features, { size: 3, pinned: [7, 23] });
  assert.equal(nums.length, 3);
  assert.ok(nums.includes(7), 'pinned 号码必须被保留');
  assert.ok(nums.includes(23), 'pinned 号码必须被保留');
});

test('selectDirectNumbers 的跨注去重参数会降低重复号码的优先级', () => {
  const features = makeFeatures();
  const scoreMap = {};
  for (let n = 1; n <= 49; n++) scoreMap[n] = n <= 7 ? 10 : 1; // 前 7 个分数最高

  const plain = selectDirectNumbers(scoreMap, features, { size: 3 });
  const dupSet = new Set(plain.slice(0, 2));
  const deduped = selectDirectNumbers(scoreMap, features, { size: 3, usedElsewhere: dupSet });
  assert.equal(plain.length, 3);
  assert.equal(deduped.length, 3);
  const keptPlain = plain.filter((n) => !dupSet.has(n)).length;
  const keptDedup = deduped.filter((n) => !dupSet.has(n)).length;
  assert.ok(keptDedup >= keptPlain, '跨注去重不应该增加重复号码');
});

test('selectDirectNumbers 缺少特征表时不会崩（仍返回合法号码）', () => {
  const nums = selectDirectNumbers({}, { stats: {} }, { size: 3 });
  assert.equal(nums.length, 3);
  assert.ok(nums.every((n) => n >= 1 && n <= 49));
});
