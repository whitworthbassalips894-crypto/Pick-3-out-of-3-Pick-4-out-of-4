import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFiveTickets, formatNumberLine, formatSingleTicket, formatTickets } from '../src/copy.js';

/** 复制内容里不允许出现的字符（汉字、字母、标点等） */
const CN_AND_WORDS = /[\u4e00-\u9fa5a-zA-Z:：,，。.#()（）\[\]【】*]/;

test('formatNumberLine 输出顿号分隔的两位号码', () => {
  assert.equal(formatNumberLine([7, 12, 33, 41, 45, 48, 9]), '07、12、33、41、45、48、09');
  assert.equal(formatNumberLine([5, 6, 7]), '05、06、07');
});

test('formatTickets 每注一行，行尾无多余字符', () => {
  const text = formatTickets([[1, 2, 3], [8, 9, 10, 11]]);
  assert.equal(text, '01、02、03\n08、09、10、11');
  assert.equal(text.split('\n').length, 2);
});

test('复制内容里不含任何汉字/字母/标点', () => {
  const text = formatTickets([[1, 2, 3], [8, 9, 10, 11]]);
  assert.ok(!CN_AND_WORDS.test(text), `复制内容出现多余字符：${text}`);
});

test('每日 5 注复制 = 5 行，每行 3 个号码（选三直选）', () => {
  const five = [
    { numbers: [10, 49, 22] },
    { numbers: [3, 13, 14] },
    { numbers: [3, 13, 19] },
    { numbers: [6, 17, 25] },
    { numbers: [6, 17, 29] }
  ];
  const text = formatFiveTickets(five);
  const lines = text.split('\n');
  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.equal(line.split('、').length, 3);
    assert.ok(!CN_AND_WORDS.test(line), `单行出现多余字符：${line}`);
  }
  assert.equal(
    text,
    '10、49、22\n03、13、14\n03、13、19\n06、17、25\n06、17、29'
  );
});

test('每日 5 注复制 = 5 行，每行 4 个号码（选四直选）', () => {
  const five = [
    { numbers: [10, 49, 22, 6] },
    { numbers: [3, 13, 14, 26] },
    { numbers: [3, 13, 19, 28] },
    { numbers: [6, 17, 25, 29] },
    { numbers: [6, 17, 29, 36] }
  ];
  const text = formatFiveTickets(five);
  const lines = text.split('\n');
  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.equal(line.split('、').length, 4);
  }
  assert.equal(
    text,
    '10、49、22、06\n03、13、14、26\n03、13、19、28\n06、17、25、29\n06、17、29、36'
  );
});

test('单注复制只有一行 3 个号码', () => {
  const text = formatSingleTicket([3, 13, 14]);
  assert.equal(text, '03、13、14');
  assert.equal(text.split('\n').length, 1);
  assert.ok(!CN_AND_WORDS.test(text));
});

test('单注复制只有一行 4 个号码', () => {
  const text = formatSingleTicket([3, 13, 14, 26]);
  assert.equal(text, '03、13、14、26');
  assert.equal(text.split('\n').length, 1);
});

test('空输入不会抛错', () => {
  assert.equal(formatTickets([]), '');
  assert.equal(formatTickets(null), '');
  assert.equal(formatFiveTickets([]), '');
  assert.equal(formatSingleTicket(undefined), '');
});
