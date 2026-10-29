/**
 * 开奖自动同步：脚本层健壮性回归
 *
 * 这套测试针对的是「当天开奖当天入库」这条链路里最容易出错、又最难察觉的部分：
 *   · 时区（CI 是 UTC，用户看的是北京时间）
 *   · 「还没发布」和「抓取坏了」必须区分开
 *   · 写库前的硬校验（宁可不写，也不能把坏数据写进底库）
 *   · 等待上游发布的重试节奏与放弃条件
 *
 * 全部用注入的假数据跑，不联网（上游是非标准端口 + 坏证书，CI 也抓不到）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT,
  clockInShanghai,
  isDatabaseFresh,
  isPastDeadline,
  minutesOfDay,
  syncDraws,
  todayInShanghai,
  validateDatabase
} from '../scripts/sync_latest.mjs';

/** 造一段「网页复制块」格式的开奖记录（与上游 HTML 结构一致） */
function fakePage(draws) {
  const ball = (n) => `<div class="ball red"><span class="red">${String(n).padStart(2, '0')}</span><b>鼠</b></div>`;
  return draws.map(({ period, date, nums, special }) =>
    `<dt><b>${period}</b>期(开奖时间:${date})</dt><dl>\n${[...nums, special].map(ball).join('\n')}\n</dl>`
  ).join('\n');
}

/**
 * ⚠ 这些用例必须自带底库，不能读真实的 data/draws.json。
 *
 * 踩过的坑（2026-10-29）：用例里写 `waitFor: todayInShanghai()`，一旦当天开奖真的同步进底库，
 * 门控 `isDatabaseFresh` 就会提前返回 fresh —— 于是「等待上游」「连续失败」等用例全部飘红。
 * 换句话说：**同步越正常，测试越红**。用注入的固定底库 + 固定目标日可以彻底断掉这个耦合。
 */
const TARGET = '2026-10-29';
const baseDb = () => [{
  id: '2026-301', year: 2026, periodNum: 301, period: '301', date: '2026-10-28',
  numbers: [8, 9, 10, 11, 12, 13], special: 14,
  colors: ['red', 'blue', 'green', 'red', 'blue', 'green', 'red'],
  zodiacs: ['鼠', '牛', '虎', '兔', '龙', '蛇', '马']
}];

/* ------------------------------------------------------------ 时区 */

test('北京日期 / 时刻：不受运行机器时区影响（CI 跑在 UTC）', () => {
  // 2026-10-29T16:30Z = 北京 2026-10-30 00:30 → 已经跨日
  assert.equal(todayInShanghai(new Date('2026-10-29T16:30:00Z')), '2026-10-30');
  assert.equal(clockInShanghai(new Date('2026-10-29T16:30:00Z')), '00:30');
  // 2026-10-29T13:45Z = 北京 21:45
  assert.equal(todayInShanghai(new Date('2026-10-29T13:45:00Z')), '2026-10-29');
  assert.equal(clockInShanghai(new Date('2026-10-29T13:45:00Z')), '21:45');
});

test('截止时刻解析与比较', () => {
  assert.equal(minutesOfDay('23:55'), 23 * 60 + 55);
  assert.equal(minutesOfDay('9:05'), 9 * 60 + 5);
  assert.equal(minutesOfDay('24:00'), null);
  assert.equal(minutesOfDay(''), null);

  const at = (iso) => new Date(iso);
  // 北京 23:54 未过 23:55；23:55 已到
  assert.equal(isPastDeadline('23:55', at('2026-10-29T15:54:00Z')), false);
  assert.equal(isPastDeadline('23:55', at('2026-10-29T15:55:00Z')), true);
  assert.equal(isPastDeadline('', at('2026-10-29T15:55:00Z')), false, '空截止时刻表示永不截止');
});

/* ------------------------------------------------------------ 门控 */

test('门控：底库已有目标日就秒退，根本不碰网络', () => {
  assert.equal(isDatabaseFresh([{ date: '2026-10-29' }], '2026-10-29'), true, '同一天算新鲜');
  assert.equal(isDatabaseFresh([{ date: '2026-10-30' }], '2026-10-29'), true, '比目标更晚也算新鲜');
  assert.equal(isDatabaseFresh([{ date: '2026-10-27' }], '2026-10-29'), false);
  assert.equal(isDatabaseFresh([], '2026-10-29'), false);
  assert.equal(isDatabaseFresh([{ date: '2026-10-29' }], ''), false);
});

test('门控：--gate-only 只回答要不要同步，不写库不联网', async () => {
  // 目标日设成很久以前 → 底库一定已经「新鲜」→ fresh
  const fresh = await syncDraws({
    gateOnly: true,
    waitFor: '2000-01-01',
    fetchContent: () => { throw new Error('门控不应该联网'); }
  });
  assert.equal(fresh.status, 'fresh');
});

/* ------------------------------------------------------------ 校验 */

test('写库前校验：期数只增不减 / 号码合法 / 7 个不重复', () => {
  const ok = { id: '2026-302', numbers: [1, 2, 3, 4, 5, 6], special: 7 };
  assert.equal(validateDatabase([ok], []).ok, true);
  assert.equal(validateDatabase([], []).ok, false, '空库必须拒绝');

  // 期数变短 = 上游改版解析出半截，绝不能覆盖
  const shrink = validateDatabase([ok], new Array(10).fill(ok));
  assert.equal(shrink.ok, false);
  assert.match(shrink.reason, /掉到/);

  assert.equal(validateDatabase([{ ...ok, numbers: [1, 2, 3, 4, 5] }], []).ok, false, '正码必须 6 个');
  assert.equal(validateDatabase([{ ...ok, special: 6 }], []).ok, false, '特码与正码重复要拒绝');
  assert.equal(validateDatabase([{ ...ok, numbers: [1, 2, 3, 4, 5, 50] }], []).ok, false, '号码必须 1~49');
});

/* ------------------------------------------------------------ 等待上游 */

test('等上游发布：前两轮还没有今天这一期，第三轮出现就立刻收工', async () => {
  const oldPage = fakePage([{ period: 301, date: '2026-10-28', nums: [8, 9, 10, 11, 12, 13], special: 14 }]);
  const newPage = fakePage([
    { period: 302, date: TARGET, nums: [1, 2, 3, 4, 5, 6], special: 7 },
    { period: 301, date: '2026-10-28', nums: [8, 9, 10, 11, 12, 13], special: 14 }
  ]);
  let rounds = 0;
  const sleeps = [];
  const result = await syncDraws({
    waitFor: TARGET,
    existing: baseDb(),
    wait: true,
    intervalSec: 5,
    maxWaitMin: 60,
    deadline: '23:59',
    dryRun: true,
    fetchContent: () => (++rounds < 3 ? oldPage : newPage),
    sleep: async (ms) => { sleeps.push(ms); }
  });

  assert.equal(result.status, 'ok', `应当最终成功，实际 ${result.status}`);
  assert.equal(result.rounds, 3, '前两轮没拿到应继续等，第三轮拿到');
  assert.equal(sleeps.length, 2, '两次等待之间没有多余睡眠');
  assert.equal(sleeps[0], 5000, '按 intervalSec 等待');
  assert.equal(result.latest.date, TARGET);
});

test('等上游发布：上游一直没发布 → not-published（属于正常情况，不是故障）', async () => {
  const oldPage = fakePage([{ period: 301, date: '2026-10-28', nums: [8, 9, 10, 11, 12, 13], special: 14 }]);
  const result = await syncDraws({
    waitFor: TARGET,
    existing: baseDb(),
    wait: true,
    intervalSec: 5,
    maxWaitMin: 0, // 不等待（等价于到点了）
    dryRun: true,
    fetchContent: () => oldPage,
    sleep: async () => {}
  });
  assert.equal(result.status, 'not-published');
  assert.equal(EXIT.NOT_PUBLISHED, 3);
});

test('连续抓取失败：达到上限就放弃，并报 fetch-failed（这才是真故障）', async () => {
  let rounds = 0;
  const result = await syncDraws({
    waitFor: TARGET,
    existing: baseDb(),
    wait: true,
    intervalSec: 5,
    maxWaitMin: 60,
    maxFetchFailures: 3,
    dryRun: true,
    fetchContent: () => { rounds++; throw new Error('ECONNRESET'); },
    sleep: async () => {}
  });
  assert.equal(result.status, 'fetch-failed');
  assert.equal(rounds, 3, '连续失败 3 次就应该停手，不能一整晚死循环');
  assert.match(result.error, /ECONNRESET/);
});

test('抓取抖动不应放弃：失败几次后又抓到，仍要继续等目标期', async () => {
  const newPage = fakePage([{ period: 302, date: TARGET, nums: [1, 2, 3, 4, 5, 6], special: 7 }]);
  let n = 0;
  const result = await syncDraws({
    waitFor: TARGET,
    existing: baseDb(),
    wait: true,
    intervalSec: 5,
    maxWaitMin: 60,
    maxFetchFailures: 3,
    dryRun: true,
    // 第 1、2 轮网络抖，第 3 轮恢复并带上今天这期
    fetchContent: () => { n++; if (n < 3) throw new Error('socket hang up'); return newPage; },
    sleep: async () => {}
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.rounds, 3);
});

/* ------------------------------------------------------------ 解析 */

test('解析不出记录要报错，不能静默把底库写成空', async () => {
  const result = await syncDraws({
    waitFor: TARGET,
    existing: baseDb(),
    wait: false,
    maxFetchFailures: 2,
    dryRun: true,
    fetchContent: () => '<html>站点改版了，没有开奖记录</html>',
    sleep: async () => {}
  });
  assert.ok(['fetch-failed', 'invalid'].includes(result.status), `实际 ${result.status}`);
  assert.ok(result.error);
});
