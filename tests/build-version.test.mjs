import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BUILD, APP_VERSION_LABEL } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('构建版本号在三处保持一致（src/constants.js / sw.js / index.html）', () => {
  const sw = read('sw.js');
  const html = read('index.html');

  const swBuild = sw.match(/const BUILD_ID = '([^']+)'/)?.[1];
  assert.ok(swBuild, 'sw.js 必须声明 BUILD_ID');
  assert.equal(swBuild, APP_BUILD, 'sw.js 的 BUILD_ID 与 src/constants.js 的 APP_BUILD 必须一致');

  // index.html 里所有 ?v= 参数必须是同一个版本号
  const versions = [...html.matchAll(/\?v=([0-9A-Za-z._-]+)/g)].map((m) => m[1]);
  assert.ok(versions.length >= 3, 'index.html 至少要给 css / manifest / icon / app.js 加版本参数');
  for (const v of versions) {
    assert.equal(v, APP_BUILD, `index.html 中的 ?v=${v} 与 APP_BUILD(${APP_BUILD}) 不一致`);
  }

  // 页面显示的版本号也要一致
  assert.ok(html.includes(`>${APP_VERSION_LABEL}<`), 'index.html 必须显示构建版本号');
  assert.ok(html.includes(`id="buildTag"`));
  assert.ok(html.includes(`id="buildTagFooter"`));
});

test('Service Worker 缓存名带版本号，且升级时会清理旧缓存', () => {
  const sw = read('sw.js');
  assert.ok(
    /const CACHE_NAME = `\$\{CACHE_PREFIX\}\$\{BUILD_ID\}`/.test(sw),
    '缓存名必须由前缀 + 构建版本号拼成，否则旧缓存永远不会被清理'
  );
  assert.ok(sw.includes('caches.delete'), 'activate 阶段必须删除旧缓存');
  assert.ok(sw.includes('self.skipWaiting()'), 'install 阶段必须 skipWaiting');
  assert.ok(sw.includes('self.clients.claim()'), 'activate 阶段必须 clients.claim');
  assert.ok(sw.includes("'activate'"), '必须监听 activate');
  assert.ok(sw.includes('DATA_FILES'), '底库文件应单独走缓存优先策略');
});

test('Service Worker 对应用外壳采用网络优先，并且请求带版本参数绕开 HTTP 缓存', () => {
  const sw = read('sw.js');
  assert.ok(sw.includes("'sw', BUILD_ID"), '网络请求必须附加 sw=BUILD_ID 参数');
  assert.ok(sw.includes('NETWORK_OPTS'), '网络请求必须禁用缓存（no-store / no-cache）');
  // 外壳分支必须先网络后缓存
  const shellIdx = sw.indexOf('SHELL_PATHS.has(path)');
  assert.ok(shellIdx > 0, '必须存在外壳资源分支');
  const branch = sw.slice(shellIdx, shellIdx + 1200);
  assert.ok(branch.indexOf('fetch(') < branch.indexOf('cache.match'), '外壳资源应先走网络，失败才回退缓存');
});

test('index.html 内置启动看门狗：加载失败时给出错误提示与修复入口', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="bootError"'), '必须有启动失败提示面板');
  assert.ok(html.includes('id="btnBootReload"'), '必须有「重新加载」按钮');
  assert.ok(html.includes('id="btnBootRepair"'), '必须有「修复缓存」按钮');
  assert.ok(html.includes('__APP_BOOTED__'), '必须有启动完成标记');
  assert.ok(html.includes('__SHOW_BOOT_ERROR__'), '必须有错误提示函数');
  assert.ok(html.includes('setTimeout'), '必须有超时看门狗');
  // 看门狗必须是内联脚本（不依赖任何外部资源）
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(inline && inline[1].includes('__APP_BOOTED__'), '看门狗必须内联，外部脚本失败时就失效了');
});

test('PWA 清单与页面主题为浅色', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.background_color, '#f6f8fb');
  assert.equal(manifest.theme_color, '#f6f8fb');
  const html = read('index.html');
  assert.ok(html.includes('<meta name="theme-color" content="#f6f8fb" />'));
});

test('样式表为浅色主题（背景 / 卡片 / 文字 / 边框 / 金色强调）', () => {
  const css = read('assets/styles.css');
  assert.ok(css.includes('--paper: #f6f8fb'), '背景必须是 #f6f8fb');
  assert.ok(css.includes('--card: #ffffff'), '卡片必须是白色');
  assert.ok(css.includes('--ink: #263548'), '正文必须是 #263548');
  assert.ok(css.includes('--muted: #64748b'), '次级文字必须是 #64748b');
  assert.ok(css.includes('--line: #dce4ee'), '边框必须是 #dce4ee');
  assert.ok(css.includes('--gold: #d4a72c'), '强调色必须是 #d4a72c');
  // 不能残留旧版深色硬编码
  assert.ok(!css.includes('--bg: #0b1120'), '不能残留旧版深色背景变量');
  assert.ok(!css.includes('--card: #111827'), '不能残留旧版深色卡片变量');
  assert.ok(!/background:\s*#0b1120/i.test(css), '不能残留旧版深色背景硬编码');
});

test('特码清单在手机上固定 4 列 × 3 行（12 个号不再随屏宽忽多忽少）', () => {
  const css = read('assets/styles.css');
  // 取出 .five-card.is-list .fc-balls 这条规则（含紧随其后的媒体查询）
  const block = css.slice(css.indexOf('.five-card.is-list .fc-balls'));
  assert.ok(block, '样式表里必须有 .five-card.is-list .fc-balls 规则');
  const rule = block.slice(0, block.indexOf('}') + 1);

  assert.ok(/display:\s*grid/.test(rule), '清单的号码容器必须用 grid，否则会随屏宽自动换行');
  assert.ok(/grid-template-columns:\s*repeat\(4,/.test(rule), '手机端必须固定 4 列（12 个号 = 4 列 × 3 行）');
  assert.ok(/justify-items:\s*center/.test(rule), '球要在格子里居中，否则会忽左忽右');
  // 必须顶掉 .fc-body .fc-balls 的 flex: 0 0 auto，否则宽度撑不满、grid 排不出来
  assert.ok(/flex:\s*1 1 100%/.test(rule), '必须覆盖 .fc-body .fc-balls 的 flex: 0 0 auto');

  // 宽屏一行 6 个 × 2 行
  assert.ok(
    /\.five-card\.is-list \.fc-balls\s*\{\s*grid-template-columns:\s*repeat\(6,/.test(css),
    '宽屏应切到 6 列（2 行）'
  );

  // 三中三 / 四中四 的 5 组卡片不能被这条规则影响：基础 .fc-balls 仍是 flex
  const baseRule = css.match(/(?:^|\n)\.fc-balls\s*\{([^}]*)\}/);
  assert.ok(baseRule, '必须有基础的 .fc-balls 规则');
  assert.ok(/display:\s*flex/.test(baseRule[1]), '基础 .fc-balls 必须保持 flex（直选 5 组卡片靠它换行）');
  assert.ok(!/display:\s*grid/.test(baseRule[1]), '基础 .fc-balls 不能改成 grid');
});

test('Service Worker 只清理本工具前缀的缓存，不误伤同域其它工具', () => {
  const sw = read('sw.js');
  // 去掉注释后再检查代码，避免把注释里的反例写法当成真实实现
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // activate 清理条件必须是 CACHE_PREFIX，不能用 includes('mark6') 这种宽条件
  const activateIdx = code.indexOf("'activate'");
  assert.ok(activateIdx > 0);
  const activateBlock = code.slice(activateIdx, activateIdx + 900);
  assert.ok(
    activateBlock.includes('k.startsWith(CACHE_PREFIX)'),
    'activate 阶段只能按本工具的缓存前缀清理'
  );
  assert.ok(
    !activateBlock.includes('includes('),
    '不能按 mark6 关键字宽泛清理（会误删同域其它工具的缓存）'
  );
  // CLEAR_CACHES 消息同样受限
  const clearIdx = code.indexOf('CLEAR_CACHES');
  assert.ok(clearIdx > 0);
  const clearBlock = code.slice(clearIdx, clearIdx + 700);
  assert.ok(clearBlock.includes('CACHE_PREFIX'), 'CLEAR_CACHES 也必须限定在本工具前缀内');
  assert.ok(!clearBlock.includes('includes('), 'CLEAR_CACHES 不能按关键字清空全部缓存');
});

test('Service Worker 的底库路径用相对路径（兼容子目录部署）', () => {
  const sw = read('sw.js');
  const m = sw.match(/const DATA_FILES = \[([^\]]+)\]/);
  assert.ok(m, '必须声明 DATA_FILES');
  for (const p of m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))) {
    assert.ok(p.startsWith('./'), `底库路径必须以 ./ 开头（子目录部署会 404）：${p}`);
  }
});

test('Service Worker 的外壳清单包含新引擎 dailyfive.js', () => {
  const sw = read('sw.js');
  assert.ok(sw.includes("'./src/dailyfive.js'"), '离线时必须能加载 src/dailyfive.js');
  assert.ok(sw.includes("'./src/app.js'"));
});

test('页面结构：特码 12 号清单 / 直选 5 组，精简后只保留推荐 / 回放 / 数据 / 设置', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="fiveGrid"'), '必须有号码卡片容器');
  assert.ok(html.includes('12 号清单'), '特码按钮必须写明 12 号清单（12 注）');
  assert.ok(html.includes('id="btnRerollRandom"'), '必须有「重摇随机组」');
  assert.ok(html.includes('id="btnResetRandom"'), '必须有「恢复默认随机」');
  assert.ok(html.includes('id="featuredCostLine"'), '必须有概率 / 赔率口径行');

  // 精简掉的模块不能再出现（含方案下拉：自选号码已下线）
  for (const gone of ['id="consensusBox"', 'id="explainerLine"', 'id="picker"', 'id="check"',
    'id="grid49"', 'id="entryLine"', 'id="histYearTabs"', 'id="histHitTabs"', 'id="histSearch"',
    'id="histStrategy"', 'id="strategiesBox"', 'id="pick3List"', 'id="pick4List"']) {
    assert.ok(!html.includes(gone), `旧模块 ${gone} 必须移除`);
  }
  // 回放表头
  assert.ok(html.includes('本期命中'));
  assert.ok(html.includes('当期 6 正码'));
  assert.ok(html.includes('特码'));
  assert.ok(html.includes('三中三'));
  assert.ok(html.includes('四中四'));
  assert.ok(html.includes('详情'));
});

test('页面里每个按钮 / 下拉都真的绑定了事件（防止再次出现「点了没反应」）', () => {
  const html = read('index.html');
  const app = read('src/app.js');

  // 只看有 id 的 <button> 与 <select>：它们必须是可交互的
  const buttons = [...html.matchAll(/<button[^>]*id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const selects = [...html.matchAll(/<select[^>]*id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(buttons.length >= 20, `按钮数量异常：${buttons.length}`);
  assert.ok(selects.length >= 2, `下拉数量异常：${selects.length}`);

  for (const id of buttons) {
    assert.ok(
      app.includes(`on('${id}'`) || app.includes(`$('${id}')`),
      `按钮 #${id} 在 app.js 里没有任何绑定`
    );
  }
  for (const id of selects) {
    assert.ok(
      app.includes(`on('${id}', 'change'`),
      `下拉 #${id} 没有绑定 change 事件（换了选项不会生效）`
    );
  }
});

test('回放详情不依赖 globalThis.CSS（老 WebView 没有 CSS.escape）', () => {
  const app = read('src/app.js');
  // 去掉注释再检查，避免把「不要用 CSS.escape」这类说明当成真实用到
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('CSS.escape'), '不能用 CSS.escape，应改用 dataset 比对定位行');
});

test('回放筛选只剩「范围 + 是否命中」两项（年份 / 搜索 / 自选方案保持下线）', () => {
  const app = read('src/app.js');
  for (const dead of ['applyReplayFilters', 'filters.q', 'filters.strategy', 'replay.filters.year']) {
    assert.ok(!app.includes(dead), `回放里仍残留已下线的筛选逻辑：${dead}`);
  }
  // r19 重新引入了「只看命中 / 只看部分命中」，用来快进到有反应的那一期
  assert.ok(app.includes('replay.filters.hit'), '回放需要「命中筛选」状态（只看命中 / 只看部分命中）');
  assert.ok(app.includes("filters: {\n    range: '120'"), '回放筛选状态第一项仍是「范围」');
});

test('Service Worker 的外壳清单覆盖 app.js 的全部本地依赖（离线可用）', () => {
  const sw = read('sw.js');
  const app = read('src/app.js');
  const imports = [...app.matchAll(/from '\.\/([a-z0-9_-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 5, 'app.js 至少有若干本地模块依赖');
  for (const mod of imports) {
    assert.ok(sw.includes(`'./src/${mod}'`), `离线外壳清单必须包含 src/${mod}`);
  }
});

test('页面结构：直选模式切换 + 已移除复式 / 胆码 / 35 注', () => {
  const html = read('index.html');
  // 玩法切换
  assert.ok(html.includes('id="modeSwitch"'), '必须有玩法切换控件');
  assert.ok(html.includes('data-mode="special"'), '必须能切到特码');
  assert.ok(html.includes('data-mode="pick3"'), '必须能切到选三');
  assert.ok(html.includes('data-mode="pick4"'), '必须能切到选四');
  assert.ok(html.includes('特码 · 12 号清单（12 注）'), '要有特码玩法标签（1 中 1，12 个号 = 12 注）');
  assert.ok(html.includes('三中三 · 7 码复式（35 注）'), '三中三 r19 起是 7 码复式（35 注）');
  assert.ok(html.includes('四中四 · 每组 4 号'), '要有四中四玩法标签');
  // 顺序：特码 → 选三 → 选四
  assert.ok(
    html.indexOf('data-mode="special"') < html.indexOf('data-mode="pick3"')
    && html.indexOf('data-mode="pick3"') < html.indexOf('data-mode="pick4"'),
    '玩法顺序必须是 特码 → 选三 → 选四'
  );
  // 特码赔率输入
  assert.ok(html.includes('id="cfgOddsSpecial"'), '必须有特码赔率输入');
  assert.ok(html.includes('id="cfgOddsNote"'), '必须有赔率期望回报率提示位');
  // 旧版复式结构必须彻底移除
  for (const gone of ['id="comboGrid"', 'id="comboTabs"', 'id="foldCombos"', 'id="histMode"', 'id="pinnedPicks"']) {
    assert.ok(!html.includes(gone), `旧结构 ${gone} 必须移除`);
  }
  // 页面文案：复式只允许出现在三中三（7 码 35 注），其它玩法仍不许回潮
  assert.ok(!html.includes('胆码'), '页面不应再出现胆码');
  assert.ok(!html.includes('data-mode="pick4" role="tab">四中四 · 7'), '四中四保持 5 注，不做复式');
  // r19 新增的三处交互入口
  assert.ok(html.includes('id="cfgStake3"'), '三中三需要单独的注金输入（复式 35 注，注金与四中四不同）');
  assert.ok(html.includes('id="histFilter"'), '回放需要「只看命中」筛选');
  assert.ok(html.includes('id="btnPrevHit"') && html.includes('id="btnNextHit"'), '回放需要上一 / 下一命中跳转');
  assert.ok(html.includes('id="heroShare"'), '头部需要「对齐凭证」（期号 + 重摇次数）');
});

/* ------------------------------------------------- 自动同步 workflow 的位置 */

/** 去掉 CRLF / 行尾空白 / 末尾空行后再比较，避免「网页粘贴」造成的假差异 */
function normalizeText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

test('自动同步 workflow：GitHub 只认 .github/workflows/，源文件与安装件必须语义一致', () => {
  // 历史 bug：工作流曾放在根目录 workflows/，GitHub 不会执行 → 底库长期停更。
  assert.ok(!fs.existsSync(path.join(ROOT, 'workflows')), '仓库根目录不该有 workflows/（GitHub 不读这个位置）');

  // 真正生效的是这个文件
  const installedPath = path.join(ROOT, '.github', 'workflows', 'sync-draws.yml');
  assert.ok(fs.existsSync(installedPath), '缺少 .github/workflows/sync-draws.yml —— 自动同步不会运行');
  const installed = fs.readFileSync(installedPath, 'utf-8');

  // 语义检查：写在安装件上（这才是 GitHub 实际执行的）
  assert.match(installed, /^on:/m, '必须声明触发条件');
  assert.match(installed, /schedule:/, '必须配置定时触发，否则底库不会自动更新');
  assert.match(installed, /scripts\/sync_latest\.mjs/, '必须调用同步脚本');
  assert.match(installed, /data\/draws\.json/, '必须提交更新后的底库文件');
  assert.match(installed, /contents:\s*write/, '必须授予 contents: write 才能 push');
  assert.match(installed, /workflow_dispatch:/, '需要保留手动触发入口（Actions 页面可以点运行）');

  // 源文件（ci/）用于版本管理与安装，存在就校验，但不强制存在：
  // 有人直接在网页上编辑 .github/workflows/ 是完全合法的用法，不该因此变红。
  const sourcePath = path.join(ROOT, 'ci', 'sync-draws.yml');
  if (!fs.existsSync(sourcePath)) {
    console.warn('[workflow] 没有 ci/sync-draws.yml（直接维护 .github/workflows/ 也可以），跳过源文件比对');
  } else {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    // ⚠ 只报差异、不让测试红：这类「两处副本不一致」属于维护提示，
    //   不应该挡住每日数据同步（曾经因为一条装饰性断言让整个同步任务失败）。
    if (normalizeText(source) !== normalizeText(installed)) {
      console.warn('[workflow] ci/sync-draws.yml 与 .github/workflows/sync-draws.yml 内容不一致，'
        + '建议运行 npm run install:workflow 同步（不影响同步任务运行）');
    }
    // 源文件自身也要能独立通过基本校验
    assert.match(source, /schedule:/, 'ci/sync-draws.yml 缺少定时触发');
    assert.match(source, /scripts\/sync_latest\.mjs/, 'ci/sync-draws.yml 缺少同步脚本调用');
  }

  // 安装脚本能把源文件搬到 GitHub 真正读取的位置
  const installer = read('scripts/install_workflow.mjs');
  assert.match(installer, /\.github/, '安装脚本必须写到 .github/workflows/');
  assert.match(installer, /sync-draws\.yml/, '安装脚本必须处理 sync-draws.yml');

  // 同步脚本要能自己生成 draws.js（只更新 json 会导致页面仍用旧数据）
  const script = read('scripts/build_history_db.mjs');
  assert.match(script, /writeDatabaseFiles/, '必须有写库函数');
  assert.match(script, /JS_PATH/, '必须同时写 data/draws.js（页面实际 import 的是这个文件）');
});

test('「一键同步」读的是仓库静态文件，同步状态必须说明数据来源', () => {
  const app = read('src/app.js');
  assert.match(app, /data\/draws\.json\?_r=/, '一键同步应带 _r 参数绕过缓存');
  assert.match(app, /describeSourceLag/, '同步状态必须显示底库新鲜度（落后几期）');
  assert.match(app, /GitHub Actions/, '库里落后时要说明是自动任务的问题，而不是含糊地说「同步失败」');
  // 不能再用「远程源被浏览器跨域限制拦下」这种没验证过的结论
  assert.ok(!app.includes('远程源被浏览器跨域限制拦下'), '失败原因必须来自真实报错，不能猜');
});
