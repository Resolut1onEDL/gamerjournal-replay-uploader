#!/usr/bin/env node
// CLI smoke-test для разработки на macOS/Linux без Electron UI.
// Парсит .dem или .json, отправляет на GamerJournal /api/games/upload.
//
// Usage:
//   GJ_API_TOKEN=gj_xxx node scripts/cli-test.js path/to/replay.dem
//   GJ_API_TOKEN=gj_xxx GJ_API_URL=http://localhost:3000 node scripts/cli-test.js path/to/parsed.json
//
// Если .json — пропускает шаг парсинга, сразу шлёт upload (полезно для
// тестирования upload-логики на mac, когда у тебя есть готовые _parsed.json
// из resoai-dota-coach test-replays).

const fs = require('node:fs');
const path = require('node:path');
const { parseReplay } = require('../src/parser-runner');
const { uploadParsedReplay, DEFAULT_API_URL } = require('../src/uploader');

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: cli-test.js <path-to-.dem-or-parsed-.json>');
    process.exit(1);
  }
  const apiToken = process.env.GJ_API_TOKEN;
  if (!apiToken) {
    console.error('GJ_API_TOKEN env var is required');
    process.exit(1);
  }
  const apiUrl = process.env.GJ_API_URL || DEFAULT_API_URL;

  let parsed;
  let parserVersion = 'cli-test';
  if (file.endsWith('.json')) {
    console.log(`[cli] reading parsed JSON: ${file}`);
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parserVersion = parsed.parserVersion ?? 'cli-prebuilt-json';
  } else {
    console.log(`[cli] parsing replay: ${file}`);
    const t0 = Date.now();
    const r = await parseReplay(file, { timeoutMs: 120000 });
    parsed = r.parsed;
    parserVersion = r.parserVersion;
    console.log(`[cli] parsed in ${((Date.now() - t0) / 1000).toFixed(1)}s; match_id=${parsed.id}`);
  }

  console.log(`[cli] uploading to ${apiUrl}/api/games/upload`);
  const t0 = Date.now();
  const result = await uploadParsedReplay({
    parsed,
    parserVersion,
    metadata: { source: 'cli-test', file: path.basename(file) },
    apiUrl,
    apiToken,
  });
  console.log(`[cli] uploaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(`[cli] FAIL: ${e.message}`);
  process.exit(1);
});
