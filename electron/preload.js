// Jembatan aman antara jendela aplikasi dan sistem file Windows
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('klmNative', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke('renderer-ready'),
  onOpenFiles: cb => ipcRenderer.on('open-files', (_e, files) => cb(files)),
  onBeforeClose: cb => ipcRenderer.on('before-close', () => { ipcRenderer.send('close-ack'); cb(); }),
  confirmClose: ok => ipcRenderer.send('confirm-close', !!ok),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  readFile: p => ipcRenderer.invoke('read-file', p),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  saveAs: (name, data, kind) => ipcRenderer.invoke('save-as', name, data, kind),
  setDirty: d => ipcRenderer.send('set-dirty', !!d),
  setTheme: t => ipcRenderer.send('set-theme', t),
  openDefaultApps: () => ipcRenderer.invoke('open-default-apps'),
  getPathForFile: f => { try { return webUtils.getPathForFile(f); } catch { return null; } },
  version: () => ipcRenderer.invoke('app-version'),
  getPrinters: () => ipcRenderer.invoke('print-printers'),
  printBegin: () => ipcRenderer.invoke('print-begin'),
  printAdd: (id, index, data) => ipcRenderer.invoke('print-add', id, index, data),
  printRun: (id, opts) => ipcRenderer.invoke('print-run', id, opts),
  printCancel: id => ipcRenderer.invoke('print-cancel', id),
});
