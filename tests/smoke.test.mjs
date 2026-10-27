/**
 * 页面冒烟测试（可选依赖 jsdom）
 *
 * 目的：单元测试能保证算法正确，但保不住「页面渲染时不报错」。
 * 这里用 jsdom 真正把 index.html + src/app.js 跑一遍，检查关键区域是否渲染出内容。
 *
 * 说明：仓库没有 npm 依赖，CI 里没有 jsdom 时本文件会自动跳过（不会让测试红）。
 * 本地想看效果：`npm i --no-save jsdom && node --test tests/smoke.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 页面默认展示「下一期」，期号跟着底库走（自动同步会不断追加新的一期）
const { default: INITIAL_DB } = await import('../data/draws.js');
const { nextPeriodMeta } = await import('../src/periods.js');
const EXPECTED_NEXT = nextPeriodMeta(INITIAL_DB.draws[0]);

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const hasJsdom = !!JSDOM;

test('页面冒烟：index.html + app.js 能在 DOM 里跑起来并渲染出关键区块', { skip: !hasJsdom && '未安装 jsdom（可选依赖）' }, async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const dom = new JSDOM(html, { url: 'https://example.com/', pretendToBeVisual: true });
  const { window } = dom;

  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  const origError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };

  try {
    await import(`${path.join(ROOT, 'src', 'app.js')}?smoke=${Date.now()}`);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    // 等回放（分批 + 让出主线程）跑完
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((window.document.getElementById('replayStatus')?.textContent || '').includes('已回放')) break;
    }

    const text = (id) => window.document.getElementById(id)?.textContent?.trim() || '';
    assert.ok(
      text('heroPeriod').includes(`第${EXPECTED_NEXT.period}期`),
      `头部期号异常：${text('heroPeriod')}（底库最新 ${INITIAL_DB.draws[0].id}，应展示下一期 ${EXPECTED_NEXT.period}）`
    );
    assert.equal(window.document.querySelectorAll('#fiveGrid .five-card').length, 5, '5 注卡片没渲染出来');
    assert.ok(text('heroMeta').includes('覆盖'), '应显示 5 组覆盖的号码数');
    assert.ok(text('heroMeta').includes('15 注'), '应显示本期共 15 注');

    // 特码是 1 中 1：每组 3 个号 = 3 注，5 组共 15 个号；随机组允许与精选重复，并集 ≤ 15
    const five = [...window.document.querySelectorAll('#fiveGrid .fc-balls .lotto-ball')]
      .map((el) => Number(el.textContent.replace(/[^0-9]/g, '')));
    assert.equal(five.length, 15, `应有 15 个号码，实际 ${five.length}`);
    assert.ok(new Set(five).size <= 15 && new Set(five).size >= 12, `并集号码数异常：${new Set(five).size}`);

    // 精选四组（#2~#5）之间必须互不重复 → 12 个号
    const picked = [...window.document.querySelectorAll('#fiveGrid .five-card:not(.is-random) .fc-balls .lotto-ball')]
      .map((el) => Number(el.textContent.replace(/[^0-9]/g, '')));
    assert.equal(picked.length, 12, `精选应有 12 个号码，实际 ${picked.length}`);
    assert.equal(new Set(picked).size, 12, '精选四组之间不能重复用号');

    // 随机注说明要讲清「纯 49 选、允许重复」
    const randomCard = window.document.querySelector('#fiveGrid .five-card.is-random');
    assert.ok(randomCard.textContent.includes('49 个号等概率机选'), '随机注说明没更新');

    // 概率口径行：15 注、单注 2.0408%、每组 6.1224%、公平 49 倍、回报率 98.0%、至少中 1 注 = 并集/49
    const costLine = text('featuredCostLine');
    assert.ok(costLine.includes('15 注'), `注数没按 15 注显示：${costLine}`);
    assert.ok(costLine.includes('2.0408%'), `单注命中率没显示：${costLine}`);
    assert.ok(costLine.includes('6.1224%'), `每组命中率没显示：${costLine}`);
    assert.ok(costLine.includes('49.0 倍'), '公平赔率没显示');
    assert.ok(costLine.includes('98.0%'), '期望回报率没显示');
    const distinct = new Set(five).size;
    const expectAnyHit = ((distinct / 49) * 100).toFixed(3);
    assert.ok(text('featuredCostLine').includes(expectAnyHit), `至少中 1 注应为并集/49 = ${expectAnyHit}%：${text('featuredCostLine')}`);
    assert.ok(text('auditLine').includes('2022-132'), '底库体检没列出坏行');
    assert.equal(window.document.querySelectorAll('#histMetrics .mc-table thead th').length, 5, '逐注对比表应有 5 列');
    assert.ok(text('replayStatus').includes('已回放'), `回放未完成：${text('replayStatus')}`);

    // 精简后不该再出现的区块
    for (const gone of ['picker', 'check', 'consensusBox', 'explainerLine', 'grid49', 'entryLine']) {
      assert.equal(window.document.getElementById(gone), null, `区块 ${gone} 应该已被移除`);
    }

    // —— 回归：切换回放范围必须真的重算并重绘（曾经因为漏绑 change 事件而毫无反应）——
    const sel = window.document.getElementById('histRange');
    assert.ok(sel, '必须有回放范围下拉');
    assert.ok(document.getElementById('btnReplayRun'), '必须有重新计算按钮');
    const counts = [];
    for (const [value, expect] of [['30', 30], ['60', 60]]) {
      sel.value = value;
      sel.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const countText = text('histCount');
      assert.ok(countText.includes(`共 ${expect} 期`), `范围 ${value} 后统计应变成 ${expect} 期，实际：${countText}`);
      counts.push(window.document.querySelectorAll('#histBody tr[data-draw-id]').length);
    }
    assert.ok(counts[0] !== counts[1] || counts[0] === 30, '切换范围后表格行数应随之变化');

    // —— 回归：展开详情不能依赖 globalThis.CSS（老 WebView 里没有，具体见 build-version 的静态检查）——
    window.document.querySelector('#histBody [data-feat-toggle]')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(window.document.querySelectorAll('#histBody tr.feat-detail').length, 1, '详情行没渲染出来');

    // —— 回归：重摇随机注后，回放里的 #1 也要跟着变 ——
    const detailText = () => window.document.querySelector('#histBody tr.feat-detail')?.textContent || '';
    const beforeReroll = detailText();
    window.document.getElementById('btnRerollRandom')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    assert.notEqual(detailText(), beforeReroll, '重摇后回放里的随机注没有更新');
    assert.ok(text('replayStatus').includes('已回放'), `重摇后回放未完成：${text('replayStatus')}`);

    assert.deepEqual(errors, [], `页面运行报错：${errors.slice(0, 3).join(' | ')}`);
  } finally {
    console.error = origError;
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    dom.window.close();
  }
});
