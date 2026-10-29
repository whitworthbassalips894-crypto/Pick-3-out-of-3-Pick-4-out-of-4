#!/usr/bin/env node
/**
 * 自动同步最新开奖记录
 *
 * 默认抓取源: https://2026kj.zkclhb.com:2025/am.html
 *
 * 这个脚本承担了整条同步链路（抓取 → 校验 → 写库 → 提交），原因很实际：
 *   GitHub App 令牌没有 `workflows` 权限，改不了 .github/workflows/*.yml，
 *   所以「多跑几次 / 先提交再跑测试」这类改动没法只靠改 workflow 完成，
 *   只能在脚本内部实现 —— 这样即使 workflow 一直是旧版，同步也能正常工作。
 *
 * 三个关键设计（都是为了「当天开奖当天入库」，而不是等到第二天）：
 *
 *  1. **门控秒退（gate）**：底库已经有今天这一期就立刻退出，不抓、不写、不提交。
 *     定时任务被重复触发时成本接近 0。
 *  2. **等待上游发布（wait）**：抓到了但还没出今天这一期 → 每隔一段时间再抓，
 *     直到拿到 / 到达截止时间 / 连续失败太多次。开奖公布通常比停售晚 5~30 分钟，
 *     靠「碰运气只跑 3 次」必然经常落空，靠「一直等到 23:40」才稳。
 *  3. **提交优先于测试**：拿到新数据就立刻提交推送（带 rebase + 重试）。
 *     workflow 里 `npm test` 排在提交之前，任何一条与数据无关的断言飘红都会把
 *     当天数据卡死；由脚本先提交，就绕开了这个失败模式。
 *
 * 用法：
 *   node scripts/sync_latest.mjs                       # 抓一次（本地默认不等待）
 *   node scripts/sync_latest.mjs --wait                # 等到今天这期出现（最长到 23:40）
 *   node scripts/sync_latest.mjs --gate-only           # 只看要不要同步（给 CI 做门控）
 *   node scripts/sync_latest.mjs --input saved.html    # 用本地保存的页面兜底
 *   node scripts/sync_latest.mjs --dry-run             # 只抓不写
 */

import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/constants.js';
import { mergeDraws, parseDrawsInput } from '../src/parser.js';
import { writeDatabaseFiles } from './build_history_db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const JSON_PATH = path.join(ROOT_DIR, 'data', 'draws.json');

/** 退出码：workflow 据此区分「成功 / 上游还没发 / 抓不到」三种情况 */
export const EXIT = {
  OK: 0, // 拿到（或本来就有）今天这一期
  FETCH_FAILED: 1, // 所有抓取尝试都失败
  NOT_PUBLISHED: 3 // 上游可达，但今天这一期还没发布
};

/* ============================== 时间工具 ============================== */

/** 北京时间的「今天」'YYYY-MM-DD'（不依赖运行机器时区，CI 是 UTC） */
export function todayInShanghai(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(now);
}

/** 北京时间的 'HH:MM'（用于判断是否已过截止时刻） */
export function clockInShanghai(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return fmt.format(now);
}

/** 'HH:MM' → 当天第几分钟（用来比较先后） */
export function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 是否已经过了截止时刻（截止时刻为空则永不过期） */
export function isPastDeadline(deadline, now = new Date()) {
  const dl = minutesOfDay(deadline);
  if (dl == null) return false;
  const cur = minutesOfDay(clockInShanghai(now));
  if (cur == null) return false;
  return cur >= dl;
}

/* ============================== 抓取 ============================== */

/**
 * 抓网页（支持非标准端口 + 宽松 TLS + 指数退避重试 + 跟随重定向）
 *
 * 上游是 `:2025` 端口 + 不完整证书链，经常 ECONNRESET，所以重试时间必须拉开：
 * 2s / 4s / 8s / 16s。固定 1.5 秒连试 3 次，上游抖一下当天就没数据了。
 *
 * @param {string} urlStr
 * @param {{ timeoutMs?: number, retries?: number, backoffMs?: number, sleep?: (ms:number)=>Promise<void> }} [options]
 * @returns {Promise<string>}
 */
export function fetchRemoteHtml(urlStr, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 5,
    backoffMs = 2000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = options;

  function attempt(remaining) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(urlStr);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        urlObj,
        {
          method: 'GET',
          timeout: timeoutMs,
          rejectUnauthorized: false,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache'
          }
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, urlObj).toString();
            fetchRemoteHtml(redirectUrl, { timeoutMs, retries: remaining, backoffMs, sleep }).then(resolve, reject);
            return;
          }
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP 状态码异常: ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          res.on('error', reject);
        }
      );

      req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeoutMs}ms): ${urlStr}`)));
      req.on('error', reject);
      req.end();
    }).catch(async (err) => {
      if (remaining > 1) {
        const wait = backoffMs * Math.pow(2, retries - remaining); // 2s → 4s → 8s → 16s
        console.warn(`[sync] 抓取失败（${err.message}），${Math.round(wait / 1000)} 秒后重试（剩 ${remaining - 1} 次）…`);
        await sleep(wait);
        return attempt(remaining - 1);
      }
      throw err;
    });
  }

  return attempt(retries);
}

/** 依次尝试多个候选源，全部失败才算失败 */
export async function fetchFromAny(urls, options = {}) {
  const errors = [];
  for (const url of urls) {
    try {
      return { html: await fetchRemoteHtml(url, options), url };
    } catch (err) {
      errors.push(`${url} → ${err.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

/* ============================== 数据校验 ============================== */

/**
 * 写库前的硬校验：宁可这次不写，也不能把坏数据写进底库
 *
 * @param {object[]} merged 合并后的完整底库（降序）
 * @param {object[]} previous 写之前已有的底库
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateDatabase(merged, previous = []) {
  if (!Array.isArray(merged) || merged.length === 0) {
    return { ok: false, reason: '底库为空' };
  }
  // 只增不减：任何一次同步都不允许让底库变短（防止上游改版后解析出半截数据）
  if (merged.length < previous.length) {
    return { ok: false, reason: `期数从 ${previous.length} 掉到 ${merged.length}，拒绝覆盖` };
  }
  for (const d of merged.slice(0, 3)) {
    if (!Array.isArray(d.numbers) || d.numbers.length !== 6) {
      return { ok: false, reason: `${d.id} 正码不是 6 个` };
    }
    const all = [...d.numbers, d.special];
    if (all.some((n) => !Number.isInteger(n) || n < 1 || n > 49)) {
      return { ok: false, reason: `${d.id} 号码越界` };
    }
    if (new Set(all).size !== 7) {
      return { ok: false, reason: `${d.id} 号码有重复` };
    }
  }
  return { ok: true };
}

/** 底库里是否已经有目标日期（含更晚）的开奖 → 不需要再同步 */
export function isDatabaseFresh(draws, waitFor) {
  if (!Array.isArray(draws) || !draws.length || !waitFor) return false;
  return String(draws[0].date || '') >= String(waitFor);
}

/* ============================== 提交（CI 用） ============================== */

function runGit(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: ROOT_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out).trim() };
  } catch (err) {
    if (!allowFail) throw err;
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}`.trim(), error: err };
  }
}

/**
 * 提交并推送底库（带 rebase + 重试）
 *
 * 为什么由脚本提交而不是交给 workflow 的 commit 步骤：
 *   workflow 是「抓取 → npm test → 提交」，测试一旦飘红，当天数据就永远进不了库；
 *   这里先提交，测试红不红都不影响数据落地。
 *
 * @param {{ latestId?: string, branch?: string, retries?: number, sleep?: Function }} [opts]
 */
export async function commitAndPush(opts = {}) {
  const {
    latestId = 'latest',
    branch = process.env.GITHUB_REF_NAME || '',
    retries = 3,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = opts;

  runGit(['add', 'data/draws.json', 'data/draws.js']);
  const staged = runGit(['diff', '--staged', '--quiet'], { allowFail: true });
  if (staged.ok) return { committed: false, pushed: false, reason: '没有变化' };

  runGit([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `chore(data): sync lottery draws up to ${latestId}`
  ]);

  if (!branch) return { committed: true, pushed: false, reason: '不在 CI 或没有分支名' };

  let lastError = '';
  for (let i = 1; i <= retries; i++) {
    // 定时任务期间可能有人合并了 PR / Pages 有提交，先 rebase 再推
    runGit(['pull', '--rebase', '--autostash', 'origin', branch], { allowFail: true });
    const push = runGit(['push', 'origin', `HEAD:${branch}`], { allowFail: true });
    if (push.ok) return { committed: true, pushed: true, attempts: i };
    lastError = push.out;
    console.warn(`[sync] push 第 ${i} 次失败，${i * 5} 秒后重试… ${lastError.slice(0, 200)}`);
    await sleep(i * 5000);
  }
  throw new Error(`提交成功但推送失败：${lastError.slice(0, 300)}`);
}

/* ============================== 主流程 ============================== */

function readExistingDraws() {
  if (!fs.existsSync(JSON_PATH)) return [];
  try {
    const db = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
    return Array.isArray(db.draws) ? db.draws : [];
  } catch {
    return [];
  }
}

/**
 * 抓一次：返回页面内容（失败抛错）
 *
 * `opts.fetchContent` 是给单测用的注入点：测试里可以模拟「前几轮还没发布、
 * 第 N 轮才出现今天这一期」，而不必真的联网。
 */
async function fetchOnce(opts) {
  if (typeof opts.fetchContent === 'function') {
    return { content: await opts.fetchContent(), label: 'injected' };
  }
  if (opts.rawText) return { content: opts.rawText, label: 'raw-text' };
  if (opts.inputFile) {
    const resolved = path.resolve(process.cwd(), opts.inputFile);
    return { content: fs.readFileSync(resolved, 'utf-8'), label: `local:${path.basename(resolved)}` };
  }
  const urls = (opts.urls && opts.urls.length ? opts.urls : [DEFAULT_CONFIG.remoteSourceUrl]);
  const { html, url } = await fetchFromAny(urls, {
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    sleep: opts.sleep
  });
  return { content: html, label: url };
}

/**
 * 执行一次同步
 *
 * @param {object} [opts]
 * @param {string[]} [opts.urls]        候选抓取源（按顺序尝试）
 * @param {string}   [opts.inputFile]   用本地 HTML 兜底
 * @param {string}   [opts.rawText]     直接传入页面内容
 * @param {boolean}  [opts.dryRun]      只抓不写
 * @param {boolean}  [opts.gateOnly]    只判断要不要同步
 * @param {string}   [opts.waitFor]     目标日期（默认北京今天）
 * @param {boolean}  [opts.wait]        拿不到目标期就继续等
 * @param {string}   [opts.deadline]    等待截止时刻 'HH:MM'（北京）
 * @param {number}   [opts.maxWaitMin]  硬性等待上限（分钟）
 * @param {number}   [opts.intervalSec] 轮询间隔（秒）
 * @param {number}   [opts.maxFetchFailures] 连续抓取失败多少次后放弃
 * @param {boolean}  [opts.commit]      写库后提交推送（CI 自动开启）
 */
export async function syncDraws(opts = {}) {
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const waitFor = opts.waitFor || todayInShanghai(opts.now || new Date());
  const existing = readExistingDraws();

  // —— 门控：已经有今天这一期，直接结束，不碰网络 ——
  if (isDatabaseFresh(existing, waitFor)) {
    return {
      status: 'fresh',
      waitFor,
      latest: existing[0] || null,
      totalCount: existing.length,
      addedCount: 0,
      updatedCount: 0,
      parsedCount: 0,
      source: 'local-cache',
      committed: false
    };
  }
  if (opts.gateOnly) {
    return { status: 'needs-sync', waitFor, latest: existing[0] || null, totalCount: existing.length };
  }

  const deadline = opts.deadline || '23:55';
  const startNow = opts.now ? new Date(opts.now) : new Date();
  // 任务本身就是深夜才启动（cron 延迟）时，不能用「已过截止点」把自己立刻掐掉，
  // 这种情况下只由 maxWaitMin 兜底
  const deadlineBlocks = !isPastDeadline(deadline, startNow);
  const maxWaitMin = Number.isFinite(opts.maxWaitMin) ? opts.maxWaitMin : 0;
  const intervalSec = Math.max(5, Number(opts.intervalSec) || 60);
  const maxFetchFailures = Math.max(1, Number(opts.maxFetchFailures) || 10);
  const startedAt = Date.now();

  let merged = existing;
  let addedCount = 0;
  let updatedCount = 0;
  let parsedCount = 0;
  let sourceLabel = '';
  let consecutiveFailures = 0;
  let rounds = 0;
  let lastError = '';
  // 「一次都没解析成功」和「解析成功但上游还没发」是两件事：
  // 前者说明站点改版 / 网络坏（真故障），后者只是还没到点，不能混为一谈。
  let anySuccessfulParse = false;

  for (;;) {
    rounds++;
    let incoming = [];
    try {
      const { content, label } = await fetchOnce({ ...opts, sleep });
      sourceLabel = label;
      consecutiveFailures = 0;
      incoming = parseDrawsInput(content);
      if (!incoming.length) throw new Error('页面里解析不出任何开奖记录（站点结构可能变了）');
      anySuccessfulParse = true;
      const res = mergeDraws(existing, incoming);
      merged = res.merged;
      addedCount = res.addedCount;
      updatedCount = res.updatedCount;
      parsedCount = incoming.length;
    } catch (err) {
      consecutiveFailures++;
      lastError = err.message;
      console.warn(`[sync] 第 ${rounds} 轮失败（连续 ${consecutiveFailures} 次）：${err.message}`);
      if (consecutiveFailures >= maxFetchFailures) {
        if (merged.length && (addedCount || updatedCount)) break; // 至少补到了一些，照样写
        return { status: 'fetch-failed', waitFor, latest: existing[0] || null, totalCount: existing.length, error: lastError };
      }
    }

    const fresh = isDatabaseFresh(merged, waitFor);
    if (fresh) break;

    // 判断还能不能等
    if (!opts.wait) break;
    const waitedMin = (Date.now() - startedAt) / 60000;
    if (waitedMin >= maxWaitMin) break;
    if (deadlineBlocks && isPastDeadline(deadline)) {
      console.log(`[sync] 已过截止时刻 ${deadline}（北京），停止等待`);
      break;
    }
    console.log(`[sync] 还没有 ${waitFor} 这一期（底库最新 ${merged[0] ? merged[0].id : '无'}），${intervalSec} 秒后再抓…`);
    await sleep(intervalSec * 1000);
  }

  const validation = validateDatabase(merged, existing);
  const changed = addedCount > 0 || updatedCount > 0;

  if (!validation.ok) {
    return { status: 'invalid', waitFor, latest: merged[0] || null, totalCount: merged.length, error: validation.reason };
  }

  if (changed && !opts.dryRun) {
    writeDatabaseFiles(merged, { updatedAt: new Date().toISOString(), source: sourceLabel || 'unknown' });
  }

  const fresh = isDatabaseFresh(merged, waitFor);
  let commit = { committed: false, pushed: false };
  if (changed && !opts.dryRun && opts.commit) {
    commit = await commitAndPush({ latestId: merged[0] ? merged[0].id : 'latest', sleep });
  }

  const broken = !anySuccessfulParse || consecutiveFailures >= maxFetchFailures;
  return {
    status: fresh ? 'ok' : (broken ? 'fetch-failed' : 'not-published'),
    waitFor,
    source: sourceLabel,
    parsedCount,
    totalCount: merged.length,
    addedCount,
    updatedCount,
    latest: merged[0] || null,
    rounds,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    ...commit,
    error: lastError || undefined
  };
}

/* ============================== CI 辅助输出 ============================== */

function annotate(level, message) {
  // GitHub Actions 注解：让失败在 Actions 页面上一眼看见，而不是埋在日志里
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}::${message}`);
}

function writeStepSummary(result) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const latest = result.latest;
  const lines = [
    '| 项 | 值 |',
    '| --- | --- |',
    `| 目标期日期（北京） | ${result.waitFor || '—'} |`,
    `| 底库最新 | ${latest ? `${latest.id}（${latest.date}）` : '—'} |`,
    `| 结果 | ${result.status} |`,
    `| 新增 / 更新 | ${result.addedCount ?? 0} / ${result.updatedCount ?? 0} 期 |`,
    `| 底库总期数 | ${result.totalCount ?? 0} |`,
    `| 抓取轮次 / 耗时 | ${result.rounds ?? 0} 轮 / ${result.elapsedSec ?? 0} 秒 |`,
    `| 已提交推送 | ${result.pushed ? '是' : '否'} |`,
    result.error ? `| 失败原因 | ${String(result.error).slice(0, 200)} |` : ''
  ].filter(Boolean);
  try {
    fs.appendFileSync(file, `${lines.join('\n')}\n`);
  } catch {
    /* 写 summary 失败不影响主流程 */
  }
}

function setActionOutput(result) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const kv = {
    status: result.status || '',
    latest_id: result.latest ? result.latest.id : '',
    latest_date: result.latest ? result.latest.date : '',
    added: String(result.addedCount ?? 0),
    pushed: result.pushed ? 'true' : 'false'
  };
  try {
    fs.appendFileSync(file, `${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  } catch {
    /* 同上 */
  }
}

/* ============================== CLI ============================== */

function parseArgs(argv) {
  const out = { urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url' && argv[i + 1]) out.urls.push(next());
    else if (a === '--input' && argv[i + 1]) out.inputFile = next();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--gate-only') out.gateOnly = true;
    else if (a === '--wait') out.wait = true;
    else if (a === '--no-wait') out.wait = false;
    else if (a === '--wait-for' && argv[i + 1]) out.waitFor = next();
    else if (a === '--deadline' && argv[i + 1]) out.deadline = next();
    else if (a === '--max-wait-min' && argv[i + 1]) out.maxWaitMin = Number(next());
    else if (a === '--interval' && argv[i + 1]) out.intervalSec = Number(next());
    else if (a === '--retries' && argv[i + 1]) out.retries = Number(next());
    else if (a === '--commit') out.commit = true;
    else if (a === '--no-commit') out.commit = false;
  }
  return out;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

  // CI 默认行为：定时任务 → 等到今天这期出现；手动触发 → 抓一次就返回
  if (args.wait === undefined) args.wait = inActions && !manual;
  if (args.commit === undefined) args.commit = inActions && !args.dryRun;
  // 可用环境变量覆盖（不用改代码就能调），默认「等到 23:35 左右」
  if (args.maxWaitMin === undefined) {
    const envMax = Number(process.env.SYNC_MAX_WAIT_MIN);
    args.maxWaitMin = Number.isFinite(envMax) && envMax > 0 ? envMax : (args.wait ? 130 : 0);
  }
  if (args.deadline === undefined) args.deadline = '23:55';
  if (!args.urls.length) args.urls = [DEFAULT_CONFIG.remoteSourceUrl];

  try {
    const result = await syncDraws(args);

    if (result.status === 'fresh') {
      console.log(`[sync] 底库已有 ${result.waitFor} 这一期（最新 ${result.latest.id}），无需同步`);
      setActionOutput(result);
      writeStepSummary(result);
      return;
    }
    if (result.status === 'needs-sync') {
      console.log(`[sync] 需要同步：目标 ${result.waitFor}，底库最新 ${result.latest ? result.latest.id : '无'}`);
      setActionOutput(result);
      process.exitCode = EXIT.NOT_PUBLISHED;
      return;
    }
    if (result.status === 'fetch-failed' || result.status === 'invalid') {
      console.error(`[sync] 同步失败：${result.error || ''}`);
      annotate('error', `开奖同步失败：${String(result.error || '').slice(0, 180)}`);
      setActionOutput(result);
      writeStepSummary(result);
      process.exitCode = EXIT.FETCH_FAILED;
      return;
    }

    console.log('=== 开奖数据同步 ===');
    console.log(`数据源: ${result.source}`);
    console.log(`解析记录数: ${result.parsedCount} 期`);
    console.log(`新增 ${result.addedCount} 期 | 更新 ${result.updatedCount} 期 | 底库共 ${result.totalCount} 期`);
    console.log(`等待轮次: ${result.rounds} 轮，耗时 ${result.elapsedSec} 秒`);
    if (result.latest) {
      console.log(`底库最新: ${result.latest.id} (${result.latest.date}) [${result.latest.numbers.join(', ')}] + 特码 ${result.latest.special}`);
    }
    if (result.committed) console.log(`已提交${result.pushed ? '并推送' : '（未推送）'}`);

    if (result.status === 'not-published') {
      // ⚠ 这里特意用 exit 0：等到 23:55 还没发布，属于「上游还没出」，不是流程坏了。
      //   真正的抓取故障（站点挂了 / 解析坏了）才返回非 0，这样红灯才有意义。
      annotate('warning', `上游还没有 ${result.waitFor} 这一期（底库最新 ${result.latest ? result.latest.id : '无'}），本次未取得新数据`);
    }
    setActionOutput(result);
    writeStepSummary(result);
  } catch (err) {
    console.error(`[sync] 同步异常: ${err.message}`);
    annotate('error', `开奖同步异常：${err.message.slice(0, 180)}`);
    process.exitCode = EXIT.FETCH_FAILED;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  cli();
}
