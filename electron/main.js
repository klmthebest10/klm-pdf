// KLM PDF — proses utama Electron (versi Windows .exe)
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const printHtml = require('./print-html');

const WEB_ROOT = path.join(__dirname, '..', 'web');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

let win = null;
let rendererReady = false;
let queued = [];          // file yang diminta dibuka sebelum jendela siap
let allowClose = false;

const isPdfPath = p => typeof p === 'string' && /\.pdf$/i.test(p) && !p.startsWith('-');
function pdfArgs(argv, cwd = process.cwd()) {
  return argv.slice(1).filter(isPdfPath).map(p => path.resolve(cwd, p)).filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
function sendOpen(files) {
  if (!files.length) return;
  if (win && rendererReady) win.webContents.send('open-files', files);
  else queued.push(...files);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  queued = pdfArgs(process.argv);

  // File PDF dibuka saat aplikasi sudah berjalan → buka di tab baru
  app.on('second-instance', (_e, argv, cwd) => {
    sendOpen(pdfArgs(argv, cwd));
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  // macOS (jika suatu saat dibangun untuk Mac)
  app.on('open-file', (e, p) => { e.preventDefault(); sendOpen([p]); });

  app.whenReady().then(() => {
    protocol.handle('app', req => {
      const url = new URL(req.url);
      let rel = decodeURIComponent(url.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(WEB_ROOT, rel));
      if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    // Aplikasi hanya memuat halamannya sendiri (app://), jadi izin untuk app:// diberikan:
    // huruf komputer (teks Korea/CJK), kamera (Scan dokumen), clipboard, layar penuh.
    const DENY = new Set(['geolocation', 'notifications', 'midi', 'midiSysex', 'openExternal', 'pointerLock', 'keyboardLock', 'display-capture', 'hid', 'serial', 'usb']);
    const fromApp = (wc, origin) => String(origin || wc?.getURL?.() || '').startsWith('app://');
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(fromApp(wc, details?.requestingUrl) && !DENY.has(perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => fromApp(wc, origin) && !DENY.has(perm));
    Menu.setApplicationMenu(null);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width || 1320, height: st.height || 860, x: st.x, y: st.y,
    minWidth: 760, minHeight: 520,
    title: 'KLM PDF',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f5',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://klm/index.html');

  // Tautan luar dibuka di browser default
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  // F12 = DevTools, Ctrl+R = muat ulang (untuk pemecahan masalah)
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('close', e => {
    saveState();
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('before-close');
    // jika renderer macet (tidak membalas sama sekali dalam 4 detik), tutup saja.
    // Renderer membalas 'close-ack' segera, lalu menunggu jawaban pengguna tanpa batas waktu.
    clearTimeout(win._closeT);
    win._closeT = setTimeout(() => { allowClose = true; win?.close(); }, 4000);
  });
  win.on('closed', () => { win = null; });
}

/* ---------- penyimpanan ukuran jendela ---------- */
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } }
function saveState() {
  if (!win) return;
  try { const b = win.getNormalBounds(); fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { }
}

/* ---------- IPC ---------- */
ipcMain.handle('renderer-ready', () => { rendererReady = true; const f = queued; queued = []; return f; });

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Buka PDF', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Dokumen PDF', extensions: ['pdf'] }, { name: 'Semua file', extensions: ['*'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map(p => ({ path: p, name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) }));
});

ipcMain.handle('read-file', (_e, p) => ({ path: p, name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) }));

ipcMain.handle('write-file', async (_e, p, data) => {
  // tulis ke file sementara dulu lalu ganti, agar file asli aman bila gagal di tengah jalan
  const tmp = p + '.klmtmp';
  await fs.promises.writeFile(tmp, Buffer.from(data));
  try { await fs.promises.rename(tmp, p); }
  catch { await fs.promises.copyFile(tmp, p); await fs.promises.unlink(tmp).catch(() => { }); }
  return true;
});

const FILTERS = {
  pdf: [{ name: 'Dokumen PDF', extensions: ['pdf'] }],
  zip: [{ name: 'Arsip ZIP', extensions: ['zip'] }],
  png: [{ name: 'Gambar PNG', extensions: ['png'] }],
  jpg: [{ name: 'Gambar JPG', extensions: ['jpg', 'jpeg'] }],
};
let lastDir = null;
ipcMain.handle('save-as', async (_e, name, data, kind = 'pdf') => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Simpan sebagai', defaultPath: path.join(lastDir || app.getPath('documents'), name), filters: FILTERS[kind] || FILTERS.pdf,
  });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, Buffer.from(data));
  lastDir = path.dirname(r.filePath);
  return r.filePath;
});

ipcMain.handle('open-default-apps', () => shell.openExternal('ms-settings:defaultapps'));
ipcMain.on('set-dirty', () => { /* status dipakai renderer saat menutup */ });
ipcMain.on('set-theme', (_e, t) => { if (win) win.setBackgroundColor(t === 'dark' ? '#1e1e1e' : '#f5f5f5'); });
ipcMain.on('close-ack', () => { if (win) clearTimeout(win._closeT); });
ipcMain.on('confirm-close', (_e, ok) => {
  if (!win) return;
  clearTimeout(win._closeT);
  if (ok) { allowClose = true; win.close(); }
});
ipcMain.handle('app-version', () => app.getVersion());

/* ---------- cetak ---------- */
// Renderer menyusun tiap lembar kertas menjadi gambar (persis seperti pratinjau),
// lalu di sini lembar-lembar itu dicetak lewat jendela tersembunyi.
const printJobs = new Map();
let jobSeq = 0;
ipcMain.handle('print-printers', async () => {
  if (!win) return [];
  const list = await win.webContents.getPrintersAsync();
  return list.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault, status: p.status, description: p.description || '' }));
});
ipcMain.handle('print-begin', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'klmpdf-print-'));
  const id = ++jobSeq; printJobs.set(id, { dir, files: [] });
  return id;
});
ipcMain.handle('print-add', async (_e, id, index, data) => {
  const job = printJobs.get(id); if (!job) throw new Error('Pekerjaan cetak tidak ditemukan');
  const name = `s${String(index).padStart(5, '0')}.jpg`;
  await fs.promises.writeFile(path.join(job.dir, name), Buffer.from(data));
  job.files[index] = name;
  return true;
});
async function cleanupJob(id) {
  const job = printJobs.get(id); if (!job) return;
  printJobs.delete(id);
  try { if (job.win && !job.win.isDestroyed()) job.win.destroy(); } catch { }
  setTimeout(() => fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => { }), 5000);
}
ipcMain.handle('print-cancel', (_e, id) => cleanupJob(id));
ipcMain.handle('print-run', async (_e, id, o) => {
  const job = printJobs.get(id); if (!job) throw new Error('Pekerjaan cetak tidak ditemukan');
  const files = job.files.filter(Boolean);
  if (!files.length) { await cleanupJob(id); throw new Error('Tidak ada lembar untuk dicetak'); }
  const html = printHtml(files, o.sheetW, o.sheetH, o.title);
  const file = path.join(job.dir, 'index.html');
  await fs.promises.writeFile(file, html, 'utf8');
  const pw = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  job.win = pw;
  try {
    await pw.loadFile(file);
    await pw.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.decode().catch(() => null))).then(() => document.images.length)');
    const opts = {
      silent: o.silent !== false, printBackground: true,
      color: o.color !== false,
      margins: { marginType: 'none' },
      landscape: !!o.landscape,
      pageSize: o.pageSizeName || { width: o.pageSizeMicrons.width, height: o.pageSizeMicrons.height },
      copies: Math.max(1, Math.min(999, o.copies | 0 || 1)),
      collate: o.collate !== false,
      duplexMode: ['simplex', 'longEdge', 'shortEdge'].includes(o.duplexMode) ? o.duplexMode : 'simplex',
      header: '', footer: '',
    };
    if (o.deviceName) opts.deviceName = o.deviceName;
    const res = await new Promise(resolve => {
      const t = setTimeout(() => resolve({ ok: false, reason: 'Printer tidak merespons (waktu habis)' }), 15 * 60 * 1000);
      try {
        pw.webContents.print(opts, (success, failureReason) => { clearTimeout(t); resolve({ ok: !!success, reason: success ? '' : (failureReason || 'gagal') }); });
      } catch (e) { clearTimeout(t); resolve({ ok: false, reason: e.message }); }
    });
    return res;
  } finally {
    // beri waktu spooler membaca data sebelum jendela ditutup
    setTimeout(() => cleanupJob(id), 3000);
  }
});
app.on('before-quit', () => { for (const id of [...printJobs.keys()]) cleanupJob(id); });
