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

test('historical database contains all 1759 draws across 2022-2026 and matches draws.js', () => {
  assert.ok(fs.existsSync(JSON_PATH), 'data/draws.json must exist');
  const jsonDb = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));

  assert.equal(jsonDb.totalCount, 1759);
  assert.equal(jsonDb.draws.length, 1759);
  assert.equal(INITIAL_DB.draws.length, 1759);
  assert.deepEqual(jsonDb.years, [2026, 2025, 2024, 2023, 2022]);
  assert.equal(jsonDb.latestId, '2026-298');
  assert.equal(jsonDb.latestDate, '2026-10-25');

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

  assert.equal(countByYear[2022], 365);
  assert.equal(countByYear[2023], 365);
  assert.equal(countByYear[2024], 366);
  assert.equal(countByYear[2025], 365);
  assert.equal(countByYear[2026], 298);
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

  const result = await syncDraws({ rawText: mockHtml, dryRun: true });
  assert.equal(result.parsedCount, 1);
  assert.equal(result.addedCount, 1);
  assert.equal(result.totalCount, 1760);
  assert.equal(result.latest.id, '2026-300');
});
