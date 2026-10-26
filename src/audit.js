/**
 * 底库体检：把「开奖数据本身是否可信」变成一个可检查、可展示的结论
 *
 * 背景：底库里存在一行坏数据（2022 年第 132 期，6 个正码里 33 出现了两次），
 * 这类行如果被直接消费，会让同一个号在一次开奖里被记两次频率，
 * 或者让「命中 3 个正码」的判定悄悄变形（实际只有 5 个不同号码）。
 * 因此这里提供：
 *   - isUsableDraw：单期是否可用于统计（正码必须 6 个互不重复的合法号码）
 *   - auditDraws：整库体检，输出结构化问题清单，页面与测试共用
 *
 * 说明：体检只「报告 + 隔离」，绝不猜测/编造缺失的号码。
 */

import { ALL_NUMBERS } from './constants.js';

const VALID = new Set(ALL_NUMBERS);

/**
 * 号码是否合法（1~49 的整数）
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidNumber(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && VALID.has(n);
}

/**
 * 该期能否用于统计：6 个正码合法且互不重复，特码合法且不与正码重复
 * @param {{ numbers?: unknown[], special?: unknown }} draw
 * @returns {boolean}
 */
export function isUsableDraw(draw) {
  if (!draw || !Array.isArray(draw.numbers)) return false;
  const normals = draw.numbers.slice(0, 6);
  if (normals.length !== 6) return false;
  if (!normals.every(isValidNumber)) return false;
  if (new Set(normals.map(Number)).size !== 6) return false;
  if (!isValidNumber(draw.special)) return false;
  if (normals.map(Number).includes(Number(draw.special))) return false;
  return true;
}

/** 把 'YYYY-MM-DD' 加一天（UTC，避免时区漂移） */
function addDays(dateStr, days = 1) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  const dt = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return '';
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * 底库体检
 * @param {object[]} draws 开奖记录（应当按时间降序，最新在前）
 * @returns {{
 *   total: number,
 *   usable: number,
 *   issueCount: number,
 *   issues: Array<{ id: string, date: string, type: string, level: 'error'|'warn', message: string }>,
 *   byType: Record<string, number>
 * }}
 */
export function auditDraws(draws = []) {
  const list = Array.isArray(draws) ? draws : [];
  const issues = [];
  const push = (draw, type, level, message) => {
    issues.push({ id: String(draw?.id ?? '—'), date: String(draw?.date ?? ''), type, level, message });
  };

  const seenIds = new Set();
  let usable = 0;
  let prev = null; // 上一条（更新的一期）

  for (const draw of list) {
    const id = String(draw?.id ?? '—');

    if (seenIds.has(id)) push(draw, 'duplicate-id', 'error', `期号 ${id} 重复出现`);
    seenIds.add(id);

    // 排序：降序，最新在前
    if (prev) {
      const newer = prev.year > draw.year || (prev.year === draw.year && prev.periodNum > draw.periodNum);
      if (!newer) push(draw, 'out-of-order', 'warn', `期号顺序错乱：${prev.id} 之后应该是更早的一期，实际出现 ${id}`);
    }
    prev = draw;

    if (String(draw?.period ?? '').padStart(3, '0') !== String(draw?.periodNum ?? '').padStart(3, '0')) {
      push(draw, 'period-mismatch', 'warn', `期号字段不一致：period=${draw?.period} / periodNum=${draw?.periodNum}`);
    }

    const normals = Array.isArray(draw?.numbers) ? draw.numbers : [];
    if (normals.length !== 6) {
      push(draw, 'normal-count', 'error', `正码应为 6 个，实际 ${normals.length} 个`);
    }
    const invalid = normals.filter((n) => !isValidNumber(n));
    if (invalid.length) push(draw, 'normal-range', 'error', `正码含非法号码：${invalid.join('、')}`);
    const validNormals = normals.filter(isValidNumber).map(Number);
    if (new Set(validNormals).size !== validNormals.length) {
      const dup = validNormals.filter((n, i) => validNormals.indexOf(n) !== i);
      push(draw, 'normal-duplicate', 'error', `正码里 ${[...new Set(dup)].join('、')} 重复出现（只凑得出 ${new Set(validNormals).size} 个不同号码）`);
    }

    if (!isValidNumber(draw?.special)) {
      push(draw, 'special-range', 'error', `特码非法或缺失：${draw?.special}`);
    } else if (validNormals.includes(Number(draw.special))) {
      push(draw, 'special-in-normals', 'error', `特码 ${draw.special} 同时出现在 6 个正码里`);
    }

    if (isUsableDraw(draw)) usable++;
  }

  // 日期连续性 + 跨年期号（只在同一年内检查期号递增，跨年不报）
  for (let i = list.length - 1; i > 0; i--) {
    const older = list[i];
    const newer = list[i - 1];
    if (!older?.date || !newer?.date) continue;
    const expected = addDays(older.date, 1);
    if (!expected) {
      push(older, 'date-format', 'warn', `日期格式异常：${older.date}`);
      continue;
    }
    if (newer.date !== expected) {
      push(newer, 'date-gap', 'warn', `日期不连续：${older.id}（${older.date}）之后应为 ${expected}，实际 ${newer.date}`);
    }
    if (newer.year === older.year && Number(newer.periodNum) !== Number(older.periodNum) + 1) {
      push(newer, 'period-gap', 'warn', `同一年内期号不连续：${older.id} 之后应为第 ${Number(older.periodNum) + 1} 期，实际 ${newer.id}`);
    }
  }

  const byType = {};
  for (const it of issues) byType[it.type] = (byType[it.type] || 0) + 1;

  return {
    total: list.length,
    usable,
    issueCount: issues.length,
    issues,
    byType
  };
}

/**
 * 体检结论的一句话摘要（页面直接用）
 * @param {ReturnType<typeof auditDraws>} report
 * @returns {string}
 */
export function formatAuditSummary(report) {
  if (!report || !report.total) return '底库为空，缺少可体检的数据。';
  if (report.issueCount === 0) {
    return `底库 ${report.total} 期体检通过：期号连续、正码 6 个互不重复、特码不与正码重叠。`;
  }
  const errors = report.issues.filter((i) => i.level === 'error').length;
  const warns = report.issues.length - errors;
  const worst = report.issues.slice(0, 3).map((i) => `${i.id}：${i.message}`).join('；');
  return `底库 ${report.total} 期中可正常统计 ${report.usable} 期；发现 ${errors} 处错误、${warns} 处提醒（${worst}${report.issues.length > 3 ? ' …' : ''}）。坏行会被自动排除在统计之外，不会被猜测补全。`;
}
