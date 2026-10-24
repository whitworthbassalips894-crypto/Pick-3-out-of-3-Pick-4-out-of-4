#!/usr/bin/env node
/**
 * 构建 2022~2026 完整历史开奖底库 (data/draws.json & data/draws.js)
 * 支持从 /tmp/arena-coding-uploads/*.html 或指定目录读取历史 HTML 并与现有底库幂等合并
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeDraws, parseDrawsInput } from '../src/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const JSON_PATH = path.join(DATA_DIR, 'draws.json');
const JS_PATH = path.join(DATA_DIR, 'draws.js');

export function writeDatabaseFiles(draws, sourceMeta = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const years = Array.from(new Set(draws.map((d) => d.year))).sort((a, b) => b - a);
  const latest = draws[0] || null;

  const payload = {
    updatedAt: sourceMeta.updatedAt || new Date().toISOString(),
    source: sourceMeta.source || 'https://2026kj.zkclhb.com:2025/am.html',
    totalCount: draws.length,
    latestId: latest ? latest.id : null,
    latestDate: latest ? latest.date : null,
    years,
    draws
  };

  fs.writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');

  const jsContent = `/**
 * 六合彩 2022-2026 完整历史开奖底库（自动生成，请勿手工破坏格式）
 * 总期数: ${draws.length} 期 | 最新一期: ${latest ? `${latest.id} (${latest.date})` : 'N/A'}
 */
export const INITIAL_DB = ${JSON.stringify(payload)};
if (typeof window !== 'undefined') {
  window.__INITIAL_DRAWS_DB__ = INITIAL_DB;
}
export default INITIAL_DB;
`;
  fs.writeFileSync(JS_PATH, jsContent, 'utf-8');
  return payload;
}

function main() {
  let existing = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
      existing = Array.isArray(raw.draws) ? raw.draws : [];
    } catch {
      existing = [];
    }
  }

  const candidateDirs = [
    '/tmp/arena-coding-uploads',
    path.join(ROOT_DIR, 'raw_html')
  ];

  const incoming = [];
  const loadedFiles = [];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.html'))
      .sort();

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const html = fs.readFileSync(fullPath, 'utf-8');
      const parsed = parseDrawsInput(html);
      incoming.push(...parsed);
      loadedFiles.push(`${file} (${parsed.length}期)`);
    }
  }

  const { merged, addedCount, updatedCount } = mergeDraws(existing, incoming);
  const payload = writeDatabaseFiles(merged, {
    updatedAt: '2026-10-24T00:00:00.000Z',
    source: 'https://2026kj.zkclhb.com:2025/am.html'
  });

  console.log('=== 历史开奖底库构建完成 ===');
  if (loadedFiles.length > 0) {
    console.log('读取源文件:', loadedFiles.join(', '));
  }
  console.log(`总期数: ${payload.totalCount} 期 | 新增: ${addedCount} 期 | 更新: ${updatedCount} 期`);
  console.log(`覆盖年份: ${payload.years.join(', ')}`);
  console.log(`最新一期: ${payload.latestId} (${payload.latestDate})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
