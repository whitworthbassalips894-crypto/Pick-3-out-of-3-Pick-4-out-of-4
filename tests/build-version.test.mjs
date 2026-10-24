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
