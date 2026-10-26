import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_APPEND_PER_SYNC,
  compareDrawSets,
  formatSyncSummary,
  nextPeriodMeta,
  periodId
} from '../src/sync.js';

const d = (year, periodNum, nums = [1, 2, 3, 4, 5, 6], special = 7, date = '') => ({
  id: periodId(year, periodNum),
  year,
  periodNum,
  period: String(periodNum).padStart(3, '0'),
  date: date || `${year}-${String(((periodNum - 1) % 28) + 1).padStart(2, '0')}-15`,
  numbers: nums,
  special
});

test('nextPeriodMeta 正常递进', () => {
  assert.deepEqual(nextPeriodMeta(2026, 298), { year: 2026, periodNum: 299 });
  assert.deepEqual(nextPeriodMeta(2026, 1), { year: 2026, periodNum: 2 });
});

test('nextPeriodMeta 跨年进位（366 期之后归入下一年第 1 期）', () => {
  assert.deepEqual(nextPeriodMeta(2026, 366), { year: 2027, periodNum: 1 });
  assert.deepEqual(nextPeriodMeta(2026, 367), { year: 2027, periodNum: 1 });
});

test('periodId 统一补零', () => {
  assert.equal(periodId(2026, 7), '2026-007');
  assert.equal(periodId(2026, 298), '2026-298');
});

test('compareDrawSets：本地落后数据源时给出可追加期次', () => {
  const local = [d(2026, 296), d(2026, 295)];
  const remote = [d(2026, 298), d(2026, 297), d(2026, 296), d(2026, 295)];
  const r = compareDrawSets(local, remote);
  assert.equal(r.missingCount, 2);
  assert.deepEqual(r.appendable.map((x) => x.id), ['2026-297', '2026-298']);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.gapCount, 0);
  assert.equal(r.localLatest.id, '2026-296');
  assert.equal(r.remoteLatest.id, '2026-298');
});

test('compareDrawSets：本地已是最新时可追加 0 期', () => {
  const same = [d(2026, 298), d(2026, 297)];
  const r = compareDrawSets(same, same);
  assert.equal(r.missingCount, 0);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.gapCount, 0);
});

test('compareDrawSets：期号缺口时停止追加并报告缺口', () => {
  const local = [d(2026, 296)];
  const remote = [d(2026, 299), d(2026, 298), d(2026, 296)]; // 缺 297
  const r = compareDrawSets(local, remote);
  assert.equal(r.missingCount, 0, '有缺口时不应追加任何一期');
  assert.equal(r.gapCount, 1);
  assert.equal(r.gaps[0].expected, '2026-297');
  assert.equal(r.gaps[0].found, '2026-298');
});

test('compareDrawSets：同一期号号码不同算冲突', () => {
  const local = [d(2026, 298, [1, 2, 3, 4, 5, 6], 7)];
  const remote = [d(2026, 298, [9, 8, 7, 6, 5, 4], 3)];
  const r = compareDrawSets(local, remote);
  assert.equal(r.conflictCount, 1);
  assert.equal(r.conflicts[0].id, '2026-298');
  assert.deepEqual(r.conflicts[0].remote.numbers, [9, 8, 7, 6, 5, 4]);
});

test('compareDrawSets：日期不同也算冲突（同一期号内容必须完全一致）', () => {
  const local = [d(2026, 298, [1, 2, 3, 4, 5, 6], 7, '2026-10-25')];
  const remote = [d(2026, 298, [1, 2, 3, 4, 5, 6], 7, '2026-10-26')];
  const r = compareDrawSets(local, remote);
  assert.equal(r.conflictCount, 1);
});

test('compareDrawSets：本地为空时以数据源开头连续段为可追加', () => {
  const remote = [d(2026, 1), d(2026, 2), d(2026, 3)];
  const r = compareDrawSets([], remote);
  assert.equal(r.missingCount, 3);
  assert.equal(r.gapCount, 0);
});

test('compareDrawSets：本地为空且数据源本身有缺口时报告缺口', () => {
  const remote = [d(2026, 1), d(2026, 3)];
  const r = compareDrawSets([], remote);
  assert.equal(r.missingCount, 1);
  assert.equal(r.gapCount, 1);
  assert.equal(r.gaps[0].expected, '2026-002');
});

test('compareDrawSets：跨年连续性（本地 2026-366，数据源 2027-001）', () => {
  const local = [d(2026, 366)];
  const remote = [d(2027, 1), d(2026, 366)];
  const r = compareDrawSets(local, remote);
  assert.equal(r.missingCount, 1);
  assert.deepEqual(r.appendable.map((x) => x.id), ['2027-001']);
});

test('compareDrawSets：单次追加数量有上限，避免写爆 localStorage', () => {
  // 连续造 MAX_APPEND_PER_SYNC + 20 期（跨年递推，保证期号连续）
  const remote = [];
  let cur = { year: 2026, periodNum: 1 };
  for (let i = 0; i < MAX_APPEND_PER_SYNC + 20; i += 1) {
    remote.push(d(cur.year, cur.periodNum));
    cur = nextPeriodMeta(cur.year, cur.periodNum);
  }
  const r = compareDrawSets([], remote);
  assert.equal(r.appendable.length, MAX_APPEND_PER_SYNC);
  assert.equal(r.truncated, true);
});

test('formatSyncSummary 输出可读结论', () => {
  const local = [d(2026, 296)];
  const remote = [d(2026, 297), d(2026, 296)];
  const text = formatSyncSummary(compareDrawSets(local, remote));
  assert.match(text, /可追加 1 期/);
  assert.match(text, /2026-297/);
});

test('formatSyncSummary 无差异时明确说明', () => {
  const text = formatSyncSummary(compareDrawSets([d(2026, 1)], [d(2026, 1)]));
  assert.match(text, /没有可追加的期次/);
});
