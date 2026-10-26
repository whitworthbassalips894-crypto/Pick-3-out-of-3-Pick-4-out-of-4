/**
 * 期号日历单测（跨年 bug 回归）
 *
 * bug 背景：旧实现用 `periodNum > 366` 判断跨年，而期号其实是「当年第几天」。
 * 结果 2026 年（平年 365 天）的 12-31 会被算成「2026 年第 366 期」这种不存在的期号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import { addDays, daysInYear, nextPeriodMeta, parseIsoDate } from '../src/periods.js';

const ALL = INITIAL_DB.draws;

test('parseIsoDate / addDays：拒绝不存在的日期，正确处理闰日', () => {
  assert.equal(parseIsoDate('2026-02-31'), null);
  assert.equal(parseIsoDate('2026-13-01'), null);
  assert.equal(parseIsoDate('2026-02-28')?.toISOString().slice(0, 10), '2026-02-28');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('bad-date', 1), '');
});

test('daysInYear：平年 365、闰年 366', () => {
  assert.equal(daysInYear(2025), 365);
  assert.equal(daysInYear(2026), 365);
  assert.equal(daysInYear(2024), 366);
  assert.equal(daysInYear(2100), 365);
  assert.equal(daysInYear(2000), 366);
});

test('跨年：年末最后一期的下一期是「下一年第 001 期」，不是第 366 期', () => {
  const cases = [
    [{ year: 2026, periodNum: 365, date: '2026-12-31' }, { year: 2027, periodNum: 1, date: '2027-01-01', period: '001' }],
    [{ year: 2025, periodNum: 365, date: '2025-12-31' }, { year: 2026, periodNum: 1, date: '2026-01-01', period: '001' }],
    [{ year: 2024, periodNum: 366, date: '2024-12-31' }, { year: 2025, periodNum: 1, date: '2025-01-01', period: '001' }]
  ];
  for (const [latest, expected] of cases) {
    const next = nextPeriodMeta(latest);
    assert.equal(next.year, expected.year, `${latest.year}-${latest.periodNum} 的跨年年份错了`);
    assert.equal(next.periodNum, expected.periodNum);
    assert.equal(next.period, expected.period);
    assert.equal(next.date, expected.date);
    assert.equal(next.id, 'NEXT');
  }
});

test('平年 12-30 → 12-31 仍是同一年，不会被误判成跨年', () => {
  const next = nextPeriodMeta({ year: 2026, periodNum: 364, date: '2026-12-30' });
  assert.deepEqual([next.year, next.periodNum, next.date], [2026, 365, '2026-12-31']);
});

test('日期缺失时按当年天数兜底跨年', () => {
  const next = nextPeriodMeta({ year: 2026, periodNum: 365, date: '' });
  assert.deepEqual([next.year, next.periodNum], [2027, 1]);
  const same = nextPeriodMeta({ year: 2026, periodNum: 100, date: '' });
  assert.deepEqual([same.year, same.periodNum], [2026, 101]);
});

test('真实底库：每一期的「下一期」推算都与下一条记录对得上（含跨年）', () => {
  let checked = 0;
  for (let i = 0; i < ALL.length - 1; i++) {
    const cur = ALL[i];
    const prev = ALL[i + 1];
    const next = nextPeriodMeta(prev);
    assert.equal(next.date, cur.date, `${prev.id} 的下一天应为 ${cur.date}，实际推成 ${next.date}`);
    assert.equal(next.year, cur.year, `${prev.id} 的下一期年份应为 ${cur.year}`);
    assert.equal(next.periodNum, cur.periodNum, `${prev.id} 的下一期期号应为 ${cur.periodNum}`);
    checked++;
  }
  assert.ok(checked > 1700, `应校验全部相邻期次，实际只校验了 ${checked} 对`);
});
