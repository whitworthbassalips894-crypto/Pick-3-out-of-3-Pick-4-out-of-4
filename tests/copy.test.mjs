import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFiveTickets, formatNumberLine, formatSingleTicket, formatTickets } from '../src/copy.js';

/** 复制内容里不允许出现的字符（汉字、字母、标点等） */
const CN_AND_WORDS = /[\u4e00-\u9fa5a-zA-Z:：,，。.、#()（）\[\]【】*]/;

test('formatNumberLine 输出 7 个两位号码，空格分隔', () => {
  assert.equal(formatNumberLine([7, 12, 33, 41, 45, 48, 9]), '07 12 33 41 45 48 09');
});

test('formatTickets 每注一行，行尾无多余字符', () => {
  const text = formatTickets([[1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14]]);
  assert.equal(text, '01 02 03 04 05 06 07\n08 09 10 11 12 13 14');
  assert.equal(text.split('\n').length, 2);
});

test('复制内容里不含任何汉字/字母/标点', () => {
  const text = formatTickets([[1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14]]);
  assert.ok(!CN_AND_WORDS.test(text), `复制内容出现多余字符：${text}`);
});

test('每日 5 注复制 = 5 行，每行 7 个号码', () => {
  const five = [
    { numbers: [10, 49, 22, 34, 25, 11, 46] },
    { numbers: [3, 13, 14, 26, 43, 44, 46] },
    { numbers: [3, 13, 14, 19, 28, 29, 49] },
    { numbers: [6, 17, 25, 29, 43, 46, 47] },
    { numbers: [6, 17, 22, 29, 36, 39, 47] }
  ];
  const text = formatFiveTickets(five);
  const lines = text.split('\n');
  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.equal(line.split(' ').length, 7);
    assert.ok(!CN_AND_WORDS.test(line), `单行出现多余字符：${line}`);
  }
  assert.equal(
    text,
    '10 49 22 34 25 11 46\n03 13 14 26 43 44 46\n03 13 14 19 28 29 49\n06 17 25 29 43 46 47\n06 17 22 29 36 39 47'
  );
});

test('单注复制只有一行 7 个号码', () => {
  const text = formatSingleTicket([3, 13, 14, 26, 43, 44, 46]);
  assert.equal(text, '03 13 14 26 43 44 46');
  assert.equal(text.split('\n').length, 1);
  assert.ok(!CN_AND_WORDS.test(text));
});

test('空输入不会抛错', () => {
  assert.equal(formatTickets([]), '');
  assert.equal(formatTickets(null), '');
  assert.equal(formatFiveTickets([]), '');
  assert.equal(formatSingleTicket(undefined), '');
});
