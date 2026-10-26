/**
 * 期号日历工具：从「最新一期」推算「下一期」
 *
 * 底库的期号约定：**当年第几天就是第几期**（2022-001 = 2022-01-01，2024 年有 366 期）。
 *
 * 历史 bug（2026-10-26 修复）：旧实现用 `periodNum > 366` 判断跨年，
 * 结果 2026 年（平年 365 天）的 12-31 会被算成「2026 年第 366 期」这种不存在的期号，
 * 因为判断依赖的是一个固定常量而不是日历。
 * 正确做法：先算「下一期的日期」，再由日期的年份决定期号是否从 001 重来。
 */

/**
 * 'YYYY-MM-DD' → Date（UTC 零点），非法返回 null
 * @param {string} dateStr
 * @returns {Date|null}
 */
export function parseIsoDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const dt = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  // 反向校验，挡掉 2026-02-31 / 2026-13-01 这类会被 Date 自动进位的假日期
  if (dt.toISOString().slice(0, 10) !== dateStr) return null;
  return dt;
}

/**
 * 日期加减天数
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {number} [days=1]
 * @returns {string} 失败返回 ''
 */
export function addDays(dateStr, days = 1) {
  const dt = parseIsoDate(dateStr);
  if (!dt) return '';
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * 某个公历年份的天数
 * @param {number} year
 * @returns {365|366}
 */
export function daysInYear(year) {
  const y = Number(year);
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

/**
 * 由「最新一期」推算下一期的年份 / 期号 / 日期
 *
 * @param {{ year?: number, periodNum?: number, date?: string }} [latestDraw]
 * @returns {{ id: 'NEXT', year: number, periodNum: number, period: string, date: string, isUpcoming: true }}
 */
export function nextPeriodMeta(latestDraw) {
  const latest = latestDraw && Number.isFinite(Number(latestDraw.year))
    ? latestDraw
    : { year: 2026, periodNum: 296, date: '2026-10-23' };

  const year = Number(latest.year);
  const periodNum = Number(latest.periodNum) || 0;

  // 优先按日期推进：日期能解析就用「上一期日期 + 1 天」，年份变化时期号从 001 重来
  const nextDate = addDays(latest.date, 1);
  if (nextDate) {
    const dateYear = Number(nextDate.slice(0, 4));
    const sameYear = dateYear === year;
    const nextNum = sameYear ? periodNum + 1 : 1;
    return {
      id: 'NEXT',
      year: dateYear,
      periodNum: nextNum,
      period: String(nextNum).padStart(3, '0'),
      date: nextDate,
      isUpcoming: true
    };
  }

  // 日期缺失/非法时退回「期号 + 1」，并用当年天数兜底跨年
  const nextNum = periodNum >= daysInYear(year) ? 1 : periodNum + 1;
  const nextYear = periodNum >= daysInYear(year) ? year + 1 : year;
  return {
    id: 'NEXT',
    year: nextYear,
    periodNum: nextNum,
    period: String(nextNum).padStart(3, '0'),
    date: `${nextYear}-01-01`,
    isUpcoming: true
  };
}
