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

test('配置里的玩法（playMode）只接受 special / pick3 / pick4，其它值回落默认', () => {
  const cfg = (raw) => sanitizeConfig(raw, DEFAULT_CONFIG).config;
  assert.equal(cfg({ playMode: 'special' }).playMode, 'special');
  assert.equal(cfg({ playMode: 'pick3' }).playMode, 'pick3');
  assert.equal(cfg({ playMode: 'pick4' }).playMode, 'pick4');
  assert.equal(cfg({ playMode: 'replay' }).playMode, DEFAULT_CONFIG.playMode);
  assert.equal(cfg({ playMode: '四' }).playMode, DEFAULT_CONFIG.playMode);
  assert.equal(cfg({}).playMode, DEFAULT_CONFIG.playMode);
  assert.equal(DEFAULT_CONFIG.playMode, 'special');
});

test('旧版 targetSize（3 / 4）会迁移成 playMode', () => {
  const cfg = (raw) => sanitizeConfig(raw, DEFAULT_CONFIG).config;
  assert.equal(cfg({ targetSize: 3 }).playMode, 'pick3');
  assert.equal(cfg({ targetSize: 4 }).playMode, 'pick4');
  assert.equal(cfg({ targetSize: 7 }).playMode, DEFAULT_CONFIG.playMode);
  // 已经是新版的 playMode 时不再被 targetSize 覆盖
  assert.equal(cfg({ playMode: 'special', targetSize: 4 }).playMode, 'special');
});

test('特码赔率可读写，非法值回落默认 9.6', () => {
  const cfg = (raw) => sanitizeConfig(raw, DEFAULT_CONFIG).config;
  assert.equal(cfg({ oddsSpecial: 9.8 }).oddsSpecial, 9.8);
  assert.equal(cfg({ oddsSpecial: 20 }).oddsSpecial, 20);
  assert.equal(cfg({ oddsSpecial: 0 }).oddsSpecial, DEFAULT_CONFIG.oddsSpecial);
  assert.equal(cfg({ oddsSpecial: -5 }).oddsSpecial, DEFAULT_CONFIG.oddsSpecial);
  assert.equal(cfg({ oddsSpecial: 'abc' }).oddsSpecial, DEFAULT_CONFIG.oddsSpecial);
  // 超出上限按上限收敛（与本金 / 三中三 / 四中四赔率同一套规则）
  assert.equal(cfg({ oddsSpecial: 1e9 }).oddsSpecial, 1_000_000);
  assert.equal(DEFAULT_CONFIG.oddsSpecial, 9.6);
});

test('旧版本默认写下的 48 倍特码赔率会迁移成 9.6（默认值错误修正）', () => {
  const cfg = (raw) => sanitizeConfig(raw, DEFAULT_CONFIG).config;
  // 48 是上一版的默认值（“押 1 个号”的赔率），套到 5 个号上期望回报率高达 489.8%
  assert.equal(cfg({ oddsSpecial: 48 }).oddsSpecial, 9.6);
  // 用户自己填过的其它数值保持不变
  assert.equal(cfg({ oddsSpecial: 20 }).oddsSpecial, 20);
  assert.equal(cfg({ oddsSpecial: 9.8 }).oddsSpecial, 9.8);
});

test('玩法配置能正常读写并迁移', () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.CONFIG]: JSON.stringify({ stake: 20, odds3: 650, odds4: 7500, targetSize: 4 })
  });
  const state = loadPersistedState(storage, opts);
  assert.equal(state.config.playMode, 'pick4');
  assert.equal(state.config.stake, 20);
});

test('兜底扫描只认带本工具标识（pick3/pk3）的键名', () => {
  const storage = createMemoryStorage({
    mytool_pick3_draws_v0: JSON.stringify([
      { year: 2026, periodNum: 298, date: '2026-10-25', numbers: [1, 2, 3, 4, 5, 6], special: 7 }
    ])
  });
  assert.equal(findSourceKey(storage, 'LOCAL_DRAWS'), 'mytool_pick3_draws_v0');
  const state = loadPersistedState(storage, opts);
  assert.equal(state.localDraws.length, 1);
  assert.equal(state.localDraws[0].id, '2026-298');
});

test('同域其它工具的键不会被误认成本工具的数据（跨工具污染防护）', () => {
  const storage = createMemoryStorage({
    // 同一个 GitHub Pages 源下部署的另一个工具
    'mark6-lottery-tool-v2_config': JSON.stringify({ stake: 999, odds3: 1, odds4: 2 }),
    'some-other-app-cache': JSON.stringify({ stake: 888 }),
    mark6_lottery_config: JSON.stringify({ stake: 777 }),
    other_tool_draws: JSON.stringify([
      { year: 2026, periodNum: 298, date: '2026-10-25', numbers: [1, 2, 3, 4, 5, 6], special: 7 }
    ])
  });

  // 不应命中任何其它工具的键
  assert.equal(findSourceKey(storage, 'CONFIG'), null);
  assert.equal(findSourceKey(storage, 'LOCAL_DRAWS'), null);
  assert.equal(findSourceKey(storage, 'CUSTOM_PICKS'), null);

  // 读出来的必须是默认值，而不是别的工具的赔率
  const state = loadPersistedState(storage, opts);
  assert.equal(state.config.stake, DEFAULT_CONFIG.stake);
  assert.equal(state.config.odds3, DEFAULT_CONFIG.odds3);
  assert.deepEqual(state.localDraws, []);
});

test('形状不匹配的键不会被当成配置（例如数组冒充 config）', () => {
  const storage = createMemoryStorage({
    pick3_config: JSON.stringify([1, 2, 3])
  });
  assert.equal(findSourceKey(storage, 'CONFIG'), null);
  const state = loadPersistedState(storage, opts);
  assert.equal(state.config.stake, DEFAULT_CONFIG.stake);
});

test('随机注盐值可以持久化与迁移', () => {
  const storage = createMemoryStorage({
    [STORAGE_KEYS.RANDOM_SALT]: JSON.stringify(3)
  });
  const state = loadPersistedState(storage, opts);
  assert.equal(state.randomSalt, 3);

  const legacy = createMemoryStorage({
    mark6_pick3_random_salt: JSON.stringify(7)
  });
  const legacyState = loadPersistedState(legacy, opts);
  assert.equal(legacyState.randomSalt, 7);
  assert.ok(
    legacyState.migrations.some((m) => m.includes('mark6_pick3_random_salt') && m.includes(STORAGE_KEYS.RANDOM_SALT)),
    '旧盐值键应当被迁移到规范键名'
  );
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
