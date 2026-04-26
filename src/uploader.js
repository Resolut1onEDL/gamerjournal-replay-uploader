// Upload pre-parsed JSON to GamerJournal /api/games/upload.
// Auth: Bearer token (gj_*) created in GamerJournal /settings.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_API_URL = 'https://gamer-journal.vercel.app';

async function uploadParsedReplay({ parsed, parserVersion, metadata, apiUrl, apiToken }) {
  if (!apiToken) throw new Error('API token is not set');
  const baseUrl = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/api/games/upload`;
  const body = {
    match_id: parsed.id,
    parser_output: parsed,
    parser_version: parserVersion,
    metadata: metadata || {},
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = json?.error || `HTTP ${res.status}`;
    throw new Error(`Upload failed: ${msg}`);
  }
  return json;
}

// Persist failed uploads to disk for retry on next launch.
function pendingDir() {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const dir = path.join(home, '.gamerjournal-uploader', 'pending');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveForRetry({ parsed, parserVersion, metadata, error }) {
  const file = path.join(pendingDir(), `${parsed?.id ?? Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ parsed, parserVersion, metadata, error: error?.message, savedAt: new Date().toISOString() }),
  );
  return file;
}

async function retryPending({ apiUrl, apiToken, log = () => {} } = {}) {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) return { retried: 0, succeeded: 0, failed: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  let succeeded = 0;
  let failed = 0;
  for (const f of files) {
    const filePath = path.join(dir, f);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      await uploadParsedReplay({
        parsed: data.parsed,
        parserVersion: data.parserVersion,
        metadata: data.metadata,
        apiUrl,
        apiToken,
      });
      fs.unlinkSync(filePath);
      succeeded++;
      log(`retry ok: ${f}`);
    } catch (e) {
      failed++;
      log(`retry failed: ${f} — ${e.message}`);
    }
  }
  return { retried: files.length, succeeded, failed };
}

module.exports = {
  uploadParsedReplay,
  saveForRetry,
  retryPending,
  DEFAULT_API_URL,
};
