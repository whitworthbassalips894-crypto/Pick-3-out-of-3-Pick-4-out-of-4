import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_KEY_ALIASES,
  STORAGE_KEYS,
  findSourceKey,
  listKeys,
  loadPersistedState,
  persistMigratedState,
  safeSet,
  sanitizeConfig,
  sanitizePicks
} from '../src/storage.js';
import { DEFAULT_CONFIG } from '../src/constants.js';
import { normalizeDrawRecord } from '../src/parser.js';

/** 内存版 localStorage，便于单测 */
function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    keys: () => Array.from(map.keys()),
    _map: map
  };
}

const opts = { defaults: DEFAULT_CONFIG, normalizeDrawRecord };

test('正常读取：配置 / 自选 / 本地开奖 都能取回', () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.CONFIG]: JSON.stringify({ stake: 25, odds3: 660, odds4: 7600 }),
    [STORAGE_KEYS.CUSTOM_PICKS]: JSON.stringify({ picks: [3, 8, 15, 22, 29, 36, 43], pinned: [8, 29] }),
    [STORAGE_KEYS.LOCAL_DRAWS]: JSON.stringify([
      { id: '2026-297', year: 2026, period: '297', periodNum: 297, date: '2026-10-24', numbers: [3, 8, 15, 22, 29, 36], special: 43 }
    ])
  });

  const state = loadPersistedState(storage, opts);
  assert.equal(state.config.stake, 25);
  assert.equal(state.config.odds3, 660);
  assert.equal(state.config.odds4, 7600);
  assert.deepEqual(state.customPicks, [3, 8, 15, 22, 29, 36, 43]);
  assert.deepEqual(state.pinnedPicks, [8, 29]);
  assert.equal(state.localDraws.length, 1);
  assert.equal(state.localDraws[0].id, '2026-297');
  assert.deepEqual(state.migrations, []);
});

test('损坏的 localStorage 不会让页面崩溃：回落默认值并给出提示', () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.CONFIG]: '{不是合法 JSON',
    [STORAGE_KEYS.CUSTOM_PICKS]: JSON.stringify({ picks: ['x', 99, 0, 12, 12, 33], pinned: [99] }),
    [STORAGE_KEYS.LOCAL_DRAWS]: JSON.stringify({ not: 'an array' })
  });

  const state = loadPersistedState(storage, opts);
  assert.equal(state.config.stake, DEFAULT_CONFIG.stake);
  assert.equal(state.config.odds3, DEFAULT_CONFIG.odds3);
  assert.equal(state.config.odds4, DEFAULT_CONFIG.odds4);
  assert.deepEqual(state.customPicks, [12, 33]);
  assert.deepEqual(state.pinnedPicks, []);
  assert.deepEqual(state.localDraws, []);
  assert.ok(state.errors.length >= 1);
});

test('非法数值被修复为合法值', () => {
  const { config, repaired } = sanitizeConfig({ stake: -5, odds3: 'abc', odds4: 0 }, DEFAULT_CONFIG);
  assert.equal(config.stake, DEFAULT_CONFIG.stake);
  assert.equal(config.odds3, DEFAULT_CONFIG.odds3);
  assert.equal(config.odds4, DEFAULT_CONFIG.odds4);
  assert.equal(repaired, true);
});

test('旧版本键名可以迁移到规范键名，且不删除旧数据', () => {
  const storage = createMemoryStorage({
    mark6_pick3_config: JSON.stringify({ stake: 15, odds3: 650, odds4: 7500 }),
    mark6_pick3_custom_picks: JSON.stringify({ picks: [1, 2, 3, 4, 5, 6, 7], pinned: [1] })
  });

  const state = loadPersistedState(storage, opts);
  assert.equal(state.config.stake, 15);
  assert.deepEqual(state.customPicks, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(state.pinnedPicks, [1]);
  assert.ok(state.migrations.length >= 2);

  persistMigratedState(storage, state);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.CONFIG)).stake, 15);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.CUSTOM_PICKS)).picks, [1, 2, 3, 4, 5, 6, 7]);
  // 旧键仍然保留，避免数据丢失
  assert.ok(storage.getItem('mark6_pick3_config') != null);
});

test('未知键名按关键字兜底识别（老版本自定义键名也能救回来）', () => {
  const storage = createMemoryStorage({
    mytool_draws_v0: JSON.stringify([
      { year: 2026, periodNum: 298, date: '2026-10-25', numbers: [1, 2, 3, 4, 5, 6], special: 7 }
    ])
  });
  assert.equal(findSourceKey(storage, 'LOCAL_DRAWS'), 'mytool_draws_v0');
  const state = loadPersistedState(storage, opts);
  assert.equal(state.localDraws.length, 1);
  assert.equal(state.localDraws[0].id, '2026-298');
});

test('本地开奖记录里的非法号码会被剔除，不影响其它记录', () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.LOCAL_DRAWS]: JSON.stringify([
      { year: 2026, periodNum: 298, date: '2026-10-25', numbers: [1, 2, 3, 4, 5, 60], special: 7 },
      { year: 2026, periodNum: 299, date: '2026-10-26', numbers: [1, 2, 3, 4, 5, 6], special: 7 }
    ])
  });
  const state = loadPersistedState(storage, opts);
  assert.equal(state.localDraws.length, 1);
  assert.equal(state.localDraws[0].id, '2026-299');
});

test('safeSet 在存储不可用时静默失败，不抛异常', () => {
  const broken = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); }
  };
  assert.equal(safeSet(broken, 'k', { a: 1 }), false);
  assert.deepEqual(listKeys(broken), []);
});

test('自选号码清洗：去重、限 7 个、胆码必须属于选号', () => {
  const { picks, pinned } = sanitizePicks({ picks: [5, 5, 6, 7, 8, 9, 10, 11, 12], pinned: [5, 99] });
  assert.deepEqual(picks, [5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(pinned, [5]);
});

test('已知别名表覆盖三类数据', () => {
  assert.ok(LEGACY_KEY_ALIASES.CONFIG.length > 0);
  assert.ok(LEGACY_KEY_ALIASES.LOCAL_DRAWS.length > 0);
  assert.ok(LEGACY_KEY_ALIASES.CUSTOM_PICKS.length > 0);
});
