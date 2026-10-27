import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import INITIAL_DB from '../data/draws.js';
import { syncDraws } from '../scripts/sync_latest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JSON_PATH = path.resolve(__dirname, '..', 'data', 'draws.json');

/**
 * 底库断言必须「跟着数据长大」。
 *
 * 历史教训：这些断言曾写死「1759 期 / latestId=2026-298」，
 * 而自动同步 workflow 的顺序是「先抓数据 → 再跑测试 → 再提交」，
 * 于是第一次成功抓到新一期时，测试立刻变红，提交步骤被跳过 —— 数据永远进不了仓库。
 * 现在改成：结构必须正确，规模只增不减。
 */
const BASELINE_COUNT = 1759; // 2022-01-01 ~ 2026-10-25 的既有期数（历史快照底线）

test('historical database covers 2022-2026, matches draws.js, and only grows', () => {
  assert.ok(fs.existsSync(JSON_PATH), 'data/draws.json must exist');
  const jsonDb = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));

  // 规模：只允许增加（同步只会追加），不允许缩水
  assert.ok(jsonDb.totalCount >= BASELINE_COUNT, `总期数不能少于 ${BASELINE_COUNT}，实际 ${jsonDb.totalCount}`);
  assert.equal(jsonDb.draws.length, jsonDb.totalCount, 'totalCount 必须等于 draws.length');
  assert.equal(INITIAL_DB.draws.length, jsonDb.draws.length, 'draws.js 必须与 draws.json 同步（npm run build:db）');

  // 元信息必须与实际首条记录一致（不写死具体期号，跟着数据走）
  const latest = jsonDb.draws[0];
  assert.equal(jsonDb.latestId, latest.id, 'latestId 必须等于第一期');
  assert.equal(jsonDb.latestDate, latest.date, 'latestDate 必须等于第一期的日期');

  // 年份：覆盖 2022-2026，且按降序排列
  assert.deepEqual(jsonDb.years.slice(0, 5), [2026, 2025, 2024, 2023, 2022]);
  assert.equal(jsonDb.years[0], 2026, '2026 必须是最新年份');

  const countByYear = {};
  for (const d of jsonDb.draws) {
    countByYear[d.year] = (countByYear[d.year] || 0) + 1;
    assert.equal(d.numbers.length, 6);
    assert.ok(d.numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 49));
    assert.ok(Number.isInteger(d.special) && d.special >= 1 && d.special <= 49);
    assert.equal(d.colors.length, 7);
    assert.equal(d.zodiacs.length, 7);
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  }

  // 已完整过去的年份：期数 = 当年天数；当年：期数 = 当年的第几天
  assert.equal(countByYear[2022], 365);
  assert.equal(countByYear[2023], 365);
  assert.equal(countByYear[2024], 366, '2024 是闰年');
  assert.equal(countByYear[2025], 365);
  assert.ok(countByYear[2026] >= 298, `2026 至少 298 期，实际 ${countByYear[2026]}`);
});

test('底库的期号 / 日期必须连续（同步不会写进缺口的期次）', () => {
  const jsonDb = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  const asc = [...jsonDb.draws].reverse();
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1];
    const cur = asc[i];
    if (prev.year !== cur.year) {
      assert.equal(cur.periodNum, 1, `${cur.id} 应是新年第一期`);
      continue;
    }
    assert.equal(cur.periodNum, prev.periodNum + 1, `${prev.id} 之后应接 ${cur.id}，不允许跳期`);
  }
});

test('syncDraws dryRun parses and merges incoming HTML without corrupting database', async () => {
  const mockHtml = `
    <dt><b>300</b>期(开奖时间:2026-10-27)</dt>
    <dl>
      <div class="ball" data-name="马" data-index="0"><p><span class="red">01</span><b>马</b></p></div>
      <div class="ball" data-name="狗" data-index="1"><p><span class="red">08</span><b>狗</b></p></div>
      <div class="ball" data-name="蛇" data-index="2"><p><span class="blue">14</span><b>蛇</b></p></div>
      <div class="ball" data-name="猴" data-index="3"><p><span class="red">23</span><b>猴</b></p></div>
      <div class="ball" data-name="鼠" data-index="4"><p><span class="blue">31</span><b>鼠</b></p></div>
      <div class="ball" data-name="龙" data-index="5"><p><span class="green">38</span><b>龙</b></p></div>
      <div class="ball" data-name="狗" data-index="6"><p><span class="red">45</span><b>狗</b></p></div>
    </dl>
  `;

  const before = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  const result = await syncDraws({ rawText: mockHtml, dryRun: true });
  assert.equal(result.parsedCount, 1);
  // 2026-300 可能已经在底库里（自动同步跑过），这里只要求「合并后总数正确、最新一期正确」
  assert.equal(result.totalCount, before.draws.length + (before.draws.some((d) => d.id === '2026-300') ? 0 : 1));
  assert.equal(result.latest.id, '2026-300');
  assert.equal(result.latest.special, 45);
  // dryRun 绝不能改动文件
  const after = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  assert.equal(after.draws.length, before.draws.length, 'dryRun 不允许写入');
});
