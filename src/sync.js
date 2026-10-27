/**
 * 数据同步：本地开奖 与 数据源 的差异比对
 *
 * 设计原则（与参考站 https://whitworthbassalips894-crypto.github.io/lottery-tool/ 一致）：
 *  1. 「一键同步」只把**连续缺失**的期号追加写入本机 localStorage，绝不改动页面内置历史数组；
 *  2. 遇到期号缺口或同一期号号码冲突时，明确报告，不写入任何异常数据；
 *  3. 本模块只做纯计算（不碰 DOM / localStorage），便于单元测试。
 */

import { parseIsoDate } from './periods.js';

/** 每年期号上限（用于跨年递推：第 366 期之后归入下一年第 1 期） */
export const MAX_PERIODS_PER_YEAR = 366;

/** 单次同步最多写入的期数（避免 localStorage 被一次性写爆） */
export const MAX_APPEND_PER_SYNC = 600;

/**
 * 下一个期号（跨年自动进位）
 * @param {number} year
 * @param {number} periodNum
 * @returns {{year: number, periodNum: number}}
 */
export function nextPeriodMeta(year, periodNum) {
  const y = Number(year);
  const p = Number(periodNum);
  if (!Number.isInteger(y) || !Number.isInteger(p)) return { year: y, periodNum: p };
  return p >= MAX_PERIODS_PER_YEAR
    ? { year: y + 1, periodNum: 1 }
    : { year: y, periodNum: p + 1 };
}

/**
 * 规范期号字符串（2026-298）
 * @param {number} year
 * @param {number} periodNum
 * @returns {string}
 */
export function periodId(year, periodNum) {
  return `${year}-${String(periodNum).padStart(3, '0')}`;
}

/** 记录内容指纹（用于判断同一期号是否内容冲突） */
function signature(d) {
  return `${d.date || ''}|${(d.numbers || []).join(',')}|${d.special ?? ''}`;
}

/**
 * 比对「本地开奖」与「数据源开奖」
 *
 * @param {object[]} localDraws 本地已有（内置底库 + 本机录入）
 * @param {object[]} remoteDraws 数据源（仓库 JSON）
 * @returns {{
 *   localCount: number, remoteCount: number,
 *   localLatest: object|null, remoteLatest: object|null,
 *   appendable: object[], conflicts: object[], gaps: object[],
 *   missingCount: number, conflictCount: number, gapCount: number,
 *   truncated: boolean
 * }}
 */
export function compareDrawSets(localDraws = [], remoteDraws = []) {
  const sortAsc = (a, b) => (a.year - b.year) || (a.periodNum - b.periodNum);
  const local = [...(localDraws || [])].filter(Boolean).sort(sortAsc);
  const remote = [...(remoteDraws || [])].filter(Boolean).sort(sortAsc);

  const localMap = new Map(local.map((d) => [d.id, d]));
  const remoteMap = new Map(remote.map((d) => [d.id, d]));

  // —— 冲突：同一期号但开奖内容不同 ——
  const conflicts = [];
  for (const [id, r] of remoteMap) {
    const l = localMap.get(id);
    if (l && signature(l) !== signature(r)) {
      conflicts.push({ id, local: l, remote: r, reason: '同一期号的号码与本地不一致' });
    }
  }

  // —— 可追加：从「本地最后一期」的下一期起，连续存在的期号 ——
  const localLatest = local.length ? local[local.length - 1] : null;
  const remoteLatest = remote.length ? remote[remote.length - 1] : null;

  let expect = localLatest
    ? nextPeriodMeta(localLatest.year, localLatest.periodNum)
    : (remote.length ? { year: remote[0].year, periodNum: remote[0].periodNum } : null);

  const appendable = [];
  const gaps = [];
  let truncated = false;

  if (expect) {
    for (const r of remote) {
      const older = r.year < expect.year || (r.year === expect.year && r.periodNum < expect.periodNum);
      if (older) continue; // 本地已有或更早，跳过
      if (r.year === expect.year && r.periodNum === expect.periodNum) {
        if (!localMap.has(r.id)) {
          if (appendable.length < MAX_APPEND_PER_SYNC) appendable.push(r);
          else truncated = true;
        }
        expect = nextPeriodMeta(expect.year, expect.periodNum);
      } else {
        // 期号缺口：数据源在这一期缺失，后面的一律先不写入
        gaps.push({ expected: periodId(expect.year, expect.periodNum), found: r.id });
        break;
      }
    }
  }

  return {
    localCount: local.length,
    remoteCount: remote.length,
    localLatest,
    remoteLatest,
    appendable,
    conflicts,
    gaps,
    missingCount: appendable.length,
    conflictCount: conflicts.length,
    gapCount: gaps.length,
    truncated
  };
}

/**
 * 把比对结果汇总成一句人话（用于页面状态栏）
 * @param {ReturnType<typeof compareDrawSets>} r
 * @returns {string}
 */
export function formatSyncSummary(r) {
  if (!r) return '';
  const parts = [];
  if (r.missingCount > 0) {
    const ids = r.appendable.map((d) => d.id);
    const range = ids.length <= 3
      ? ids.join('、')
      : `${ids[0]} ~ ${ids[ids.length - 1]}`;
    parts.push(`可追加 ${r.missingCount} 期（${range}）`);
  } else {
    parts.push('没有可追加的期次');
  }
  if (r.conflictCount > 0) {
    parts.push(`冲突 ${r.conflictCount} 期（${r.conflicts.map((c) => c.id).join('、')}）`);
  }
  if (r.gapCount > 0) {
    parts.push(`期号缺口 ${r.gaps.map((g) => g.expected).join('、')}`);
  }
  if (r.truncated) {
    parts.push(`（单次最多写入 ${MAX_APPEND_PER_SYNC} 期，可多次同步）`);
  }
  return parts.join('；');
}

/* ------------------------------------------------------------------ 新鲜度 */

/**
 * 日期是一年中的第几天（期号约定：当年第几天 = 第几期）
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {number|null}
 */
export function dayOfYear(dateStr) {
  const dt = parseIsoDate(dateStr);
  if (!dt) return null;
  const startOfYear = Date.UTC(dt.getUTCFullYear(), 0, 1);
  return Math.floor((dt.getTime() - startOfYear) / 86400000) + 1;
}

/**
 * 把「年 + 期号」折算成一个连续的天序号，方便跨年比较
 * @param {number} year
 * @param {number} periodNum
 * @returns {number|null}
 */
export function drawOrdinal(year, periodNum) {
  const y = Number(year);
  const p = Number(periodNum);
  if (!Number.isInteger(y) || !Number.isInteger(p) || p < 1) return null;
  return Date.UTC(y, 0, 1) / 86400000 + p - 1;
}

/**
 * 底库新鲜度：本机最新一期 与「今天应有的那一期」差了多少
 *
 * 页面上的「一键同步」读的是仓库里的静态 data/draws.json，
 * 它只会被 GitHub Actions 的定时任务更新。所以「同步不到新数据」时，
 * 需要明确告诉用户：是**本机**落后，还是**仓库文件本身**落后。
 *
 * @param {{ year?: number, periodNum?: number, date?: string, id?: string } | null} localLatest
 * @param {string} todayIso 今天的日期 'YYYY-MM-DD'
 * @param {{ graceDays?: number }} [options] graceDays：允许「今天这期还没开奖」的容差，默认 1 天
 * @returns {{
 *   ok: boolean, stale: boolean, lagPeriods: number, lagDays: number,
 *   expectedId: string, expectedDate: string, localId: string,
 *   message: string, base: string, hint: string
 * }}
 */
export function describeSourceLag(localLatest, todayIso, options = {}) {
  const graceDays = Number.isInteger(options.graceDays) ? options.graceDays : 1;
  const today = parseIsoDate(todayIso) ? todayIso : null;
  if (!today) {
    return {
      ok: false, stale: false, lagPeriods: 0, lagDays: 0,
      expectedId: '', expectedDate: '', localId: localLatest?.id || '',
      message: '日期无效，无法判断底库新鲜度'
    };
  }

  const todayYear = Number(today.slice(0, 4));
  const expectedPeriod = dayOfYear(today);
  const expectedId = periodId(todayYear, expectedPeriod);

  const localOrdinal = drawOrdinal(localLatest?.year, localLatest?.periodNum);
  if (localOrdinal == null) {
    return {
      ok: false, stale: false, lagPeriods: 0, lagDays: 0,
      expectedId, expectedDate: today, localId: '',
      message: `本机还没有开奖数据；今天应到 ${expectedId}（${today}）`
    };
  }

  const expectedOrdinal = drawOrdinal(todayYear, expectedPeriod);
  const lagPeriods = Math.max(0, expectedOrdinal - localOrdinal);
  const lagDays = lagPeriods;
  const stale = lagPeriods > graceDays;
  const localId = localLatest?.id || periodId(localLatest?.year, localLatest?.periodNum);
  const localDate = localLatest?.date ? `（${localLatest.date}）` : '';

  const base = lagPeriods === 0
    ? `底库已是最新：${localId} 就是今天（${today}）的这一期`
    : `底库最新 ${localId}${localDate}，今天应到 ${expectedId}（${today}）→ 落后 ${lagPeriods} 期`;

  // hint 单独给出，调用方可以按场景决定要不要跟别的话拼在一起（避免重复）
  const hint = lagPeriods === 0
    ? ''
    : stale
      ? '仓库文件 data/draws.json 靠 GitHub Actions 每日自动抓取更新，请确认 Actions 里的 sync-draws 是否运行成功'
      : '今天的开奖可能还没公布';

  return {
    ok: true,
    stale,
    lagPeriods,
    lagDays,
    expectedId,
    expectedDate: today,
    localId,
    message: hint ? `${base}；${hint}` : base,
    base,
    hint
  };
}
