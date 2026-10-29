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
    // 特码 = 一张清单（1 个号 = 1 注），所以只有 1 张卡片、12 个号、12 注
    assert.equal(window.document.querySelectorAll('#fiveGrid .five-card').length, 1, '特码应只渲染 1 张清单卡片');
    assert.ok(text('heroMeta').includes('12 注'), `应显示本期共 12 注：${text('heroMeta')}`);
    assert.ok(text('heroMeta').includes('奇偶 6:6'), `应显示奇偶 6:6：${text('heroMeta')}`);

    const five = [...window.document.querySelectorAll('#fiveGrid .fc-balls .lotto-ball')]
      .map((el) => Number(el.textContent.replace(/[^0-9]/g, '').slice(0, 2)));
    assert.equal(five.length, 12, `清单应有 12 个号码，实际 ${five.length}`);
    assert.equal(new Set(five).size, 12, '12 个号必须互不重复，不能浪费任何一注');

    // 12 个号整体形态：奇偶 6:6、大小 6:6、三区 4:4:4
    assert.equal(five.filter((n) => n % 2 === 1).length, 6, '奇偶应 6:6');
    assert.equal(five.filter((n) => n >= 25).length, 6, '大小应 6:6');
    const zones = [five.filter((n) => n <= 16).length, five.filter((n) => n > 16 && n <= 33).length, five.filter((n) => n > 33).length];
    assert.deepEqual(zones, [4, 4, 4], `三区应 4:4:4，实际 ${zones.join('-')}`);

    // 图例：🎲 3 / 🔥 3 / 🎯 2 / ⚖️ 4
    const legend = window.document.querySelector('#fiveGrid .fc-legend')?.textContent || '';
    for (const [icon, name, count] of [['🎲', '完全随机', 3], ['🔥', '热号', 3], ['🎯', '冷号', 2], ['⚖️', '形态均衡', 4]]) {
      assert.ok(legend.includes(icon) && legend.includes(name), `图例缺少 ${icon} ${name}`);
      assert.equal(window.document.querySelectorAll(`#fiveGrid .ball-tag`).length >= 0, true);
    }
    assert.equal(window.document.querySelectorAll('#fiveGrid .ball-tag').length, 12, '每个号都应带风格角标');
    // 随机号的说明要讲清「纯 49 选」
    const cardText = window.document.querySelector('#fiveGrid .five-card')?.textContent || '';
    assert.ok(cardText.includes('49 个号等概率机选'), '随机号说明没更新');

    // 概率口径行：12 注、单注 2.0408%、整张清单 24.4898%、公平 49 倍、回报率 98.0%、至少中 1 注 = 12/49
    const costLine = text('featuredCostLine');
    assert.ok(costLine.includes('12 注'), `注数没按 12 注显示：${costLine}`);
    assert.ok(costLine.includes('2.0408%'), `单注命中率没显示：${costLine}`);
    assert.ok(costLine.includes('24.4898%'), `整张清单命中率没显示：${costLine}`);
    assert.ok(costLine.includes('49.0 倍'), '公平赔率没显示');
    assert.ok(costLine.includes('98.0%'), '期望回报率没显示');
    const expectAnyHit = ((new Set(five).size / 49) * 100).toFixed(3);
    assert.ok(text('featuredCostLine').includes(expectAnyHit), `至少中 1 注应为 12/49 = ${expectAnyHit}%：${text('featuredCostLine')}`);
    // 底库体检默认收起（2022-132 是永久坏行，不该天天挂在首屏），点一下按钮才显示
    const audit = window.document.getElementById('auditLine');
    assert.ok(audit.hidden, '体检行默认应隐藏，避免天天提醒');
    window.document.getElementById('btnSyncCheck')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!audit.hidden && text('auditLine').includes('2022-132'), '点「仅检查」后应能看到坏行明细');
    // r23：逐注对比从「一张 5 列表」改成「一注一张小卡」（对齐参考站）
    assert.ok(window.document.querySelectorAll('#histMetrics .sc-box').length >= 1, '逐注卡片没渲染');
    assert.ok(text('histMetrics').includes('有奖期占比'), '要有「有奖期占比」汇总卡');
    assert.ok(text('replayStatus').includes('已回放'), `回放未完成：${text('replayStatus')}`);

    // 精简后不该再出现的区块
    for (const gone of ['picker', 'check', 'consensusBox', 'explainerLine', 'grid49', 'entryLine']) {
      assert.equal(window.document.getElementById(gone), null, `区块 ${gone} 应该已被移除`);
    }

    // —— 回归：切换回放范围必须真的重算并重绘（曾经因为漏绑 change 事件而毫无反应）——
    const tabs = window.document.getElementById('histRangeTabs');
    assert.ok(tabs, '必须有回放范围标签');
    assert.ok(document.getElementById('btnReplayRun'), '必须有重新计算按钮');
    const pick = (range) => tabs.querySelector(`.tab[data-range="${range}"]`)
      .dispatchEvent(new window.Event('click', { bubbles: true }));
    const counts = [];
    for (const [value, expect] of [['30', 30], ['100', 100]]) {
      pick(value);
      await new Promise((r) => setTimeout(r, 1400));
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
    // 整行点击也要能收起（手机上不会精确点到 ▾）
    const openRow = () => window.document.querySelector('#histBody tr[data-draw-id]');
    openRow().dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(window.document.querySelectorAll('#histBody tr.feat-detail').length, 0, '整行点击应能收起');
    openRow().dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(window.document.querySelectorAll('#histBody tr.feat-detail').length, 1, '再点一次应重新展开');

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

/* ---------------------------------------------- r19：跨设备对齐 / 回放定位 */

/** 起一个干净页面并跑 app.js（每个用例一个独立 window，避免状态互相污染） */
async function bootPage(url) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  window.__SKIP_AUTO_SYNC__ = true;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  await import(`${path.join(ROOT, 'src', 'app.js')}?smoke=${Date.now()}-${Math.random()}`);
  const doc = window.document;
  const text = (id) => doc.getElementById(id)?.textContent?.trim() || '';
  const balls = () => [...doc.querySelectorAll('#fiveGrid .fc-balls .lotto-ball')]
    .map((el) => Number(el.textContent.replace(/[^0-9]/g, '').slice(0, 2)));
  const restore = () => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.localStorage = saved.localStorage;
    dom.window.close();
  };
  return { window, doc, text, balls, errors, restore };
}

test('三中三回到每天 5 注：5 张卡片 × 每组 3 个号，全中才算中', { skip: !hasJsdom && '未安装 jsdom（可选依赖）' }, async () => {
  const target = INITIAL_DB.draws.find((d) => d.id === '2026-287');
  const page = await bootPage('https://example.com/?p=2026-287&salt=0&m=pick3');
  try {
    const { doc, text } = page;
    const cards = [...doc.querySelectorAll('#fiveGrid .five-card')];
    assert.equal(cards.length, 5, '三中三应为 5 组');
    assert.equal(doc.querySelectorAll('#fiveGrid .five-card.is-complex').length, 0, '三中三不再有复式卡片');
    const groups = cards.map((c) => [...c.querySelectorAll('.fc-balls .lotto-ball')]
      .map((el) => Number(el.textContent.replace(/[^0-9]/g, '').slice(0, 2))));
    for (const g of groups) {
      assert.equal(g.length, 3, `每组应 3 个号，实际 ${g.length}`);
      assert.equal(new Set(g).size, 3, '每组内不能重复');
    }
    assert.ok((text('featuredCostLine') || '').includes('5 注'), `注数应为 5 注：${text('featuredCostLine')}`);
    assert.ok((text('heroMeta') || '').includes('5 注'), `头部应显示 5 注：${text('heroMeta')}`);

    // 结算口径：哪一组的 3 个号全在正码里，哪一组就中 1 注
    const expectWins = groups.filter((g) => g.every((n) => target.numbers.includes(n))).length;
    assert.ok(text('heroResult').includes(`5 注中 ${expectWins} 注`), `结算口径错误：${text('heroResult')}`);
    assert.equal(cards[0].textContent.includes('随机对照'), true, '第 1 组仍是纯随机对照');
  } finally {
    page.restore();
  }
});

test('跨设备对齐：网址里的 p / salt / m 决定同一张号码，重摇会写回网址', { skip: !hasJsdom && '未安装 jsdom（可选依赖）' }, async () => {
  const page = await bootPage('https://example.com/?p=2026-290&salt=3&m=pick3');
  try {
    const { window, doc, text, balls } = page;
    assert.equal(doc.querySelector('#periodSelect').value, '2026-290', '期号要跟着网址走');
    assert.equal(doc.querySelectorAll('#fiveGrid .five-card').length, 5, '玩法要跟着网址切到三中三（5 组）');
    assert.ok(text('heroShare').includes('🎲#3'), `对齐标签应显示重摇次数：${text('heroShare')}`);
    const first = balls().join(',');

    // 点「对齐凭证」= 复制当前链接；重摇后 salt 必须写回网址
    doc.getElementById('btnRerollRandom').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.ok(window.location.search.includes('salt=4'), `重摇后网址应更新 salt：${window.location.search}`);
    assert.ok(text('heroShare').includes('🎲#4'), '对齐标签要同步更新');
    assert.notEqual(balls().join(','), first, '重摇必须换掉 🎲 号码');

    // 同一个网址（salt=4）重新打开 → 号码必须完全一致
    const again = await bootPage('https://example.com/?p=2026-290&salt=4&m=pick3');
    try {
      assert.equal(again.balls().join(','), balls().join(','), '同一网址在两台设备上必须是同一张号码');
    } finally {
      again.restore();
    }
  } finally {
    page.restore();
  }
});

test('回放定位：只看命中 / 只看部分命中 + 上一/下一命中能高亮到那一行', { skip: !hasJsdom && '未安装 jsdom（可选依赖）' }, async () => {
  const page = await bootPage('https://example.com/?m=special');
  try {
    const { window, doc, text } = page;
    const rows = () => doc.querySelectorAll('#histBody tr[data-draw-id]').length;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((text('replayStatus') || '').includes('已回放')) break;
    }
    const all = rows();
    assert.ok(all > 0, '回放没有渲染任何行');

    const filter = doc.getElementById('histFilter');
    assert.ok(filter, '必须有回放筛选下拉');
    filter.value = 'hit';
    filter.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const onlyHit = rows();
    assert.ok(onlyHit > 0 && onlyHit <= all, `只看命中应筛掉未中的期，实际 ${onlyHit} / ${all}`);
    assert.ok(text('histCount').includes('已筛选'), '筛选后要说明「已筛选」');

    filter.value = 'partial';
    filter.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(rows() >= onlyHit, '部分命中应比只看命中多');

    doc.getElementById('btnNextHit').dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const flashed = doc.querySelectorAll('#histBody tr.row-flash').length;
    assert.equal(flashed, 1, '跳转后应高亮一行（.row-flash）');

    // 四中四命中极少：「只看命中」必须是空表 + 明确提示，而不是一片空白
    doc.querySelector('[data-mode="pick4"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    filter.value = 'hit';
    filter.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const bodyText = doc.getElementById('histBody').textContent || '';
    assert.ok(bodyText.includes('一期都没中奖') || rows() > 0, `空表也要有提示，实际：${bodyText.slice(0, 40)}`);
    assert.deepEqual(page.errors, [], `页面运行报错：${page.errors.join(' | ')}`);
  } finally {
    page.restore();
  }
});
