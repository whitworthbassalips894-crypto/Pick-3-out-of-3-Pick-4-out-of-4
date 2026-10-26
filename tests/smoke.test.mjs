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
    assert.ok(text('heroPeriod').includes('第299期'), `头部期号异常：${text('heroPeriod')}`);
    assert.equal(window.document.querySelectorAll('#fiveGrid .five-card').length, 5, '5 注卡片没渲染出来');
    assert.ok(text('heroMeta').includes('覆盖'), '应显示 5 注覆盖的号码数');

    // 5 注互不重叠：25 个不同号码（特码默认玩法，每注 5 个）
    const five = [...window.document.querySelectorAll('#fiveGrid .fc-balls .lotto-ball')]
      .map((el) => Number(el.textContent.replace(/[^0-9]/g, '')));
    assert.equal(five.length, 25, `应有 25 个号码，实际 ${five.length}`);
    assert.equal(new Set(five).size, 25, '5 注之间不能重复用号');

    // 概率口径行：至少中 1 注 51.02%（特码 25/49）
    assert.ok(text('featuredCostLine').includes('51.020%'), `覆盖概率没显示：${text('featuredCostLine')}`);
    assert.ok(text('auditLine').includes('2022-132'), '底库体检没列出坏行');
    assert.equal(window.document.querySelectorAll('#histMetrics .mc-table thead th').length, 5, '逐注对比表应有 5 列');
    assert.ok(text('replayStatus').includes('已回放'), `回放未完成：${text('replayStatus')}`);

    // 精简后不该再出现的区块
    for (const gone of ['picker', 'check', 'consensusBox', 'explainerLine', 'grid49', 'entryLine']) {
      assert.equal(window.document.getElementById(gone), null, `区块 ${gone} 应该已被移除`);
    }
    assert.deepEqual(errors, [], `页面运行报错：${errors.slice(0, 3).join(' | ')}`);
  } finally {
    console.error = origError;
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    dom.window.close();
  }
});
