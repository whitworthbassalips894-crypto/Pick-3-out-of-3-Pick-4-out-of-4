/**
 * 本地存储（localStorage）读写与旧版本数据迁移
 *
 * 设计要点：
 * 1. 键名保持稳定（mark6_pick3_*_v1），升级不丢用户的本金/赔率、自选号码、胆码、本地录入的开奖。
 * 2. 遇到损坏的 JSON / 非法数值 / 非法号码时静默降级为默认值，绝不让整页白屏。
 * 3. 兼容更早版本可能使用过的其它键名：优先按已知别名表迁移，再按「键名含 pick3/pk3」做窄范围兜底扫描。
 *    ⚠ 绝不做无差别全键扫描：同一个 GitHub Pages 源下可能还部署着别的工具，
 *       把别的工具的 `*_config` 当成本工具的赔率会直接改坏用户的投注参数。
 * 4. 所有函数都接受一个 storage 后端参数，方便单元测试用内存实现替换浏览器 localStorage。
 */

/** 当前版本使用的规范键名 */
export const STORAGE_KEYS = {
  CONFIG: 'mark6_pick3_config_v1',
  LOCAL_DRAWS: 'mark6_pick3_local_draws_v1',
  CUSTOM_PICKS: 'mark6_pick3_custom_picks_v1',
  RANDOM_SALT: 'mark6_pick3_random_salt_v1'
};

/** 历史上可能用过的其它键名（按优先级排列） */
export const LEGACY_KEY_ALIASES = {
  CONFIG: ['mark6_pick3_config', 'mark6_config', 'pk3_config', 'pick3_config', 'config'],
  LOCAL_DRAWS: ['mark6_pick3_local_draws', 'mark6_local_draws', 'mark6_draws', 'pk3_local_draws', 'local_draws'],
  CUSTOM_PICKS: ['mark6_pick3_custom_picks', 'mark6_picks', 'mark6_custom_picks', 'pk3_picks', 'custom_picks'],
  RANDOM_SALT: ['mark6_pick3_random_salt', 'pk3_random_salt']
};

const KEY_HINTS = {
  CONFIG: ['config', 'setting', 'odds', 'stake'],
  LOCAL_DRAWS: ['draw', 'result', 'history'],
  CUSTOM_PICKS: ['pick', 'ball', 'selection']
};

/**
 * 兜底扫描时允许的键名特征：必须明确包含本工具标识，避免误伤同域其它工具
 * （例如 mark6-lottery-tool-v2_config）
 */
const OWNER_KEY_PATTERN = /(^|[_.-])(pick3|pk3)([_.-]|$)/i;

/** 各类数据期望的形状：形状不匹配的键一律不采用 */
const VALUE_SHAPES = {
  CONFIG: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && ('stake' in v || 'odds3' in v || 'odds4' in v || 'hitRule' in v),
  LOCAL_DRAWS: (v) => Array.isArray(v),
  CUSTOM_PICKS: (v) => Array.isArray(v)
    || (Boolean(v) && typeof v === 'object' && (Array.isArray(v.picks) || Array.isArray(v.numbers) || Array.isArray(v.selection))),
  RANDOM_SALT: (v) => Number.isFinite(Number(v))
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
 * 查找某个用途的候选键（规范键优先 → 已知别名表 → 含本工具标识的窄范围兜底扫描）
 *
 * 三道保险，避免把同域其它工具的数据当成本工具的数据：
 *  1. 兜底扫描只认包含 pick3 / pk3 的键名；
 *  2. 候选值必须通过该用途的形状校验；
 *  3. 命中后立即停止，不会再匹配更弱的候选。
 *
 * @param {object} backend
 * @param {'CONFIG'|'LOCAL_DRAWS'|'CUSTOM_PICKS'|'RANDOM_SALT'} kind
 * @returns {string|null}
 */
export function findSourceKey(backend, kind) {
  if (!isStorageLike(backend)) return null;
  const canonical = STORAGE_KEYS[kind];
  const shapeOk = VALUE_SHAPES[kind];

  const usable = (key) => {
    if (key == null) return false;
    const raw = backend.getItem(key);
    if (raw == null) return false;
    if (!shapeOk) return true;
    const parsed = safeParse(raw);
    return parsed !== undefined && shapeOk(parsed);
  };

  if (usable(canonical)) return canonical;

  for (const alias of LEGACY_KEY_ALIASES[kind] || []) {
    if (usable(alias)) return alias;
  }

  // 窄范围兜底：键名必须明确带有本工具标识
  const hints = (KEY_HINTS[kind] || []).map((h) => h.toLowerCase());
  const candidate = listKeys(backend).find((k) => {
    const lk = String(k).toLowerCase();
    if (lk === String(canonical).toLowerCase()) return false;
    if (!OWNER_KEY_PATTERN.test(lk)) return false;
    return hints.some((h) => lk.includes(h));
  });
  return candidate && usable(candidate) ? candidate : null;
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
  // 直选玩法：3 = 三中三，4 = 四中四
  const size = Number(raw.targetSize);
  if (size !== 3 && size !== 4) {
    if (raw.targetSize != null) repaired = true;
    out.targetSize = defaults.targetSize === 4 ? 4 : 3;
  } else {
    out.targetSize = size;
  }
  if (raw.hitRule) out.hitRule = String(raw.hitRule);
  if (raw.remoteSourceUrl) out.remoteSourceUrl = String(raw.remoteSourceUrl);
  return { config: out, repaired };
}

/**
 * 清洗自选号码：只保留 1~49 的整数、去重、限制最多 4 个（直选最大 4 码）
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
  // 存储层仍保留 7 个号的上限（不丢老用户数据）；直选玩法在应用层按 3 / 4 个号收敛
  const picks = toNums(raw.picks ?? raw.numbers ?? raw.selection).sort((a, b) => a - b).slice(0, 7);
  const pinned = toNums(raw.pinned ?? raw.dan ?? raw.locked)
    .filter((n) => picks.includes(n))
    .sort((a, b) => a - b)
    .slice(0, 6);
  const repaired = !Array.isArray(raw.picks ?? raw.numbers ?? raw.selection) && raw != null;
  return { picks, pinned, repaired };
}

/**
 * 解析实际使用的键：规范键存在就用规范键（即使内容损坏也要报出来），否则回落到旧键迁移
 * @param {object} backend
 * @param {'CONFIG'|'LOCAL_DRAWS'|'CUSTOM_PICKS'|'RANDOM_SALT'} kind
 * @returns {string|null}
 */
export function resolveKey(backend, kind) {
  if (!isStorageLike(backend)) return null;
  const canonical = STORAGE_KEYS[kind];
  if (backend.getItem(canonical) != null) return canonical;
  return findSourceKey(backend, kind);
}

/**
 * 读取并迁移本地持久化数据
 * @param {object} backend localStorage 兼容对象
 * @param {{defaults: object, normalizeDrawRecord: Function}} options
 * @returns {{config: object, localDraws: object[], customPicks: number[], pinnedPicks: number[], randomSalt: number, migrations: string[], errors: string[]}}
 */
export function loadPersistedState(backend, options = {}) {
  const defaults = options.defaults || {};
  const normalizeDrawRecord = options.normalizeDrawRecord || ((x) => x);
  const migrations = [];
  const errors = [];

  // —— 配置 ——
  let config = { ...defaults };
  const configKey = resolveKey(backend, 'CONFIG');
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
  const drawsKey = resolveKey(backend, 'LOCAL_DRAWS');
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
  const picksKey = resolveKey(backend, 'CUSTOM_PICKS');
  if (picksKey) {
    const parsed = safeParse(backend.getItem(picksKey));
    const { picks, pinned } = sanitizePicks(parsed);
    customPicks = picks;
    pinnedPicks = pinned;
    if (picksKey !== STORAGE_KEYS.CUSTOM_PICKS) {
      migrations.push(`${picksKey} → ${STORAGE_KEYS.CUSTOM_PICKS}`);
    }
  }

  // —— 随机注重摇次数 ——
  let randomSalt = 0;
  const saltKey = resolveKey(backend, 'RANDOM_SALT');
  if (saltKey) {
    const parsed = safeParse(backend.getItem(saltKey));
    const n = Number(parsed);
    if (Number.isFinite(n) && n >= 0) randomSalt = Math.floor(n);
    if (saltKey !== STORAGE_KEYS.RANDOM_SALT) {
      migrations.push(`${saltKey} → ${STORAGE_KEYS.RANDOM_SALT}`);
    }
  }

  return { config, localDraws, customPicks, pinnedPicks, randomSalt, migrations, errors };
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
  safeSet(backend, STORAGE_KEYS.RANDOM_SALT, state.randomSalt || 0);
}
