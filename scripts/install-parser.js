#!/usr/bin/env node
// Download dota-replay-parser binaries from a pinned GitHub release into ./bin/.
//
// Runs on `npm install` (postinstall) and `npm run build` (electron-builder
// needs all 3 platform binaries present at packaging time).
//
// Pinned version is in package.json under `parserVersion` (e.g. "v3.1.1").
// Skip download if local file already matches expected size — keeps re-installs
// cheap.
//
// To re-pin: bump `parserVersion` in package.json and re-run `npm install`.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const REPO = 'Resolut1onEDL/dota-replay-parser';
const FILES = ['parser-mac-arm64', 'parser-linux-x64', 'parser-win-x64.exe'];

const pkg = require(path.join(__dirname, '..', 'package.json'));
const version = pkg.parserVersion;
if (!version) {
  console.error('install-parser: package.json is missing `parserVersion` field (e.g. "v3.1.1")');
  process.exit(1);
}

const binDir = path.join(__dirname, '..', 'bin');
fs.mkdirSync(binDir, { recursive: true });

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'install-parser' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetch(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadOne(name) {
  const url = `https://github.com/${REPO}/releases/download/${version}/${name}`;
  const dest = path.join(binDir, name);
  process.stdout.write(`install-parser: ${name} ${version} ... `);
  const buf = await fetch(url);
  fs.writeFileSync(dest, buf, { mode: 0o755 });
  console.log(`ok (${buf.length} bytes)`);
}

(async () => {
  try {
    await Promise.all(FILES.map(downloadOne));
  } catch (e) {
    console.error('\ninstall-parser failed:', e.message);
    console.error('Hint: check that release', version, 'exists at https://github.com/' + REPO + '/releases');
    process.exit(1);
  }
})();
