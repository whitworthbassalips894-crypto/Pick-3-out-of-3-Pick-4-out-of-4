import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_APPEND_PER_SYNC,
  compareDrawSets,
  dayOfYear,
  describeSourceLag,
  drawOrdinal,
  formatSyncSummary,
  nextPeriodMeta,
  periodId,
  rawGithubDbUrl
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

/* ------------------------------------------------ 底库新鲜度（落后几期） */

test('dayOfYear：当年第几天 = 第几期', () => {
  assert.equal(dayOfYear('2026-01-01'), 1);
  assert.equal(dayOfYear('2026-10-27'), 300);
  assert.equal(dayOfYear('2024-12-31'), 366); // 闰年
  assert.equal(dayOfYear('2026-02-31'), null); // 假日期
  assert.equal(dayOfYear(''), null);
});

test('drawOrdinal：跨年也能连续比较', () => {
  assert.equal(drawOrdinal(2026, 1) + 1, drawOrdinal(2026, 2));
  assert.equal(drawOrdinal(2025, 365) + 1, drawOrdinal(2026, 1));
  assert.equal(drawOrdinal(2026, 0), null);
});

test('describeSourceLag：当天就是最新', () => {
  const r = describeSourceLag({ id: '2026-300', year: 2026, periodNum: 300, date: '2026-10-27' }, '2026-10-27');
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.equal(r.lagPeriods, 0);
  assert.match(r.message, /已是最新/);
});

test('describeSourceLag：只差今天这一期（开奖未公布）不算落后', () => {
  const r = describeSourceLag({ id: '2026-298', year: 2026, periodNum: 298, date: '2026-10-25' }, '2026-10-26');
  assert.equal(r.stale, false);
  assert.equal(r.lagPeriods, 1);
  assert.equal(r.expectedId, '2026-299');
  assert.match(r.message, /落后 1 期/);
  assert.match(r.message, /还没(到点|公布)|还没放榜/, '要明确告诉用户「上游还没放榜」，而不是让人以为工具坏了');
  assert.match(r.message, /21:40/, '顺带说明开奖公布时间，用户可以自己对表');
});

test('describeSourceLag：落后超过 1 期时，hint 要说明「21:45 起自动抓取、会重试到 23:55」', () => {
  const r = describeSourceLag({ id: '2026-298', year: 2026, periodNum: 298, date: '2026-10-25' }, '2026-10-29');
  assert.equal(r.stale, true);
  assert.match(r.hint, /21:45/);
  assert.match(r.hint, /23:55/);
  assert.match(r.hint, /sync-draws/);
});

test('describeSourceLag：落后 2 期以上判定为 stale，并点明是仓库文件没更新', () => {
  const r = describeSourceLag({ id: '2026-298', year: 2026, periodNum: 298, date: '2026-10-25' }, '2026-10-27');
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.equal(r.lagPeriods, 2);
  assert.equal(r.expectedId, '2026-300');
  assert.match(r.message, /落后 2 期/);
  assert.match(r.message, /GitHub Actions/);
});

test('describeSourceLag：跨年也按天数算', () => {
  const r = describeSourceLag({ id: '2026-300', year: 2026, periodNum: 300, date: '2026-10-27' }, '2027-01-01');
  assert.equal(r.expectedId, '2027-001');
  assert.equal(r.lagPeriods, 66); // 2026-300（10-27）→ 2027-001（01-01）相隔 66 天
});

test('describeSourceLag：没有本地数据 / 非法日期时不瞎算', () => {
  assert.equal(describeSourceLag(null, '2026-10-27').ok, false);
  assert.match(describeSourceLag(null, '2026-10-27').message, /还没有开奖数据/);
  assert.equal(describeSourceLag({ year: 2026, periodNum: 298 }, 'not-a-date').ok, false);
});

/* ---------------------------------------------- 原始文件兜底源 */

test('rawGithubDbUrl：只对 GitHub Pages 的 project 站点推导，其它一律返回空串', () => {
  assert.equal(
    rawGithubDbUrl('https://alice.github.io/my-repo/?p=2026-300'),
    'https://raw.githubusercontent.com/alice/my-repo/main/data/draws.json'
  );
  // 用户主页站点（没有 repo 段）推导不出来
  assert.equal(rawGithubDbUrl('https://alice.github.io/'), '');
  // 本地 / 自建域名 / 非法地址都不猜
  assert.equal(rawGithubDbUrl('http://localhost:3000/'), '');
  assert.equal(rawGithubDbUrl('https://example.com/lottery/'), '');
  assert.equal(rawGithubDbUrl(''), '');
  // 分支可配置（tag / 分支都行）
  assert.match(rawGithubDbUrl('https://alice.github.io/repo/', 'master'), /\/master\/data\/draws\.json$/);
});
