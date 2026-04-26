/**
 * Replay File Watcher
 * 
 * Monitors the Dota 2 replays folder for new .dem files
 */

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

let watcher = null;
let onNewReplayCallback = null;
let processedFiles = new Set();

/**
 * Start watching a directory for new replay files
 * @param {string} replaysPath - Path to Dota 2 replays folder
 * @param {function} onNewReplay - Callback when new replay detected
 */
function startWatcher(replaysPath, onNewReplay) {
  if (watcher) {
    stopWatcher();
  }

  // Check if path exists
  if (!fs.existsSync(replaysPath)) {
    console.log(`[Watcher] Creating replays directory: ${replaysPath}`);
    try {
      fs.mkdirSync(replaysPath, { recursive: true });
    } catch (error) {
      console.error(`[Watcher] Failed to create directory:`, error);
    }
  }

  console.log(`[Watcher] Starting to watch: ${replaysPath}`);

  watcher = chokidar.watch(replaysPath, {
    persistent: true,
    ignoreInitial: true, // Don't process existing files
    awaitWriteFinish: {
      stabilityThreshold: 5000, // Wait 5s after last write
      pollInterval: 1000
    },
    depth: 0 // Only watch top level
  });

  onNewReplayCallback = onNewReplay;

  watcher.on('add', (filePath) => {
    handleNewFile(filePath);
  });

  watcher.on('change', (filePath) => {
    // File might still be downloading
    console.log(`[Watcher] File changed: ${filePath}`);
  });

  watcher.on('error', (error) => {
    console.error(`[Watcher] Error:`, error);
  });

  watcher.on('ready', () => {
    console.log(`[Watcher] Ready and watching for new replays`);
  });
}

/**
 * Handle a new file in the replays directory
 */
function handleNewFile(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // Only process .dem files
  if (ext !== '.dem') {
    console.log(`[Watcher] Ignoring non-replay file: ${fileName}`);
    return;
  }

  // Check if already processed
  if (processedFiles.has(filePath)) {
    console.log(`[Watcher] Already processed: ${fileName}`);
    return;
  }

  // Extract match ID from filename (format: matchid_replaykey.dem)
  const matchId = extractMatchId(fileName);

  console.log(`[Watcher] New replay detected: ${fileName}, matchId: ${matchId}`);

  // Mark as processed
  processedFiles.add(filePath);

  // Callback
  if (onNewReplayCallback) {
    onNewReplayCallback(filePath, matchId);
  }
}

/**
 * Extract match ID from replay filename
 * Replay filenames are typically: <match_id>_<replay_salt>.dem
 */
function extractMatchId(fileName) {
  // Remove extension
  const baseName = fileName.replace('.dem', '');
  
  // Split by underscore - first part is match ID
  const parts = baseName.split('_');
  
  if (parts.length >= 1) {
    const matchId = parts[0];
    // Validate it's a number
    if (/^\d+$/.test(matchId)) {
      return matchId;
    }
  }

  return null;
}

/**
 * Stop the file watcher
 */
function stopWatcher() {
  if (watcher) {
    watcher.close().then(() => {
      console.log('[Watcher] Stopped');
    });
    watcher = null;
  }
}

/**
 * Clear the processed files cache
 */
function clearProcessedFiles() {
  processedFiles.clear();
}

/**
 * Check if watcher is active
 */
function isWatching() {
  return watcher !== null;
}

module.exports = {
  startWatcher,
  stopWatcher,
  clearProcessedFiles,
  isWatching
};
