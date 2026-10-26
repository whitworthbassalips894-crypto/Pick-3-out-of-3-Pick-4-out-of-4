import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binomial,
  combinations,
  evaluateDirectTickets,
  evaluateSpecialTickets,
  evaluateTickets,
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

test('特码（1 中 1）：1 个号 = 1 注，中几个号返几份，正码不参与判定', () => {
  const draw = { numbers: [14, 43, 26, 45, 3, 31], special: 23 };
  const tickets = [
    [23, 1, 2],      // 3 个号 = 3 注，含特码 → 中 1 注
    [14, 43, 26],    // 全是正码但没有特码 → 0 注
    [5, 6, 7],       // 没有 → 0 注
    [23, 24, 25]     // 含特码 → 中 1 注
  ];
  const res = evaluateSpecialTickets(tickets, draw, {
    stake: 10,
    oddsSpecial: 48,
    targetSize: 3
  });
  assert.equal(res.totalBets, 12, '4 组 × 3 个号 = 12 注');
  assert.equal(res.winCount, 2, '中了 2 注');
  assert.equal(res.cost, 120);
  assert.equal(res.payout, 2 * 10 * 48);
  assert.equal(res.netProfit, 960 - 120);
  assert.deepEqual(res.details[0].hitNums, [23]);
  assert.equal(res.details[0].isWin, true);
  assert.equal(res.details[0].hitCount, 1);
  assert.equal(res.details[0].bets, 3);
  assert.equal(res.details[1].isWin, false, '正码全中但没特码 → 不中');
  assert.equal(res.details[1].hitCount, 0);
});

test('特码回归：单号注单必须能判中（旧版写死 length === 5 导致 1759 期全 0）', () => {
  const draw = { numbers: [19, 47, 35, 6, 17, 38], special: 8 };
  // 1 个号的注单（旧模型下会被过滤掉 → 假 0 命中）
  const single = evaluateTickets([[8]], draw, { playMode: 'special', stake: 10, oddsSpecial: 48 });
  assert.equal(single.details.length, 1, '单号注单不能被丢弃');
  assert.equal(single.details[0].isWin, true);
  assert.equal(single.winCount, 1);
  assert.equal(single.payout, 480);
  assert.equal(single.cost, 10);

  // 3 个号里含特码 → 中 1 注；不含 → 0 注
  const triple = evaluateTickets([[8, 9, 10], [1, 2, 3]], draw, { playMode: 'special', stake: 10, oddsSpecial: 48 });
  assert.deepEqual(triple.details.map((d) => d.hitCount), [1, 0]);
  assert.equal(triple.totalBets, 6);
  assert.equal(triple.cost, 60);
  assert.equal(triple.payout, 480);

  // 空注单不参与结算
  assert.equal(evaluateTickets([[]], draw, { playMode: 'special' }).totalBets, 0);
});

test('evaluateTickets 按 playMode 分发到对应口径', () => {
  const draw = { numbers: [14, 43, 26, 45, 3, 31], special: 23 };
  const special = evaluateTickets([[23, 1, 2]], draw, { stake: 10, playMode: 'special', oddsSpecial: 48 });
  assert.equal(special.winCount, 1);
  assert.equal(special.payout, 480);

  const pick3 = evaluateTickets([[14, 43, 26]], draw, { stake: 10, playMode: 'pick3', odds3: 650 });
  assert.equal(pick3.winCount, 1);
  assert.equal(pick3.payout, 6500);

  const pick4 = evaluateTickets([[14, 43, 26, 45]], draw, { stake: 10, playMode: 'pick4', odds4: 7500 });
  assert.equal(pick4.winCount, 1);
  assert.equal(pick4.payout, 75000);

  // 特码玩法下，正码全中但没有特码 → 不中
  const notSpecial = evaluateTickets([[14, 43, 26]], draw, { stake: 10, playMode: 'special', oddsSpecial: 48 });
  assert.equal(notSpecial.winCount, 0);
});
