#!/usr/bin/env node
/**
 * 把 ci/sync-draws.yml 安装到 .github/workflows/sync-draws.yml
 *
 * 背景：GitHub Actions **只**会读取 `.github/workflows/` 下的工作流文件。
 *   这个仓库的同步工作流长期放在根目录 `workflows/` 里，所以一次都没跑过，
 *   底库也就一直停更（页面的「一键同步」读的是静态 data/draws.json）。
 *
 * 为什么需要这个脚本而不是直接提交到 .github/workflows/：
 *   通过自动化令牌提交带有 workflow 文件的改动会被 GitHub 拒绝
 *   （错误信息：refusing to allow a GitHub App to create or update workflow ... without `workflows` permission）。
 *   而用你自己的账号在本机跑一次、再 push，就没有这个限制。
 *
 * 用法：
 *   npm run install:workflow
 *   git add .github/workflows/sync-draws.yml
 *   git commit -m "ci: enable daily draw sync"
 *   git push
 *
 * 也可以直接在 GitHub 网页上建文件：把 ci/sync-draws.yml 的内容粘到
 *   https://github.com/<owner>/<repo>/new/main/.github/workflows/sync-draws.yml
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'ci', 'sync-draws.yml');
const TARGET_DIR = path.join(ROOT, '.github', 'workflows');
const TARGET = path.join(TARGET_DIR, 'sync-draws.yml');

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`[install:workflow] 找不到源文件：${path.relative(ROOT, SOURCE)}`);
    process.exitCode = 1;
    return;
  }

  const content = fs.readFileSync(SOURCE, 'utf-8');
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.writeFileSync(TARGET, content, 'utf-8');

  console.log('✓ 已写入 .github/workflows/sync-draws.yml');
  console.log('');
  console.log('接下来（用你自己的账号提交，Actions 才会开始每天自动抓开奖）：');
  console.log('  git add .github/workflows/sync-draws.yml');
  console.log('  git commit -m "ci: enable daily draw sync"');
  console.log('  git push');
  console.log('');
  console.log('推送后在仓库的 Actions 页面点一次「Sync Daily Lottery Draws → Run workflow」验证；');
  console.log('成功后 data/draws.json 会自动更新，页面上的「一键同步」就能读到新期次。');
}

main();
