/**
 * 底库体检单测
 *
 * 现实背景：data/draws.js 里有一行坏数据（2022-132 期，正码里 33 出现了两次），
 * 修复前它会让同一个号在一次开奖里被记两次频率。这里锁住两件事：
 *   1. 体检必须能把它抓出来（不能静默放过）；
 *   2. 体检只报告、不猜测（坏行的缺失号码不会被补全）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import INITIAL_DB from '../data/draws.js';
import { auditDraws, formatAuditSummary, isUsableDraw, isValidNumber } from '../src/audit.js';

const ALL = INITIAL_DB.draws;

test('isValidNumber：只接受 1~49 的整数', () => {
  assert.equal(isValidNumber(1), true);
  assert.equal(isValidNumber(49), true);
  assert.equal(isValidNumber('7'), true);
  for (const bad of [0, 50, -1, 3.5, 'abc', null, undefined, NaN]) {
    assert.equal(isValidNumber(bad), false, `${String(bad)} 不该被当成合法号码`);
  }
});

test('isUsableDraw：正码必须 6 个互不重复，且特码不能与正码重叠', () => {
  assert.equal(isUsableDraw({ numbers: [1, 2, 3, 4, 5, 6], special: 7 }), true);
  // 重复号
  assert.equal(isUsableDraw({ numbers: [1, 2, 3, 4, 5, 5], special: 7 }), false);
  // 少一个号
  assert.equal(isUsableDraw({ numbers: [1, 2, 3, 4, 5], special: 7 }), false);
  // 越界
  assert.equal(isUsableDraw({ numbers: [1, 2, 3, 4, 5, 50], special: 7 }), false);
  // 特码与正码重叠
  assert.equal(isUsableDraw({ numbers: [1, 2, 3, 4, 5, 6], special: 6 }), false);
  // 特码缺失
  assert.equal(isUsableDraw({ numbers: [1, 2, 3, 4, 5, 6] }), false);
  assert.equal(isUsableDraw(null), false);
});

test('真实底库：体检能抓出那唯一一行坏数据，且其余期次可用', () => {
  const report = auditDraws(ALL);
  assert.equal(report.total, ALL.length);
  assert.equal(report.usable, ALL.length - 1, '坏行应当被判定为不可用于统计');
  assert.equal(report.byType['normal-duplicate'], 1);
  const bad = report.issues.find((i) => i.type === 'normal-duplicate');
  assert.equal(bad.id, '2022-132');
  assert.ok(bad.message.includes('33'));
  // 只有这一处问题（期号连续、日期连续、特码正常）
  assert.equal(report.issueCount, 1, `体检发现多余问题：${JSON.stringify(report.issues.slice(0, 5))}`);
});

test('体检摘要必须同时说明「可统计期数」和「不猜测补全」', () => {
  const report = auditDraws(ALL);
  const text = formatAuditSummary(report);
  // 不写死期数：底库每天由自动同步追加，摘要里的数字必须来自实际数据
  assert.ok(text.includes(String(report.total)), `应给出总期数 ${report.total}`);
  assert.ok(text.includes(String(report.usable)), `应给出可统计期数 ${report.usable}`);
  assert.equal(report.usable, report.total - 1, '只有 2022-132 这一行不可用');
  assert.ok(text.includes('2022-132'), '应指出具体坏行');
  assert.ok(text.includes('不会被猜测补全'));
});

test('体检：干净的底库返回 0 问题', () => {
  const clean = [
    { id: '2026-002', year: 2026, period: '002', periodNum: 2, date: '2026-01-02', numbers: [1, 2, 3, 4, 5, 6], special: 7 },
    { id: '2026-001', year: 2026, period: '001', periodNum: 1, date: '2026-01-01', numbers: [8, 9, 10, 11, 12, 13], special: 14 }
  ];
  const report = auditDraws(clean);
  assert.equal(report.issueCount, 0, JSON.stringify(report.issues));
  assert.equal(report.usable, 2);
  assert.ok(formatAuditSummary(report).includes('体检通过'));
});

test('体检：能识别期号重复、顺序错乱、日期断档、特码撞正码', () => {
  const messy = [
    { id: '2026-003', year: 2026, period: '003', periodNum: 3, date: '2026-01-05', numbers: [1, 2, 3, 4, 5, 6], special: 7 },
    { id: '2026-003', year: 2026, period: '003', periodNum: 3, date: '2026-01-05', numbers: [1, 2, 3, 4, 5, 6], special: 7 },
    { id: '2026-001', year: 2026, period: '001', periodNum: 1, date: '2026-01-01', numbers: [1, 2, 3, 4, 5, 6], special: 6 }
  ];
  const report = auditDraws(messy);
  const types = new Set(report.issues.map((i) => i.type));
  assert.ok(types.has('duplicate-id'), '应抓出期号重复');
  assert.ok(types.has('out-of-order'), '应抓出顺序错乱');
  assert.ok(types.has('date-gap'), '应抓出日期断档');
  assert.ok(types.has('period-gap'), '应抓出期号断档');
  assert.ok(types.has('special-in-normals'), '应抓出特码与正码重叠');
  // 单行「可用性」只看这一行的号码结构：两条特码正常的记录可用，特码撞正码那条不可用
  assert.equal(report.usable, 2);
});
