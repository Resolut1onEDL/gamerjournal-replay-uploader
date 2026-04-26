// Wrapper around bundled Go binary (compiled from
// resoai-dota-coach/tools/replay-parser/main.go, dotabuff/manta).
// Spawns binary with replay path, captures stdout JSON, returns parsed object.
//
// Binary location:
//   - Dev (npm run start):     <repo>/bin/parser-<os>-<arch>[.exe]
//   - Packaged (electron-builder): process.resourcesPath/parser[.exe]

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function resolveBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  // Packaged: electron-builder copies bin/parser-<os>-<arch>[.exe] -> resources/parser[.exe]
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, `parser${ext}`);
    if (fs.existsSync(packaged)) return packaged;
  }
  // Dev fallback: pick by platform/arch from <repo>/bin/
  const platMap = { darwin: 'darwin', win32: 'windows', linux: 'linux' };
  const archMap = { arm64: 'arm64', x64: 'amd64' };
  const plat = platMap[process.platform];
  const arch = archMap[process.arch];
  if (!plat || !arch) {
    throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  }
  const dev = path.join(__dirname, '..', 'bin', `parser-${plat}-${arch}${ext}`);
  if (fs.existsSync(dev)) return dev;
  throw new Error(`Parser binary not found at ${dev}`);
}

function parseReplay(filePath, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveBinaryPath();
    const child = spawn(bin, [filePath], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const chunks = [];
    let timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Parser timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Parser spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(`Parser exited with code ${code}. stderr: ${stderr.slice(0, 500)}`),
        );
      }
      stdout = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(stdout);
        resolve({ parsed, parserVersion: parsed.parserVersion ?? 'unknown' });
      } catch (e) {
        reject(new Error(`Parser produced invalid JSON: ${e.message}`));
      }
    });
  });
}

module.exports = { parseReplay, resolveBinaryPath };
