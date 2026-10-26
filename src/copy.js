/**
 * 复制内容格式化（纯函数，便于单元测试）
 *
 * 规则（用户明确要求）：
 *  - 复制出来**只有号码**，每注一行；
 *  - 不要任何汉字、标题、注号、日期、赔率等多余文字与数字；
 *  - 号码之间用一个空格分隔，注与注之间用换行分隔。
 */

import { pad2 } from './constants.js';

/** 单注号码 → "07 12 33 41 45 48 09" */
export function formatNumberLine(nums) {
  return (nums || []).map(pad2).join(' ');
}

/**
 * 多注 → 每注一行
 * @param {number[][]} tickets
 * @returns {string}
 */
export function formatTickets(tickets) {
  return (tickets || []).map((t) => formatNumberLine(t)).join('\n');
}

/** 每日 5 注（7 码复式，每注一行） */
export function formatFiveTickets(five) {
  return formatTickets((five || []).map((e) => e.numbers));
}

/** 单注 7 码 */
export function formatSingleTicket(numbers) {
  return formatNumberLine(numbers);
}
