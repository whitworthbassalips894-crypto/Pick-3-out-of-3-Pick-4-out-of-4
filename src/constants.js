/**
 * 六合彩基础常量：49码波色、生肖映射、默认赔率与本金配置
 */

/**
 * 构建版本号（Build ID）
 *
 * 作用：Service Worker 缓存名、index.html 静态资源版本参数、页面底部版本号三处必须一致，
 * 任何一次改动前端文件都必须同步提升该版本号，否则旧缓存会与新代码混用导致页面卡死。
 * 由 tests/build-version.test.mjs 自动校验三处一致性。
 */
export const APP_BUILD = '2026.10.25-r4';

/** 页面上显示的版本标签 */
export const APP_VERSION_LABEL = `v${APP_BUILD}`;

export const ALL_NUMBERS = Array.from({ length: 49 }, (_, i) => i + 1);

export const WAVE_COLORS = {
  red: [1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46],
  blue: [3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48],
  green: [5, 6, 11, 16, 17, 21, 22, 27, 28, 32, 33, 38, 39, 43, 44, 49]
};

export const NUMBER_TO_COLOR = (() => {
  const map = {};
  for (const [color, nums] of Object.entries(WAVE_COLORS)) {
    for (const n of nums) {
      map[n] = color;
    }
  }
  return map;
})();

export const COLOR_LABELS = {
  red: '红波',
  blue: '蓝波',
  green: '绿波'
};

export const ZODIACS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

/**
 * 农历正月初一（春节）公历日期表，用于精确推算任意日期下 01~49 号对应的生肖
 */
export const LUNAR_NEW_YEAR_DATES = {
  2020: { date: '2020-01-25', zodiac: '鼠', prevZodiac: '猪' },
  2021: { date: '2021-02-12', zodiac: '牛', prevZodiac: '鼠' },
  2022: { date: '2022-02-01', zodiac: '虎', prevZodiac: '牛' },
  2023: { date: '2023-01-22', zodiac: '兔', prevZodiac: '虎' },
  2024: { date: '2024-02-10', zodiac: '龙', prevZodiac: '兔' },
  2025: { date: '2025-01-29', zodiac: '蛇', prevZodiac: '龙' },
  2026: { date: '2026-02-17', zodiac: '马', prevZodiac: '蛇' },
  2027: { date: '2027-02-06', zodiac: '羊', prevZodiac: '马' },
  2028: { date: '2028-01-26', zodiac: '猴', prevZodiac: '羊' }
};

/**
 * 获取指定日期/年份对应的当年生肖
 * @param {string|number} [dateOrYear='2026-10-24']
 * @returns {string} 生肖名称
 */
export function getYearZodiac(dateOrYear = '2026-10-24') {
  const str = String(dateOrYear || '2026-10-24').trim();
  const yearMatch = str.match(/^(\d{4})/);
  const year = yearMatch ? Number(yearMatch[1]) : 2026;
  const info = LUNAR_NEW_YEAR_DATES[year];
  if (info) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return str >= info.date ? info.zodiac : info.prevZodiac;
    }
    return info.zodiac;
  }
  // 通用年份生肖回退（2020 为鼠年 index=0）
  const idx = ((year - 2020) % 12 + 12) % 12;
  return ZODIACS[idx];
}

/**
 * 根据号码 (1..49) 和开奖日期获取对应生肖
 * @param {number} num 1..49
 * @param {string|number} [dateOrYear='2026-10-24']
 * @returns {string}
 */
export function getZodiacForNumber(num, dateOrYear = '2026-10-24') {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 49) return '';
  const yearZodiac = getYearZodiac(dateOrYear);
  const baseIdx = ZODIACS.indexOf(yearZodiac);
  const idx = ((baseIdx - (n - 1)) % 12 + 12) % 12;
  return ZODIACS[idx];
}

/**
 * 获取号码波色 ('red' | 'blue' | 'green')
 * @param {number} num 1..49
 * @returns {'red'|'blue'|'green'}
 */
export function getColorForNumber(num) {
  return NUMBER_TO_COLOR[Number(num)] || 'blue';
}

/**
 * 格式化号码为两位字符串 ('01' ~ '49')
 * @param {number|string} num
 * @returns {string}
 */
export function pad2(num) {
  const n = Number(num);
  if (Number.isNaN(n)) return String(num);
  return String(n).padStart(2, '0');
}

/**
 * 格式化期号为三位字符串 ('001' ~ '366')
 * @param {number|string} period
 * @returns {string}
 */
export function padPeriod(period) {
  const n = Number(period);
  if (Number.isNaN(n)) return String(period).trim();
  return String(n).padStart(3, '0');
}

/**
 * 默认收益与系统配置
 */
export const DEFAULT_CONFIG = {
  stake: 10, // 默认单注本金 10 元
  odds3: 650, // 默认三中三赔率 650 倍
  odds4: 7500, // 默认四中四赔率 7500 倍
  hitRule: 'normal_6_only', // 严格按传统连码规则：仅核对前 6 个正码（平一～平六）
  schemeMode: 'both_modes', // 双模式兼顾：7码复式全展开 + 5组策略推荐可切换
  activePlayType: 'pick3', // 'pick3' (三中三) | 'pick4' (四中四) | 'both'
  remoteSourceUrl: 'https://2026kj.zkclhb.com:2025/am.html'
};
