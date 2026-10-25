import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidISODate,
  mergeDraws,
  normalizeDateString,
  normalizeDrawRecord,
  parseAmHtml,
  parseDrawsInput,
  parsePlainTextDraws
} from '../src/parser.js';

test('normalizeDateString pads single-digit month and day', () => {
  assert.equal(normalizeDateString('2025-8-31'), '2025-08-31');
  assert.equal(normalizeDateString('2025-8-9'), '2025-08-09');
  assert.equal(normalizeDateString('2026-10-23'), '2026-10-23');
});

test('parseAmHtml parses official am.html markup including single-digit month', () => {
  const sampleHtml = `
    <ul id="msg">
      <li>
        <dt><b>296</b>期(开奖时间:2026-10-23)</dt>
        <dl>
          <div class="ball" data-name="蛇" data-index="0"><p><span class="blue">14</span><b>蛇</b></p></div>
          <div class="ball" data-name="鼠" data-index="1"><p><span class="green">43</span><b>鼠</b></p></div>
          <div class="ball" data-name="蛇" data-index="2"><p><span class="blue">26</span><b>蛇</b></p></div>
          <div class="ball" data-name="狗" data-index="3"><p><span class="red">45</span><b>狗</b></p></div>
          <div class="ball" data-name="龙" data-index="4"><p><span class="blue">03</span><b>龙</b></p></div>
          <div class="ball" data-name="鼠" data-index="5"><p><span class="blue">31</span><b>鼠</b></p></div>
          <div class="ball" data-name="猴" data-index="6"><p><span class="red">23</span><b>猴</b></p></div>
        </dl>
      </li>
      <li>
        <dt><b>243</b>期(开奖时间:2025-8-31)</dt>
        <dl>
          <div class="ball" data-name="蛇" data-index="0"><p><span class="red">01</span><b>蛇</b></p></div>
          <div class="ball" data-name="龙" data-index="1"><p><span class="red">02</span><b>龙</b></p></div>
          <div class="ball" data-name="兔" data-index="2"><p><span class="blue">03</span><b>兔</b></p></div>
          <div class="ball" data-name="虎" data-index="3"><p><span class="blue">04</span><b>虎</b></p></div>
          <div class="ball" data-name="牛" data-index="4"><p><span class="green">05</span><b>牛</b></p></div>
          <div class="ball" data-name="鼠" data-index="5"><p><span class="green">06</span><b>鼠</b></p></div>
          <div class="ball" data-name="猪" data-index="6"><p><span class="red">07</span><b>猪</b></p></div>
        </dl>
      </li>
    </ul>
  `;

  const parsed = parseAmHtml(sampleHtml);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, '2026-296');
  assert.deepEqual(parsed[0].numbers, [14, 43, 26, 45, 3, 31]);
  assert.equal(parsed[0].special, 23);
  assert.equal(parsed[1].id, '2025-243');
  assert.equal(parsed[1].date, '2025-08-31');
});

test('parsePlainTextDraws supports copied webpage text and manual shorthand lines', () => {
  const copiedPageText = `
    296期(开奖时间:2026-10-23)
    14
    蛇
    43
    鼠
    26
    蛇
    45
    狗
    03
    龙
    31
    鼠
    23
    猴
  `;
  const res1 = parsePlainTextDraws(copiedPageText);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].id, '2026-296');
  assert.deepEqual(res1[0].numbers, [14, 43, 26, 45, 3, 31]);
  assert.equal(res1[0].special, 23);

  const manualLines = `
    297期 2026-10-24 08 15 22 31 39 45 + 12
    2026-298期 2026-10-25: 02, 11, 19, 27, 35, 44, 09
  `;
  const res2 = parseDrawsInput(manualLines);
  assert.equal(res2.length, 2);
  assert.equal(res2[0].id, '2026-297');
  assert.deepEqual(res2[0].numbers, [8, 15, 22, 31, 39, 45]);
  assert.equal(res2[0].special, 12);
  assert.equal(res2[1].id, '2026-298');
});

test('mergeDraws is idempotent and sorts descending by year and periodNum', () => {
  const d1 = parseDrawsInput('295期 2026-10-22 22 28 33 17 13 47 + 25');
  const d2 = parseDrawsInput('296期 2026-10-23 14 43 26 45 03 31 + 23');
  const { merged, addedCount } = mergeDraws(d1, d2);
  assert.equal(merged.length, 2);
  assert.equal(addedCount, 1);
  assert.equal(merged[0].id, '2026-296');
  assert.equal(merged[1].id, '2026-295');

  // 重复合并同一条记录，addedCount 应为 0
  const { merged: mergedAgain, addedCount: addedAgain } = mergeDraws(merged, d2);
  assert.equal(mergedAgain.length, 2);
  assert.equal(addedAgain, 0);
});

test('isValidISODate 拒绝不存在的日期与注入载荷', () => {
  assert.equal(isValidISODate('2026-10-24'), true);
  assert.equal(isValidISODate('2026-02-28'), true);
  assert.equal(isValidISODate('2024-02-29'), true); // 闰年
  assert.equal(isValidISODate('2026-02-30'), false);
  assert.equal(isValidISODate('2026-13-45'), false);
  assert.equal(isValidISODate('2026-00-10'), false);
  assert.equal(isValidISODate('2026-10-32'), false);
  assert.equal(isValidISODate('26-10-24'), false);
  assert.equal(isValidISODate('2026/10/24'), false);
  assert.equal(isValidISODate('<img src=x onerror=alert(1)>'), false);
  assert.equal(isValidISODate(''), false);
  assert.equal(isValidISODate(null), false);
});

test('normalizeDrawRecord 丢弃非法日期，但保留记录本身（不丢开奖数据）', () => {
  const rec = normalizeDrawRecord({
    year: 2026,
    periodNum: 298,
    date: '2026-13-45',
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7
  });
  assert.ok(rec);
  assert.equal(rec.id, '2026-298');
  assert.equal(rec.date, '2026-01-01'); // 非法日期回落到安全默认值
  assert.deepEqual(rec.numbers, [1, 2, 3, 4, 5, 6]);
});

test('normalizeDrawRecord 拒绝带注入载荷的日期（不会进 innerHTML）', () => {
  const rec = normalizeDrawRecord({
    year: 2026,
    periodNum: 299,
    date: '<img src=x onerror="window.__XSS__=true">',
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7
  });
  assert.ok(rec);
  assert.ok(!rec.date.includes('img'));
  assert.ok(!rec.date.includes('onerror'));
  assert.equal(rec.date, '2026-01-01');
});

test('parseDrawsInput 解析出的记录日期都必须是合法日期', () => {
  const parsed = parseDrawsInput('298期 2026-13-45 01 02 03 04 05 06 + 07');
  for (const rec of parsed) {
    assert.ok(isValidISODate(rec.date), `日期必须合法：${rec.date}`);
  }
});
