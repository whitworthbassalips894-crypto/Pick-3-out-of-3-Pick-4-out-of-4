/**
 * 公共推荐件单测（S1~S5 下线后，src/strategy.js 只剩三个与策略无关的能力）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import {
  getPriorDraws,
  selectBalanced7Numbers,
  selectFeaturedCombinations
} from '../src/strategy.js';
import { computeDailyFiveFeatures } from '../src/dailyfive.js';

const ALL = INITIAL_DB.draws;

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

test('selectBalanced7Numbers 输出 7 个不重复合法号码，并尊重胆码', () => {
  const prior = getPriorDraws(ALL, { year: 2026, periodNum: 297 });
  const features = computeDailyFiveFeatures(prior, { year: 2026, periodNum: 297 });
  const scoreMap = {};
  for (let n = 1; n <= 49; n++) scoreMap[n] = n % 7;

  const seven = selectBalanced7Numbers(scoreMap, features, { pinned: [7, 23, 49] });
  assert.equal(seven.length, 7);
  assert.equal(new Set(seven).size, 7);
  assert.ok(seven.every((n) => n >= 1 && n <= 49));
  for (const p of [7, 23, 49]) {
    assert.ok(seven.includes(p), `胆码 ${p} 必须被保留`);
  }
});

test('selectBalanced7Numbers 的跨注去重参数会降低重复号码的优先级', () => {
  const prior = getPriorDraws(ALL, { year: 2026, periodNum: 297 });
  const features = computeDailyFiveFeatures(prior, { year: 2026, periodNum: 297 });
  const scoreMap = {};
  for (let n = 1; n <= 49; n++) scoreMap[n] = n <= 7 ? 10 : 1; // 前 7 个分数最高

  const plain = selectBalanced7Numbers(scoreMap, features);
  const deduped = selectBalanced7Numbers(scoreMap, features, { usedElsewhere: new Set(plain.slice(0, 4)) });
  assert.equal(plain.length, 7);
  assert.equal(deduped.length, 7);
  // 去重集合之外的号码应当更多
  const keptPlain = plain.filter((n) => !new Set(plain.slice(0, 4)).has(n)).length;
  const keptDedup = deduped.filter((n) => !new Set(plain.slice(0, 4)).has(n)).length;
  assert.ok(keptDedup >= keptPlain, '跨注去重不应该增加重复号码');
});

test('selectFeaturedCombinations 从 7 码里选出 5 注三中三与 5 注四中四', () => {
  const seven = [3, 8, 15, 22, 29, 36, 43];
  const scoreMap = {};
  for (const n of seven) scoreMap[n] = n / 10;

  const featured = selectFeaturedCombinations(seven, scoreMap);
  assert.equal(featured.top5Pick3.length, 5);
  assert.ok(featured.top5Pick3.every((t) => t.length === 3));
  assert.equal(featured.top5Pick4.length, 5);
  assert.ok(featured.top5Pick4.every((t) => t.length === 4));

  // 每注的号码必须来自 7 码之内，且注与注之间不重复
  for (const t of featured.top5Pick3) {
    assert.ok(t.every((n) => seven.includes(n)));
  }
  assert.equal(new Set(featured.top5Pick3.map((t) => t.join(','))).size, 5);
  assert.equal(new Set(featured.top5Pick4.map((t) => t.join(','))).size, 5);
});

test('selectFeaturedCombinations 缺少共现矩阵时也能稳定工作', () => {
  const seven = [1, 2, 3, 4, 5, 6, 7];
  const featured = selectFeaturedCombinations(seven, {}, undefined);
  assert.equal(featured.top5Pick3.length, 5);
  assert.equal(featured.top5Pick4.length, 5);
});
