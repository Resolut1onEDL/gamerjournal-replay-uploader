const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  selectDotaFolder: () => ipcRenderer.invoke('select-dota-folder'),
  installGsi: () => ipcRenderer.invoke('install-gsi'),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  retryPending: () => ipcRenderer.invoke('retry-pending'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  reparseFile: (filePath) => ipcRenderer.invoke('reparse-file', filePath),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  // events: subscribe to push updates
  onEvent: (cb) => {
    ipcRenderer.on('app-event', (_, payload) => cb(payload));
  },
});
