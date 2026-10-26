import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binomial,
  combinations,
  evaluateDirectTickets,
  normalizeNumbers
} from '../src/combinatorics.js';

test('binomial & combinations 的组合数计算正确', () => {
  assert.equal(binomial(6, 3), 20);
  assert.equal(binomial(5, 3), 10);
  assert.equal(binomial(4, 3), 4);
  assert.equal(binomial(3, 3), 1);
  assert.equal(binomial(2, 3), 0);
  assert.equal(binomial(6, 4), 15);

  const seven = [3, 14, 22, 26, 31, 43, 45];
  const c3 = combinations(seven, 3);
  const c4 = combinations(seven, 4);
  assert.equal(c3.length, 35);
  assert.equal(c4.length, 35);
  assert.deepEqual(c3[0], [3, 14, 22]);
  assert.deepEqual(c3[34], [31, 43, 45]);
});

test('normalizeNumbers 去重、排序、限量', () => {
  assert.deepEqual(normalizeNumbers([5, '5', 3, 99, 0, -1, 12], { sort: true, maxCount: 3 }), [3, 5, 12]);
  assert.deepEqual(normalizeNumbers([7, 2], { sort: false }), [7, 2]);
  assert.deepEqual(normalizeNumbers(null), []);
});

test('直选：三中三要求 3 个号全部命中，返奖 = 本金 × 赔率', () => {
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
  assert.equal(res.winCount, 2); // [3,14,26] 与 [14,31,43] 全中
  assert.equal(res.cost, 50);
  assert.equal(res.payout, 2 * 10 * 650);
  assert.equal(res.netProfit, 13000 - 50);
});

test('直选：四中四要求 4 个号全部命中，特码永远不计入', () => {
  const draw = { numbers: [14, 26, 31, 43, 7, 9], special: 23 };
  const tickets = [
    [14, 26, 31, 43], // 全中
    [14, 26, 31, 23], // 23 是特码，不算命中
    [14, 26, 31, 45]  // 45 不在正码里，差 1 个
  ];
  const res = evaluateDirectTickets(tickets, draw, { stake: 10, odds4: 7500, targetSize: 4 });
  assert.equal(res.totalBets, 3);
  assert.equal(res.winCount, 1);
  assert.equal(res.cost, 30);
  assert.equal(res.payout, 1 * 10 * 7500);
  assert.deepEqual(res.details[1].hitNums, [14, 26, 31]);
  assert.equal(res.details[1].isWin, false);
});
