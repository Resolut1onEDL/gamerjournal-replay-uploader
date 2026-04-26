// Dota 2 install path detection + GSI config installer.
// Adapted from resoai-dota-coach/tools/replay-uploader (replay-uploader had
// "ResoAI" branding; we use GamerJournal branding and same port 3000).

const fs = require('node:fs');
const path = require('node:path');

const GSI_APP_NAME = 'GamerJournal Replay Uploader';
const GSI_FILENAME = 'gamestate_integration_gamerjournal.cfg';
const GSI_PORT = 3000;

const GSI_CONFIG = `"${GSI_APP_NAME}"
{
    "uri"           "http://127.0.0.1:${GSI_PORT}/"
    "timeout"       "5.0"
    "buffer"        "0.1"
    "throttle"      "0.1"
    "heartbeat"     "30.0"
    "data"
    {
        "provider"      "1"
        "map"           "1"
        "player"        "1"
        "hero"          "1"
        "abilities"     "1"
        "items"         "1"
    }
}`;

function commonDotaPaths() {
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta',
      'C:\\Program Files\\Steam\\steamapps\\common\\dota 2 beta',
      'D:\\Steam\\steamapps\\common\\dota 2 beta',
      'D:\\SteamLibrary\\steamapps\\common\\dota 2 beta',
      'E:\\Steam\\steamapps\\common\\dota 2 beta',
      'E:\\SteamLibrary\\steamapps\\common\\dota 2 beta',
      'F:\\Steam\\steamapps\\common\\dota 2 beta',
      'F:\\SteamLibrary\\steamapps\\common\\dota 2 beta',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      path.join(
        process.env.HOME || '',
        'Library/Application Support/Steam/steamapps/common/dota 2 beta',
      ),
    ];
  }
  // linux
  return [
    path.join(process.env.HOME || '', '.steam/steam/steamapps/common/dota 2 beta'),
    path.join(process.env.HOME || '', '.local/share/Steam/steamapps/common/dota 2 beta'),
  ];
}

function getDotaPath() {
  for (const p of commonDotaPaths()) {
    if (!p) continue;
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'game', 'dota', 'gameinfo.gi'))) {
      return p;
    }
  }
  return null;
}

async function installGSIConfig(dotaPath) {
  const gsiDir = path.join(dotaPath, 'game', 'dota', 'cfg', 'gamestate_integration');
  const gsiFile = path.join(gsiDir, GSI_FILENAME);
  if (!fs.existsSync(gsiDir)) fs.mkdirSync(gsiDir, { recursive: true });
  fs.writeFileSync(gsiFile, GSI_CONFIG);
  if (!fs.existsSync(gsiFile)) throw new Error('Failed to install GSI config');
  return true;
}

function isGSIConfigInstalled(dotaPath) {
  const gsiFile = path.join(
    dotaPath,
    'game',
    'dota',
    'cfg',
    'gamestate_integration',
    GSI_FILENAME,
  );
  return fs.existsSync(gsiFile);
}

function getReplaysPath(dotaPath) {
  return path.join(dotaPath, 'game', 'dota', 'replays');
}

module.exports = {
  getDotaPath,
  installGSIConfig,
  isGSIConfigInstalled,
  getReplaysPath,
  GSI_APP_NAME,
  GSI_FILENAME,
  GSI_CONFIG,
  GSI_PORT,
};
