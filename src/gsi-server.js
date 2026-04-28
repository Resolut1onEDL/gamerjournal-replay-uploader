/**
 * Dota 2 Game State Integration (GSI) Server
 * 
 * Listens for game state updates from Dota 2 client.
 * Detects match end events and triggers replay download.
 */

const express = require('express');

let server = null;
let lastMatchId = null;
let onMatchEndCallback = null;

/**
 * Start the GSI HTTP server
 * @param {number} port - Port to listen on (default 3000)
 * @param {function} onMatchEnd - Callback when match ends
 */
function startGSIServer(port = 3000, onMatchEnd) {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // GSI endpoint - Dota posts game state here
  app.post('/', (req, res) => {
    try {
      const gameState = req.body;
      processGameState(gameState);
      res.status(200).send('OK');
    } catch (error) {
      console.error('[GSI] Error processing game state:', error);
      res.status(200).send('OK'); // Always return 200 to Dota
    }
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', lastMatchId });
  });

  // Listen errors must NOT throw out of the process — Electron treats an
  // uncaught listen error (EADDRINUSE etc.) as a fatal main-process crash
  // and dies with a modal. Log it instead; the rest of the app still works
  // (file watcher + uploader don't depend on GSI).
  server = app.listen(port, '127.0.0.1', () => {
    console.log(`[GSI] Server listening on port ${port}`);
  });
  server.on('error', (err) => {
    console.error(`[GSI] listen failed on ${port}: ${err.message}`);
    server = null;
  });

  onMatchEndCallback = onMatchEnd;
}

/**
 * Process game state from Dota
 */
function processGameState(state) {
  if (!state) return;

  // Extract relevant info
  const map = state.map;
  const player = state.player;
  
  if (!map) return;

  const matchId = map.matchid;
  const gameState = map.game_state; // DOTA_GAMERULES_STATE_*
  const winTeam = map.win_team;

  // Log state changes
  console.log(`[GSI] Game state: ${gameState}, Match: ${matchId}, Win: ${winTeam}`);

  // Detect match end
  // DOTA_GAMERULES_STATE_POST_GAME = game ended
  if (gameState === 'DOTA_GAMERULES_STATE_POST_GAME' && matchId) {
    if (matchId !== lastMatchId) {
      lastMatchId = matchId;
      console.log(`[GSI] Match ended! ID: ${matchId}`);
      
      if (onMatchEndCallback) {
        onMatchEndCallback(matchId);
      }
    }
  }

  // Alternative: check for win_team being set (radiant/dire)
  if (winTeam && winTeam !== 'none' && matchId && matchId !== lastMatchId) {
    lastMatchId = matchId;
    console.log(`[GSI] Match ended via win_team! ID: ${matchId}, Winner: ${winTeam}`);
    
    if (onMatchEndCallback) {
      onMatchEndCallback(matchId);
    }
  }
}

/**
 * Stop the GSI server
 */
function stopGSIServer() {
  if (server) {
    server.close(() => {
      console.log('[GSI] Server stopped');
    });
    server = null;
  }
}

/**
 * Get the last detected match ID
 */
function getLastMatchId() {
  return lastMatchId;
}

module.exports = {
  startGSIServer,
  stopGSIServer,
  getLastMatchId
};
