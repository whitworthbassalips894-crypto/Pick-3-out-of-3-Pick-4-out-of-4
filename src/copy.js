/**
 * 复制内容格式化（纯函数，便于单元测试）
 *
 * 规则（用户明确要求）：
 *  - 复制出来**只有号码**，每注一行；
 *  - 同一注的号码之间用顿号「、」分隔，例如 `05、06、07`；
 *  - 注与注之间用换行分隔，例如：
 *      05、06、07
 *      20、15、42
 *  - 不要任何汉字、标题、注号、日期、赔率等多余文字与数字。
 */

import { pad2 } from './constants.js';

/** 号码分隔符：顿号 */
export const NUMBER_SEPARATOR = '、';

/** 单注号码 → "05、06、07" */
export function formatNumberLine(nums) {
  return (nums || []).map(pad2).join(NUMBER_SEPARATOR);
}

/**
 * 多注 → 每注一行
 * @param {number[][]} tickets
 * @returns {string}
 */
export function formatTickets(tickets) {
  return (tickets || []).map((t) => formatNumberLine(t)).join('\n');
}

/** 每日 5 注（直选：每注 3 个号或 4 个号，每注一行） */
export function formatFiveTickets(five) {
  return formatTickets((five || []).map((e) => e.numbers));
}

/** 单注（直选 3 码 / 4 码） */
export function formatSingleTicket(numbers) {
  return formatNumberLine(numbers);
}
