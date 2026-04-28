// GamerJournal Replay Uploader — main process.
//
// Lifecycle:
//   1. App start → restore settings (apiUrl, apiToken, dotaPath, autoStart)
//   2. Detect Dota path if missing
//   3. Start file-watcher on Dota replays folder (chokidar)
//   4. Start GSI server (port 3000) — Phase 7 will hook into match-end events
//   5. On new .dem detected → parser-runner → uploader → log + emit IPC event

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const { startGSIServer, stopGSIServer } = require('./gsi-server');
const { startWatcher, stopWatcher } = require('./file-watcher');
const { parseReplay } = require('./parser-runner');
const {
  uploadParsedReplay,
  saveForRetry,
  retryPending,
  DEFAULT_API_URL,
} = require('./uploader');
const {
  installGSIConfig,
  getDotaPath,
  getReplaysPath,
  isGSIConfigInstalled,
} = require('./dota-integration');

const store = new Store({
  defaults: {
    apiUrl: DEFAULT_API_URL,
    apiToken: '',
    dotaPath: '',
    autoStart: true,
    totalUploads: 0,
    totalFailures: 0,
    lastUploadAt: null,
  },
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

const stats = {
  uploadsToday: 0,
  totalUploads: store.get('totalUploads'),
  totalFailures: store.get('totalFailures'),
  lastUploadAt: store.get('lastUploadAt'),
  watcherActive: false,
  gsiActive: false,
};

const log = [];
function pushLog(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  log.push(entry);
  if (log.length > 200) log.shift();
  console.log(`[${level}] ${message}`);
  emit('log', entry);
}

function emit(name, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-event', { name, payload });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Открыть', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: `Загружено сегодня: ${stats.uploadsToday}`, enabled: false },
    { label: `Всего: ${stats.totalUploads}`, enabled: false },
    {
      label: `Watcher: ${stats.watcherActive ? 'on' : 'off'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    tray = new Tray(iconPath);
  } else {
    // fall back: empty tray won't crash because we never set icon explicitly
    tray = null;
    return;
  }
  tray.setToolTip('GamerJournal Replay Uploader');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => mainWindow && mainWindow.show());
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// === Replay processing pipeline ===
async function processReplay(filePath, matchIdHint) {
  pushLog('info', `Parsing ${path.basename(filePath)} (match ${matchIdHint ?? '?'})`);
  emit('replay-detected', { filePath, matchId: matchIdHint });

  let parsed, parserVersion;
  try {
    const r = await parseReplay(filePath);
    parsed = r.parsed;
    parserVersion = r.parserVersion;
  } catch (e) {
    pushLog('error', `Parse failed: ${e.message}`);
    stats.totalFailures++;
    store.set('totalFailures', stats.totalFailures);
    emit('parse-error', { filePath, error: e.message });
    return;
  }

  pushLog('info', `Parsed match_id=${parsed.id}; uploading...`);

  try {
    const apiUrl = store.get('apiUrl');
    const apiToken = store.get('apiToken');
    const result = await uploadParsedReplay({
      parsed,
      parserVersion,
      metadata: {
        replay_path: filePath,
        file_size_bytes: fs.statSync(filePath).size,
        uploaded_at: new Date().toISOString(),
      },
      apiUrl,
      apiToken,
    });
    stats.uploadsToday++;
    stats.totalUploads++;
    stats.lastUploadAt = new Date().toISOString();
    store.set('totalUploads', stats.totalUploads);
    store.set('lastUploadAt', stats.lastUploadAt);
    refreshTray();
    pushLog(
      'info',
      `Uploaded match_id=${parsed.id} → game_id=${result.game_id}${
        result.warnings ? ` (warnings: ${result.warnings.join('; ')})` : ''
      }`,
    );
    emit('upload-success', { matchId: parsed.id, result, stats });
  } catch (e) {
    pushLog('error', `Upload failed: ${e.message}; saved for retry`);
    stats.totalFailures++;
    store.set('totalFailures', stats.totalFailures);
    saveForRetry({ parsed, parserVersion, metadata: {}, error: e });
    emit('upload-error', { matchId: parsed.id, error: e.message });
  }
}

function onNewReplay(filePath, matchId) {
  // Fire and forget — the watcher chains; we don't want to block file-watcher.
  processReplay(filePath, matchId).catch((e) => {
    pushLog('error', `Pipeline crashed: ${e.message}`);
  });
}

function onMatchEnd(matchId) {
  pushLog('info', `GSI: match ended ${matchId} (Phase 7 will use this for audio link)`);
  emit('match-ended', { matchId });
}

// === IPC ===
ipcMain.handle('get-settings', () => ({
  apiUrl: store.get('apiUrl'),
  apiToken: store.get('apiToken'),
  dotaPath: store.get('dotaPath'),
  autoStart: store.get('autoStart'),
  gsiInstalled:
    store.get('dotaPath') && isGSIConfigInstalled(store.get('dotaPath')),
  stats,
  log: log.slice(-50),
}));

ipcMain.handle('save-settings', (_evt, s) => {
  if (s.apiUrl !== undefined) store.set('apiUrl', s.apiUrl);
  if (s.apiToken !== undefined) store.set('apiToken', s.apiToken);
  if (s.dotaPath !== undefined) store.set('dotaPath', s.dotaPath);
  if (s.autoStart !== undefined) {
    store.set('autoStart', s.autoStart);
    app.setLoginItemSettings({ openAtLogin: !!s.autoStart });
  }
  // Restart watcher if dotaPath changed
  if (s.dotaPath !== undefined && s.dotaPath) {
    stopWatcher();
    const replaysPath = getReplaysPath(s.dotaPath);
    startWatcher(replaysPath, onNewReplay);
    stats.watcherActive = true;
    refreshTray();
  }
  return { ok: true };
});

ipcMain.handle('select-dota-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Выбери папку Dota 2 (содержит game/dota/...)',
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const dotaPath = result.filePaths[0];
  store.set('dotaPath', dotaPath);
  stopWatcher();
  startWatcher(getReplaysPath(dotaPath), onNewReplay);
  stats.watcherActive = true;
  refreshTray();
  return { ok: true, dotaPath };
});

ipcMain.handle('install-gsi', async () => {
  const dotaPath = store.get('dotaPath');
  if (!dotaPath) return { ok: false, error: 'Dota path not set' };
  try {
    await installGSIConfig(dotaPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('test-connection', async () => {
  const apiUrl = (store.get('apiUrl') || DEFAULT_API_URL).replace(/\/+$/, '');
  const apiToken = store.get('apiToken');
  if (!apiToken) return { ok: false, error: 'API token not set' };
  try {
    // Hit /api/games/upload with a deliberately invalid POST → expect 400 with our error
    // (this proves token works; 401 would mean bad token).
    const res = await fetch(`${apiUrl}/api/games/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: '{}',
    });
    if (res.status === 401) return { ok: false, error: 'Invalid token' };
    // 400 = auth ok but body invalid (expected — we sent empty body)
    return { ok: res.status === 400, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('retry-pending', async () => {
  const apiUrl = store.get('apiUrl');
  const apiToken = store.get('apiToken');
  return await retryPending({ apiUrl, apiToken, log: (m) => pushLog('info', m) });
});

ipcMain.handle('get-stats', () => stats);

ipcMain.handle('reparse-file', async (_evt, filePath) => {
  if (!fs.existsSync(filePath)) return { ok: false, error: 'file not found' };
  await processReplay(filePath, null);
  return { ok: true };
});

// === Auto-updater ===
// Reads `publish` config from package.json (GitHub provider). On packaged
// builds, checks the repo's releases for a newer tag and downloads in the
// background. Renderer drives UI via `update-status` events; manual button
// triggers `check-for-updates`.
//
// Status lifecycle (state field): idle → checking → available → downloading
// → downloaded → (user clicks restart) → quitAndInstall.
// `not-available` and `error` are terminal until next manual check.
let updateState = { state: 'idle', version: null, progress: null, error: null };

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  emit('update-status', updateState);
}

if (app.isPackaged) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => pushLog('info', `update: ${m}`),
                         warn: (m) => pushLog('warn', `update: ${m}`),
                         error: (m) => pushLog('error', `update: ${m}`),
                         debug: () => {} };

  autoUpdater.on('checking-for-update', () => setUpdateState({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setUpdateState({ state: 'available', version: info.version, error: null }));
  autoUpdater.on('update-not-available', (info) => setUpdateState({ state: 'not-available', version: info.version, error: null }));
  autoUpdater.on('download-progress', (p) => setUpdateState({ state: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ state: 'downloaded', version: info.version, progress: 100 }));
  autoUpdater.on('error', (err) => setUpdateState({ state: 'error', error: err && err.message ? err.message : String(err) }));
}

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { ok: false, error: 'dev build — auto-update disabled' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result && result.updateInfo ? result.updateInfo.version : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('quit-and-install', () => {
  if (!app.isPackaged) return { ok: false, error: 'dev build' };
  if (updateState.state !== 'downloaded') return { ok: false, error: 'no update ready' };
  // setImmediate so the IPC reply lands before the app shuts down
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

ipcMain.handle('get-update-status', () => updateState);

// === Lifecycle ===
//
// Enforce single instance — without this, the GSI server's port-3000 bind
// crashes the new instance on EADDRINUSE whenever an old copy is still in
// the tray (common after auto-update or accidental double-launch).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Auto-detect Dota path if not set
  let dotaPath = store.get('dotaPath');
  if (!dotaPath) {
    dotaPath = getDotaPath();
    if (dotaPath) {
      store.set('dotaPath', dotaPath);
      pushLog('info', `Auto-detected Dota at ${dotaPath}`);
    } else {
      pushLog('warn', 'Dota 2 not found. Open the window and select folder manually.');
    }
  }

  if (dotaPath) {
    const replaysPath = getReplaysPath(dotaPath);
    startWatcher(replaysPath, onNewReplay);
    stats.watcherActive = true;
  }

  startGSIServer(3000, onMatchEnd);
  stats.gsiActive = true;

  if (store.get('autoStart')) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  // Try retry pending uploads on startup (best-effort)
  if (store.get('apiToken')) {
    retryPending({
      apiUrl: store.get('apiUrl'),
      apiToken: store.get('apiToken'),
      log: (m) => pushLog('info', m),
    }).then((r) => {
      if (r.retried > 0) {
        pushLog('info', `Retry: ${r.succeeded} ok / ${r.failed} fail of ${r.retried}`);
      }
    });
  }

  // Check for app updates in the background. Runs once on startup; user can
  // re-trigger from UI. Skipped in dev (autoUpdater throws "not packaged").
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((e) => pushLog('warn', `update check failed: ${e.message}`));
  }
});

app.on('window-all-closed', () => {
  // keep running in tray
});

app.on('before-quit', () => {
  isQuitting = true;
  stopGSIServer();
  stopWatcher();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
