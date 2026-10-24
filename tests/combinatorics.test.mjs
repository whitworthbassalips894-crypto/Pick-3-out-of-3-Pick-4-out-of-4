import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binomial,
  combinations,
  evaluate7CodeCompound,
  evaluateDirectTickets
} from '../src/combinatorics.js';

test('binomial & combinations C(7,3)=35 and C(7,4)=35', () => {
  assert.equal(binomial(7, 3), 35);
  assert.equal(binomial(7, 4), 35);
  assert.equal(binomial(6, 3), 20);
  assert.equal(binomial(5, 3), 10);
  assert.equal(binomial(4, 3), 4);
  assert.equal(binomial(3, 3), 1);
  assert.equal(binomial(2, 3), 0);

  const seven = [3, 14, 22, 26, 31, 43, 45];
  const c3 = combinations(seven, 3);
  const c4 = combinations(seven, 4);
  assert.equal(c3.length, 35);
  assert.equal(c4.length, 35);
  assert.deepEqual(c3[0], [3, 14, 22]);
  assert.deepEqual(c3[34], [31, 43, 45]);
});

test('evaluate7CodeCompound hit table for k = 0..6 normal balls', () => {
  const picks = [1, 2, 3, 4, 5, 6, 7];
  const expected3 = [0, 0, 0, 1, 4, 10, 20];
  const expected4 = [0, 0, 0, 0, 1, 5, 15];

  for (let k = 0; k <= 6; k++) {
    // 构造恰有 k 个正码命中的开奖结果
    const hitPart = picks.slice(0, k);
    const missPart = [20, 21, 22, 23, 24, 25].slice(0, 6 - k);
    const draw = {
      numbers: [...hitPart, ...missPart],
      special: 49
    };

    const res = evaluate7CodeCompound(picks, draw, { stake: 10, odds3: 650, odds4: 7500 });
    assert.equal(res.matchedNormalCount, k);
    assert.equal(res.pick3.winCount, expected3[k]);
    assert.equal(res.pick4.winCount, expected4[k]);
    assert.equal(res.pick3.cost, 350);
    assert.equal(res.pick3.payout, expected3[k] * 10 * 650);
    assert.equal(res.pick3.netProfit, res.pick3.payout - 350);
    assert.equal(res.pick4.payout, expected4[k] * 10 * 7500);
  }
});

test('strictly excludes special ball (特码) from 三中三 and 四中四 hits', () => {
  const picks = [10, 14, 23, 26, 31, 43, 45];
  // 仅命中 2 个正码 (14, 26)，而特码 23 虽然在选号中，但绝不能计入三中三
  const draw = {
    numbers: [14, 26, 1, 2, 3, 4],
    special: 23
  };

  const res = evaluate7CodeCompound(picks, draw, { stake: 10, odds3: 650, odds4: 7500 });
  assert.equal(res.matchedNormalCount, 2);
  assert.deepEqual(res.matchedNormals, [14, 26]);
  assert.equal(res.specialMatched, true);
  assert.equal(res.pick3.winCount, 0);
  assert.equal(res.pick4.winCount, 0);
  assert.equal(res.pick3.netProfit, -350);
});

test('evaluateDirectTickets correctly scores 5 recommended Pick-3 and Pick-4 sets', () => {
  const tickets3 = [
    [3, 14, 26],
    [14, 31, 43],
    [1, 2, 3],
    [10, 20, 30],
    [5, 15, 25]
  ];
  const draw = {
    numbers: [14, 43, 26, 45, 3, 31],
    special: 23
  };
  const res = evaluateDirectTickets(tickets3, draw, { stake: 10, odds3: 650, targetSize: 3 });
  assert.equal(res.totalBets, 5);
  assert.equal(res.winCount, 2); // [3,14,26] and [14,31,43] both hit
  assert.equal(res.cost, 50);
  assert.equal(res.payout, 2 * 10 * 650);
  assert.equal(res.netProfit, 13000 - 50);
});
