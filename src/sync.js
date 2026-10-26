/**
 * 数据同步：本地开奖 与 数据源 的差异比对
 *
 * 设计原则（与参考站 https://whitworthbassalips894-crypto.github.io/lottery-tool/ 一致）：
 *  1. 「一键同步」只把**连续缺失**的期号追加写入本机 localStorage，绝不改动页面内置历史数组；
 *  2. 遇到期号缺口或同一期号号码冲突时，明确报告，不写入任何异常数据；
 *  3. 本模块只做纯计算（不碰 DOM / localStorage），便于单元测试。
 */

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
