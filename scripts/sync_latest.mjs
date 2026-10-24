#!/usr/bin/env node
/**
 * 自动同步最新开奖记录脚本
 * 默认抓取源: https://2026kj.zkclhb.com:2025/am.html
 * 用法:
 *   node scripts/sync_latest.mjs
 *   node scripts/sync_latest.mjs --url https://2026kj.zkclhb.com:2025/am.html
 *   node scripts/sync_latest.mjs --input /path/to/saved.html
 *   node scripts/sync_latest.mjs --dry-run
 */

import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/constants.js';
import { mergeDraws, parseDrawsInput } from '../src/parser.js';
import { writeDatabaseFiles } from './build_history_db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const JSON_PATH = path.join(ROOT_DIR, 'data', 'draws.json');

/**
 * 发起 HTTP/HTTPS 请求抓取网页内容（支持自定义端口与宽松 TLS 校验 + 自动重试）
 * @param {string} urlStr
 * @param {{ timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<string>}
 */
export function fetchRemoteHtml(urlStr, options = {}) {
  const { timeoutMs = 20000, retries = 3 } = options;

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
            fetchRemoteHtml(redirectUrl, { timeoutMs, retries: remaining }).then(resolve, reject);
            return;
          }
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP 状态码异常: ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve(body);
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`请求超时 (${timeoutMs}ms): ${urlStr}`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    }).catch((err) => {
      if (remaining > 1) {
        console.warn(`[sync] 抓取失败 (${err.message})，剩余重试次数: ${remaining - 1}...`);
        return new Promise((r) => setTimeout(r, 1500)).then(() => attempt(remaining - 1));
      }
      throw err;
    });
  }

  return attempt(retries);
}

/**
 * 执行一次完整同步流程
 * @param {{ url?: string, inputFile?: string, rawText?: string, dryRun?: boolean }} [opts]
 */
export async function syncDraws(opts = {}) {
  const targetUrl = opts.url || DEFAULT_CONFIG.remoteSourceUrl;
  let existingDraws = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      const db = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
      existingDraws = Array.isArray(db.draws) ? db.draws : [];
    } catch {
      existingDraws = [];
    }
  }

  let content = opts.rawText || '';
  let sourceLabel = targetUrl;

  if (!content && opts.inputFile) {
    const resolvedInput = path.resolve(process.cwd(), opts.inputFile);
    content = fs.readFileSync(resolvedInput, 'utf-8');
    sourceLabel = `local:${ path.basename(resolvedInput) }`;
  } else if (!content) {
    console.log(`[sync] 正在抓取远程开奖页: ${targetUrl} ...`);
    content = await fetchRemoteHtml(targetUrl);
  }

  const incoming = parseDrawsInput(content);
  if (incoming.length === 0) {
    throw new Error('未能从输入源解析出任何有效开奖记录，已中止覆盖以保护底库。');
  }

  const { merged, addedCount, updatedCount } = mergeDraws(existingDraws, incoming);

  if (!opts.dryRun) {
    writeDatabaseFiles(merged, {
      updatedAt: new Date().toISOString(),
      source: sourceLabel
    });
  }

  const latest = merged[0] || null;
  return {
    source: sourceLabel,
    parsedCount: incoming.length,
    totalCount: merged.length,
    addedCount,
    updatedCount,
    latest
  };
}

async function cli() {
  const args = process.argv.slice(2);
  let url = DEFAULT_CONFIG.remoteSourceUrl;
  let inputFile = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[++i];
    } else if (args[i] === '--input' && args[i + 1]) {
      inputFile = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  try {
    const result = await syncDraws({ url, inputFile, dryRun });
    console.log('=== 开奖数据同步成功 ===');
    console.log(`数据源: ${result.source}`);
    console.log(`解析记录数: ${result.parsedCount} 期`);
    console.log(`新增期数: ${result.addedCount} 期 | 更新期数: ${result.updatedCount} 期 | 底库总期数: ${result.totalCount} 期`);
    if (result.latest) {
      console.log(
        `最新开奖: ${result.latest.id} (${result.latest.date}) 正码 [${result.latest.numbers.join(', ')}] + 特码 ${result.latest.special}`
      );
    }
  } catch (err) {
    console.error(`[sync] 同步失败: ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  cli();
}
