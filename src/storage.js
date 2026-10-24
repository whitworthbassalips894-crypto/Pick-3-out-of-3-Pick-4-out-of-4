/**
 * 本地存储（localStorage）读写与旧版本数据迁移
 *
 * 设计要点：
 * 1. 键名保持稳定（mark6_pick3_*_v1），升级不丢用户的本金/赔率、自选号码、胆码、本地录入的开奖。
 * 2. 遇到损坏的 JSON / 非法数值 / 非法号码时静默降级为默认值，绝不让整页白屏。
 * 3. 兼容更早版本可能使用过的其它键名：优先按已知别名表迁移，再按「键名包含 config / draw / pick」做兜底扫描。
 * 4. 所有函数都接受一个 storage 后端参数，方便单元测试用内存实现替换浏览器 localStorage。
 */

/** 当前版本使用的规范键名 */
export const STORAGE_KEYS = {
  CONFIG: 'mark6_pick3_config_v1',
  LOCAL_DRAWS: 'mark6_pick3_local_draws_v1',
  CUSTOM_PICKS: 'mark6_pick3_custom_picks_v1'
};

/** 历史上可能用过的其它键名（按优先级排列） */
export const LEGACY_KEY_ALIASES = {
  CONFIG: ['mark6_pick3_config', 'mark6_config', 'pk3_config', 'pick3_config', 'config'],
  LOCAL_DRAWS: ['mark6_pick3_local_draws', 'mark6_local_draws', 'mark6_draws', 'pk3_local_draws', 'local_draws'],
  CUSTOM_PICKS: ['mark6_pick3_custom_picks', 'mark6_picks', 'mark6_custom_picks', 'pk3_picks', 'custom_picks']
};

const KEY_HINTS = {
  CONFIG: ['config', 'setting', 'odds', 'stake'],
  LOCAL_DRAWS: ['draw', 'result', 'history'],
  CUSTOM_PICKS: ['pick', 'ball', 'selection']
};

function isStorageLike(backend) {
  return Boolean(backend && typeof backend.getItem === 'function' && typeof backend.setItem === 'function');
}

function safeParse(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * 列出 storage 中的全部键（浏览器与内存实现都支持）
 * @param {object} backend
 * @returns {string[]}
 */
export function listKeys(backend) {
  if (!isStorageLike(backend)) return [];
  if (typeof backend.keys === 'function') {
    try {
      return Array.from(backend.keys());
    } catch {
      return [];
    }
  }
  if (typeof backend.length === 'number' && typeof backend.key === 'function') {
    const out = [];
    for (let i = 0; i < backend.length; i++) {
      const k = backend.key(i);
      if (k) out.push(k);
    }
    return out;
  }
  return [];
}

/**
 * 查找某个用途的候选键（规范键优先，其次别名表，最后按关键字兜底）
 * @param {object} backend
 * @param {'CONFIG'|'LOCAL_DRAWS'|'CUSTOM_PICKS'} kind
 * @returns {string|null}
 */
export function findSourceKey(backend, kind) {
  if (!isStorageLike(backend)) return null;
  const canonical = STORAGE_KEYS[kind];
  if (backend.getItem(canonical) != null) return canonical;

  for (const alias of LEGACY_KEY_ALIASES[kind] || []) {
    if (backend.getItem(alias) != null) return alias;
  }
  const hints = KEY_HINTS[kind] || [];
  const lower = hints.map((h) => h.toLowerCase());
  const candidate = listKeys(backend).find((k) => {
    const lk = String(k).toLowerCase();
    if (lk === canonical.toLowerCase()) return false;
    return lower.some((h) => lk.includes(h));
  });
  return candidate || null;
}

/**
 * 清洗本金/赔率配置：非法值回落到默认值
 * @param {any} raw
 * @param {object} defaults
 * @returns {{config: object, repaired: boolean}}
 */
export function sanitizeConfig(raw, defaults) {
  const out = { ...defaults };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: out, repaired: Boolean(raw) };
  }
  let repaired = false;
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      if (value != null) repaired = true;
      return fallback;
    }
    if (n < min || n > max) {
      repaired = true;
      return Math.min(max, Math.max(min, n));
    }
    return n;
  };
  out.stake = num(raw.stake, defaults.stake, 1, 1_000_000);
  out.odds3 = num(raw.odds3, defaults.odds3, 1, 1_000_000);
  out.odds4 = num(raw.odds4, defaults.odds4, 1, 1_000_000);
  if (raw.hitRule) out.hitRule = String(raw.hitRule);
  if (raw.remoteSourceUrl) out.remoteSourceUrl = String(raw.remoteSourceUrl);
  return { config: out, repaired };
}

/**
 * 清洗自选号码：只保留 1~49 的整数、去重、限制最多 7 个
 * @param {any} raw
 * @returns {{picks: number[], pinned: number[], repaired: boolean}}
 */
export function sanitizePicks(raw) {
  const empty = { picks: [], pinned: [], repaired: false };
  if (!raw || typeof raw !== 'object') return empty;
  const toNums = (list) => {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      const n = Number(item);
      if (Number.isInteger(n) && n >= 1 && n <= 49 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  };
  const picks = toNums(raw.picks ?? raw.numbers ?? raw.selection).sort((a, b) => a - b).slice(0, 7);
  const pinned = toNums(raw.pinned ?? raw.dan ?? raw.locked)
    .filter((n) => picks.includes(n))
    .sort((a, b) => a - b)
    .slice(0, 6);
  const repaired = !Array.isArray(raw.picks ?? raw.numbers ?? raw.selection) && raw != null;
  return { picks, pinned, repaired };
}

/**
 * 读取并迁移本地持久化数据
 * @param {object} backend localStorage 兼容对象
 * @param {{defaults: object, normalizeDrawRecord: Function}} options
 * @returns {{config: object, localDraws: object[], customPicks: number[], pinnedPicks: number[], migrations: string[], errors: string[]}}
 */
export function loadPersistedState(backend, options = {}) {
  const defaults = options.defaults || {};
  const normalizeDrawRecord = options.normalizeDrawRecord || ((x) => x);
  const migrations = [];
  const errors = [];

  // —— 配置 ——
  let config = { ...defaults };
  const configKey = findSourceKey(backend, 'CONFIG');
  if (configKey) {
    const parsed = safeParse(backend.getItem(configKey));
    const { config: clean, repaired } = sanitizeConfig(parsed, defaults);
    config = clean;
    if (repaired) errors.push(`配置 ${configKey} 中存在非法数值，已重置为默认值`);
    if (configKey !== STORAGE_KEYS.CONFIG) {
      migrations.push(`${configKey} → ${STORAGE_KEYS.CONFIG}`);
    }
  }

  // —— 本地录入的开奖 ——
  let localDraws = [];
  const drawsKey = findSourceKey(backend, 'LOCAL_DRAWS');
  if (drawsKey) {
    const parsed = safeParse(backend.getItem(drawsKey));
    if (Array.isArray(parsed)) {
      localDraws = parsed.map(normalizeDrawRecord).filter(Boolean);
    } else if (parsed != null) {
      errors.push(`本地开奖 ${drawsKey} 格式损坏，已忽略`);
    }
    if (drawsKey !== STORAGE_KEYS.LOCAL_DRAWS) {
      migrations.push(`${drawsKey} → ${STORAGE_KEYS.LOCAL_DRAWS}`);
    }
  }

  // —— 自选号码 / 胆码 ——
  let customPicks = [];
  let pinnedPicks = [];
  const picksKey = findSourceKey(backend, 'CUSTOM_PICKS');
  if (picksKey) {
    const parsed = safeParse(backend.getItem(picksKey));
    const { picks, pinned } = sanitizePicks(parsed);
    customPicks = picks;
    pinnedPicks = pinned;
    if (picksKey !== STORAGE_KEYS.CUSTOM_PICKS) {
      migrations.push(`${picksKey} → ${STORAGE_KEYS.CUSTOM_PICKS}`);
    }
  }

  return { config, localDraws, customPicks, pinnedPicks, migrations, errors };
}

/**
 * 安全写入（隐私模式 / 配额满时不抛错）
 * @param {object} backend
 * @param {string} key
 * @param {any} value
 * @returns {boolean} 是否写入成功
 */
export function safeSet(backend, key, value) {
  if (!isStorageLike(backend)) return false;
  try {
    backend.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把迁移过来的旧键数据写回规范键名（不删除旧键，避免用户数据丢失）
 * @param {object} backend
 * @param {ReturnType<typeof loadPersistedState>} state
 */
export function persistMigratedState(backend, state) {
  if (!isStorageLike(backend)) return;
  if (state.migrations.length === 0) return;
  safeSet(backend, STORAGE_KEYS.CONFIG, state.config);
  safeSet(backend, STORAGE_KEYS.LOCAL_DRAWS, state.localDraws);
  safeSet(backend, STORAGE_KEYS.CUSTOM_PICKS, { picks: state.customPicks, pinned: state.pinnedPicks });
}
