/* =====================================================================
   KLM PDF — pembaca & editor PDF
   Render: PDF.js · Simpan/edit: pdf-lib · ZIP: JSZip
   ===================================================================== */
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { loadPdfLib, encryptPdfDoc } from './pdfcrypt.js';
import { parseFont, FontRegistry } from './ttf.js';
import { removeTextInRects } from './redact.js';
import { openScanner, wireScanner } from './scan.js';
import { openPrintDialog, wirePrintDialog } from './print.js';

const APP_VERSION = '1.3.0';
const LIB = new URL('../lib/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.mjs';
const PDFJS_OPTS = {
  cMapUrl: LIB + 'cmaps/', cMapPacked: true,
  standardFontDataUrl: LIB + 'standard_fonts/',
  wasmUrl: LIB + 'wasm/', iccUrl: LIB + 'iccs/',
  isEvalSupported: false,
};
const PL = window.PDFLib;
/* PDF.js v6: PDFDocumentProxy.destroy() dihapus → tutup lewat loadingTask */
function closePdf(pdf) {
  if (!pdf) return;
  try { const t = pdf.loadingTask; if (t?.destroy) { t.destroy().catch?.(() => { }); return; } } catch { }
  try { pdf.destroy?.()?.catch?.(() => { }); } catch { }
}
const native = window.klmNative || null;
const IS_NATIVE = !!native;

/* ------------------------------ helpers ------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const r2 = n => Math.round(n * 100) / 100;
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function hexToRgb01(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
const pdfColor = hex => PL.rgb(...hexToRgb01(hex));
const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const baseName = p => String(p).split(/[\\/]/).pop();
const stripExt = n => n.replace(/\.pdf$/i, '');
function fmtBytes(b) { if (!b && b !== 0) return '-'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + u[i]; }
function fmtDate(d) { try { return new Date(d).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } }
function todayStr() { const d = new Date(); return [d.getDate(), d.getMonth() + 1, d.getFullYear()].map(n => String(n).padStart(2, '0')).join('/'); }
function parseRanges(str, max) {
  const out = [];
  for (const part of String(str).split(/[,;]+/)) {
    const s = part.trim(); if (!s) continue;
    const m = s.match(/^(\d+)\s*(?:-\s*(\d*))?$/);
    if (!m) throw new Error('Format rentang tidak valid: ' + s);
    let a = +m[1], b = m[2] === undefined ? a : (m[2] === '' ? max : +m[2]);
    if (a > b) [a, b] = [b, a];
    const grp = [];
    for (let i = a; i <= b; i++) if (i >= 1 && i <= max) grp.push(i - 1);
    if (grp.length) out.push(grp);
  }
  return out;
}

/* matrix: [a,b,c,d,e,f]; x' = a x + c y + e ; y' = b x + d y + f */
const mApply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function mChain(f, s) { // apply f first, then s
  return [f[0] * s[0] + f[1] * s[2], f[0] * s[1] + f[1] * s[3], f[2] * s[0] + f[3] * s[2], f[2] * s[1] + f[3] * s[3],
    f[4] * s[0] + f[5] * s[2] + s[4], f[4] * s[1] + f[5] * s[3] + s[5]];
}
function mInv(m) {
  const [a, b, c, d, e, f] = m, det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
/* Sama seperti PageViewport PDF.js — PDF user space → layar (y ke bawah). */
function vpTransform(view, rotation, scale = 1) {
  const cx = (view[2] + view[0]) / 2, cy = (view[3] + view[1]) / 2;
  let A, B, C, D;
  rotation = ((rotation % 360) + 360) % 360;
  switch (rotation) {
    case 180: A = -1; B = 0; C = 0; D = 1; break;
    case 90: A = 0; B = 1; C = 1; D = 0; break;
    case 270: A = 0; B = -1; C = -1; D = 0; break;
    default: A = 1; B = 0; C = 0; D = -1;
  }
  let ox, oy;
  if (A === 0) { ox = Math.abs(cy - view[1]) * scale; oy = Math.abs(cx - view[0]) * scale; }
  else { ox = Math.abs(cx - view[0]) * scale; oy = Math.abs(cy - view[1]) * scale; }
  return [A * scale, B * scale, C * scale, D * scale, ox - A * scale * cx - C * scale * cy, oy - B * scale * cx - D * scale * cy];
}
function dims(p) {
  const total = (((p.baseRot + p.rot) % 360) + 360) % 360;
  const w0 = p.view[2] - p.view[0], h0 = p.view[3] - p.view[1];
  return total % 180 ? { W: h0, H: w0, total } : { W: w0, H: h0, total };
}

/* ------------------------------ UI basics ------------------------------ */
function toast(msg, type = '', ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, ms);
}
let busyDepth = 0;
function busy(text) {
  if (text === false) { busyDepth = Math.max(0, busyDepth - 1); if (!busyDepth) $('#busy').hidden = true; return; }
  busyDepth++; $('#busyText').textContent = text || 'Memproses…'; $('#busy').hidden = false;
}
const busyText = t => { $('#busyText').textContent = t; };
async function withBusy(text, fn) { busy(text); await sleep(30); try { return await fn(); } finally { busy(false); } }

function showDlg(d) { if (typeof d === 'string') d = $(d); if (!d.open) { d.returnValue = 'cancel'; d.showModal(); } return d; }
function safeShow(d) { if (d.open) d.close('cancel'); d.returnValue = 'cancel'; d.showModal(); }
function confirmDialog(title, msg, buttons = [{ v: 'cancel', t: 'Batal' }, { v: 'ok', t: 'OK', primary: true }]) {
  const d = $('#dlgConfirm');
  $('#cfTitle').textContent = title; $('#cfMsg').textContent = msg;
  $('#cfBtns').innerHTML = buttons.map(b => `<button value="${b.v}" class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}">${esc(b.t)}</button>`).join('');
  safeShow(d);
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue || 'cancel'), { once: true }));
}
function promptDialog(title, label, value = '', { type = 'text', multiline = false, okText = 'OK' } = {}) {
  const d = $('#dlgPrompt');
  $('#pfTitle').textContent = title; $('#pfLabel').textContent = label;
  const inp = $('#pfInput'), area = $('#pfArea');
  inp.parentElement.hidden = multiline; area.hidden = !multiline;
  inp.type = type; inp.value = multiline ? '' : value; area.value = multiline ? value : '';
  $('#pfOk').textContent = okText;
  safeShow(d);
  setTimeout(() => (multiline ? area : inp).focus(), 30);
  if (!multiline) inp.select();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok' ? (multiline ? area.value : inp.value) : null), { once: true }));
}
function openDialog(id) {
  const d = $(id); safeShow(d);
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue), { once: true }));
}

/* ------------------------------ state ------------------------------ */
const TOOL_DEFAULTS = {
  text: { font: 'helv', size: 14, color: '#000000', bold: false, italic: false, bg: null, opacity: 1 },
  pen: { color: '#d7373f', width: 2.5, opacity: 1 },
  highlight: { color: '#ffeb3b', opacity: 0.4 },
  underline: { color: '#1473e6', width: 1.5, opacity: 1 },
  strike: { color: '#d7373f', width: 1.5, opacity: 1 },
  rect: { stroke: '#d7373f', fill: null, width: 2, opacity: 1 },
  ellipse: { stroke: '#d7373f', fill: null, width: 2, opacity: 1 },
  line: { stroke: '#d7373f', width: 2, opacity: 1 },
  arrow: { stroke: '#d7373f', width: 2, opacity: 1 },
  whiteout: { fill: '#ffffff' },
  note: { color: '#ffd400' },
  image: { opacity: 1 },
  watermark: { color: '#c0262d', opacity: 0.2, size: 72, angle: 45 },
};
const S = {
  docs: [], curId: null,
  tool: 'select',
  opts: loadOpts(),
  sel: null,            // { uid, id }
  pageSel: new Set(),   // selected page uids (thumbnails / organizer)
  placing: null,        // { kind, img, w, h, text }
  clipboard: null,
  search: null,
  organize: false,
  spaceDown: false,
  sidebarOpen: localStorage.getItem('klmpdf.sidebar') !== '0',
  panelOpen: localStorage.getItem('klmpdf.panel') !== '0' && innerWidth > 900,
};
function loadOpts() {
  const o = structuredClone(TOOL_DEFAULTS);
  try { const s = JSON.parse(localStorage.getItem('klmpdf.opts') || '{}'); for (const k in s) if (o[k]) Object.assign(o[k], s[k]); } catch { }
  return o;
}
const saveOpts = debounce(() => { try { localStorage.setItem('klmpdf.opts', JSON.stringify(S.opts)); } catch { } }, 400);
const cur = () => S.docs.find(d => d.id === S.curId) || null;
const pageByUid = (doc, u) => doc.pages.find(p => p.uid === u);
const pageIndex = (doc, u) => doc.pages.findIndex(p => p.uid === u);

/* ------------------------------ fonts ------------------------------ */
const CSS_FALLBACK = '"Segoe UI", "Malgun Gothic", "Microsoft YaHei", "Yu Gothic", "Meiryo", "Segoe UI Symbol", "Noto Sans", "Noto Sans CJK KR", "WenQuanYi Zen Hei"';
const FONTS = {
  helv: { label: 'Helvetica / Arial', css: `Helvetica, Arial, "Liberation Sans", ${CSS_FALLBACK}, sans-serif`, std: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'] },
  times: { label: 'Times New Roman', css: `"Times New Roman", Times, "Liberation Serif", ${CSS_FALLBACK}, serif`, std: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'] },
  cour: { label: 'Courier', css: `"Courier New", Courier, "Liberation Mono", ${CSS_FALLBACK}, monospace`, std: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] },
};
const familyCss = a => a.font === 'sys' && a.family ? `"${String(a.family).replace(/["\\]/g, '')}", ${FONTS.helv.css}` : (FONTS[a.font] || FONTS.helv).css;
const LH = 1.2, PAD = 2, ASC = 0.9;
const fontCss = (a, px) => `${a.italic ? 'italic ' : ''}${a.bold ? '700 ' : '400 '}${px}px ${familyCss(a)}`;
const mctx = document.createElement('canvas').getContext('2d');
try { mctx.fontKerning = 'none'; } catch { }
function measureText(a) {
  mctx.font = fontCss(a, a.size);
  const lines = String(a.text ?? '').split('\n');
  const w = Math.max(...lines.map(l => mctx.measureText(l).width), a.size * 0.3);
  a.w = Math.max(w + PAD * 2, a.minW || 0);
  a.h = Math.max(lines.length * a.size * LH + PAD * 2, a.minH || 0);
}

/* =====================================================================
   OPEN DOCUMENTS
   ===================================================================== */
async function loadSource(doc, bytes, label = '') {
  let password, restored = null;
  try { restored = await extractKlmData(bytes); } catch (e) { console.warn('KLM data', e); }
  if (restored) { bytes = restored.bytes; Object.assign(doc.assets, restored.assets); }
  for (; ;) {
    try {
      let pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice(), password }).promise;
      let openPassword = password;
      if (!restored && password && hasKlmMark(bytes)) {
        try { restored = await extractKlmData(bytes, password); } catch { }
        if (restored) {
          bytes = restored.bytes; Object.assign(doc.assets, restored.assets);
          closePdf(pdf);
          pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise; password = undefined;
        }
      }
      const id = uid();
      doc.sources[id] = { id, bytes, pdf, password, openPassword, ver: 0, pages: {}, name: label, restored: restored?.pages || null };
      return doc.sources[id];
    } catch (e) {
      if (e?.name === 'PasswordException') {
        busy(false);
        password = await promptDialog(e.code === 2 ? 'Kata sandi salah' : 'PDF dilindungi kata sandi',
          `Masukkan kata sandi untuk membuka ${label || 'file ini'}:`, '', { type: 'password', okText: 'Buka' });
        busy('Membuka…');
        if (password == null) return null;
        continue;
      }
      throw e;
    }
  }
}
async function pagesFromSource(src, indices) {
  const out = [];
  const list = indices || [...Array(src.pdf.numPages).keys()];
  for (const i of list) {
    const pg = await getPdfPage(src, i);
    const annots = (src.restored?.get(i) || []).map(a => ({ ...a, id: uid() }));
    out.push({ uid: uid(), src: src.id, idx: i, rot: 0, baseRot: pg.rotate || 0, view: [...pg.view], annots });
  }
  return out;
}
function getPdfPage(src, idx) { return (src.pages[idx] ||= src.pdf.getPage(idx + 1)); }

function newDocObj(name, meta = {}) {
  return {
    id: uid(), name: name || 'Dokumen.pdf', handle: meta.handle || null, path: meta.path || null,
    dirty: !!meta.dirty, sources: {}, primary: null, pages: [], assets: {},
    scale: 1, zoomMode: 'fit-width', history: [], future: [], meta: null, info: null, size: 0,
    curPage: 0, scrollTop: 0, textCache: {},
  };
}

async function openPdfBytes(bytes, name, meta = {}) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Sudah terbuka? pindah ke tab itu
  if (meta.path) { const ex = S.docs.find(d => d.path && d.path === meta.path); if (ex) { switchDoc(ex.id); return ex; } }
  if (meta.handle?.isSameEntry) {
    for (const ex of S.docs) { try { if (ex.handle && await meta.handle.isSameEntry(ex.handle)) { switchDoc(ex.id); toast('File ini sudah terbuka'); return ex; } } catch { } }
  }
  const doc = newDocObj(name, meta);
  busy('Membuka ' + name + '…');
  try {
    const src = await loadSource(doc, bytes, name);
    if (!src) return null;
    doc.primary = src.id;
    doc.size = bytes.length;
    if (src.openPassword) { doc.protect = { userPassword: src.openPassword, ownerPassword: src.openPassword, permissions: {} }; setTimeout(() => toast('Dokumen berkata sandi — saat disimpan, kata sandinya tetap dipakai (ubah di Berkas → Kata sandi & keamanan)', '', 5500), 600); }
    doc.pages = await pagesFromSource(src);
    try { const md = await src.pdf.getMetadata(); doc.info = md?.info || {}; } catch { doc.info = {}; }
    S.docs.push(doc);
    switchDoc(doc.id);
    if (!meta.noRecent) addRecent(doc, src).catch(() => { });
    return doc;
  } catch (e) {
    console.error(e);
    toast('Gagal membuka ' + name + ': ' + (e?.message || e), 'err', 5000);
    return null;
  } finally { busy(false); }
}

async function openFiles(fileList) {
  const files = [...fileList];
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const imgs = files.filter(f => f.type?.startsWith('image/'));
  for (const f of pdfs) {
    let path = null, handle = null;
    if (f.handle) handle = f.handle;
    if (IS_NATIVE) { try { path = native.getPathForFile(f) || null; } catch { } }
    await openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name, { path, handle });
  }
  if (imgs.length) {
    const d = cur();
    if (d && !S.organize && !pdfs.length) { for (const f of imgs) await placeImageFile(f); }
    else await imagesToPdf(imgs);
  }
  if (!pdfs.length && !imgs.length && files.length) toast('Format file tidak didukung', 'err');
}

async function cmdOpen() {
  if (IS_NATIVE) {
    const res = await native.openDialog();
    for (const f of res || []) await openPdfBytes(f.data, f.name, { path: f.path });
    return;
  }
  if (window.showOpenFilePicker) {
    try {
      const hs = await showOpenFilePicker({ multiple: true, types: [{ description: 'Dokumen PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      for (const h of hs) { const f = await h.getFile(); await openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name, { handle: h }); }
    } catch (e) { if (e?.name !== 'AbortError') toast(e.message, 'err'); }
    return;
  }
  pickFiles('#filePdf').then(fs => fs && openFiles(fs));
}
function pickFiles(sel) {
  const inp = $(sel); inp.value = '';
  return new Promise(res => {
    const done = () => { window.removeEventListener('focus', onF); res(inp.files?.length ? [...inp.files] : null); };
    const onF = () => setTimeout(() => { if (!inp.files?.length) { inp.removeEventListener('change', done); res(null); } }, 600);
    inp.addEventListener('change', done, { once: true });
    inp.addEventListener('cancel', () => { inp.removeEventListener('change', done); window.removeEventListener('focus', onF); res(null); }, { once: true });
    window.addEventListener('focus', onF, { once: true });
    inp.click();
  });
}

/* ------------------------------ new docs ------------------------------ */
async function blankPdfBytes(w = 595.28, h = 841.89, n = 1) {
  const d = await PL.PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([w, h]);
  return d.save();
}
async function cmdNewBlank() {
  const bytes = await blankPdfBytes();
  await openPdfBytes(bytes, 'Dokumen baru.pdf', { dirty: true, noRecent: true });
}
async function imageToPngBytes(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return { bytes: await new Promise(r => c.toBlob(b => b.arrayBuffer().then(x => r(new Uint8Array(x))), 'image/png')), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Gambar tidak bisa dibaca')); i.src = src; }); }
async function imagesToPdf(files) {
  if (!files) files = await pickFiles('#fileImg');
  if (!files?.length) return;
  await withBusy('Membuat PDF dari gambar…', async () => {
    const d = await PL.PDFDocument.create();
    for (const f of files) {
      let img;
      const buf = new Uint8Array(await f.arrayBuffer());
      if (f.type === 'image/jpeg') img = await d.embedJpg(buf);
      else if (f.type === 'image/png') img = await d.embedPng(buf);
      else { const r = await imageToPngBytes(f); img = await d.embedPng(r.bytes); }
      // Pas ke A4 dengan margin, orientasi menyesuaikan gambar
      const land = img.width > img.height;
      const [PW, PH] = land ? [841.89, 595.28] : [595.28, 841.89];
      const m = 28, k = Math.min((PW - m * 2) / img.width, (PH - m * 2) / img.height, 1.5);
      const w = img.width * k, h = img.height * k;
      const pg = d.addPage([PW, PH]);
      pg.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
    }
    const bytes = await d.save();
    await openPdfBytes(bytes, files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') + '.pdf' : 'Gambar.pdf', { dirty: true, noRecent: true });
  });
}
async function cmdMerge() {
  let files;
  if (IS_NATIVE) {
    const res = await native.openDialog();
    if (!res?.length) return;
    files = res.map(r => ({ name: r.name, bytes: r.data }));
  } else {
    const fs = await pickFiles('#filePdf');
    if (!fs?.length) return;
    files = await Promise.all(fs.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  }
  files = files.filter(f => /\.pdf$/i.test(f.name));
  if (files.length < 1) return;
  const doc = newDocObj('Gabungan.pdf', { dirty: true });
  await withBusy('Menggabungkan…', async () => {
    for (const f of files) {
      const src = await loadSource(doc, f.bytes, f.name);
      if (!src) continue;
      if (!doc.primary) doc.primary = src.id;
      doc.pages.push(...await pagesFromSource(src));
    }
  });
  if (!doc.pages.length) return;
  doc.info = {};
  S.docs.push(doc); switchDoc(doc.id);
  toast(`${files.length} file digabung · ${doc.pages.length} halaman. Simpan untuk menyimpan hasilnya.`, 'ok', 4000);
}

/* =====================================================================
   TABS & VIEW SWITCHING
   ===================================================================== */
function renderTabs() {
  const t = $('#tabs');
  t.innerHTML = `<button class="tab home-tab ${S.curId ? '' : 'on'}" data-tab="home" title="Beranda">${icon('home')}</button>` +
    S.docs.map(d => `<div class="tab ${d.id === S.curId ? 'on' : ''} ${d.dirty ? 'dirty' : ''}" data-tab="${d.id}" title="${esc(d.path || d.name)}">
      <span class="dot"></span><span class="tname">${esc(d.name)}</span>
      <span class="tclose" data-close="${d.id}" title="Tutup">${icon('x')}</span></div>`).join('');
  document.title = (cur() ? (cur().dirty ? '• ' : '') + cur().name + ' — ' : '') + 'KLM PDF';
  native?.setDirty?.(S.docs.some(d => d.dirty));
}
$('#tabs').addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) { e.stopPropagation(); closeDoc(c.dataset.close); return; }
  const t = e.target.closest('[data-tab]');
  if (!t) return;
  if (t.dataset.tab === 'home') showHome(); else switchDoc(t.dataset.tab);
});
$('#tabs').addEventListener('auxclick', e => { const t = e.target.closest('[data-tab]'); if (e.button === 1 && t && t.dataset.tab !== 'home') closeDoc(t.dataset.tab); });

function saveViewState() { const d = cur(); if (d) { d.scrollTop = viewer.scrollTop; d.scrollLeft = viewer.scrollLeft; } }
function showHome() {
  saveViewState(); endTextEdit(); closeSearch(true);
  S.curId = null; S.sel = null;
  $('#home').hidden = false; $('#docview').hidden = true; $('#toolbar').hidden = true;
  renderTabs(); renderRecent(); updateStatus(); updateMenus();
}
function switchDoc(id) {
  if (S.curId && S.curId !== id) saveViewState();
  endTextEdit(); closeSearch(true);
  S.curId = id; S.sel = null; S.pageSel.clear(); $('#stSel').textContent = ''; S.placing = null; $('#placebar').hidden = true;
  if (S.organize) { S.organize = false; $('#organizer').hidden = true; }
  $('#home').hidden = true; $('#docview').hidden = false; $('#toolbar').hidden = false;
  const d = cur();
  renderTabs();
  applyPanels();
  buildViewer(true);
  buildThumbs();
  buildOutline();
  renderAnnotList();
  renderProps();
  updateMenus();
  setTool(S.tool);
  viewer.focus({ preventScroll: true });
}
async function closeDoc(id) {
  const d = S.docs.find(x => x.id === id); if (!d) return;
  if (d.dirty) {
    if (S.curId !== id) switchDoc(id);
    const r = await confirmDialog('Simpan perubahan?', `"${d.name}" memiliki perubahan yang belum disimpan.`,
      [{ v: 'cancel', t: 'Batal' }, { v: 'discard', t: 'Jangan simpan', danger: true }, { v: 'save', t: 'Simpan', primary: true }]);
    if (r === 'cancel') return;
    if (r === 'save' && !(await saveDoc(d))) return;
  }
  const i = S.docs.indexOf(d);
  S.docs.splice(i, 1);
  for (const s of Object.values(d.sources)) { closePdf(s.pdf); }
  if (S.curId === id) {
    S.curId = null;
    const next = S.docs[i] || S.docs[i - 1];
    if (next) switchDoc(next.id); else showHome();
  } else renderTabs();
}
function markDirty(d = cur()) {
  if (!d) return;
  d.dirty = true;
  renderTabs(); updateUndoButtons(); updateStatus();
}
function updateMenus() {
  const has = !!cur();
  $$('.menu-pop [data-doc]').forEach(b => b.disabled = !has);
}

/* =====================================================================
   UNDO / REDO
   ===================================================================== */
const snapshot = (d = cur()) => JSON.stringify(d.pages);
function pushUndoSnap(snap, d = cur()) {
  d.history.push(snap); if (d.history.length > 80) d.history.shift();
  d.future = []; markDirty(d);
}
const pushUndo = (d = cur()) => pushUndoSnap(snapshot(d), d);
function restore(d, json) {
  const sameStructure = JSON.stringify(d.pages.map(p => [p.uid, p.rot])) === JSON.stringify(JSON.parse(json).map(p => [p.uid, p.rot]));
  d.pages = JSON.parse(json);
  S.sel = null;
  if (sameStructure) { d.pages.forEach(p => renderAnnots(p)); refreshAllThumbs(); }
  else { buildViewer(); buildThumbs(); if (S.organize) buildOrganizer(); }
  renderAnnotList(); renderProps(); markDirty(d);
}
function undo() { const d = cur(); if (!d?.history.length) return; endTextEdit(); d.future.push(snapshot(d)); restore(d, d.history.pop()); }
function redo() { const d = cur(); if (!d?.future.length) return; endTextEdit(); d.history.push(snapshot(d)); restore(d, d.future.pop()); }
function updateUndoButtons() { const d = cur(); $('#btnUndo').disabled = !d?.history.length; $('#btnRedo').disabled = !d?.future.length; }

/* =====================================================================
   VIEWER
   ===================================================================== */
const viewer = $('#viewer');
const pageEls = new Map(); // uid -> info
let pagesBox = null;
const visible = new Set();
const io = new IntersectionObserver(entries => {
  for (const en of entries) {
    const u = en.target.dataset.uid;
    if (en.isIntersecting) { visible.add(u); queueRender(u); }
    else { visible.delete(u); releasePage(u); }
  }
}, { root: viewer, rootMargin: '900px 0px' });

function buildViewer(restoreScroll = false) {
  const d = cur(); if (!d) return;
  io.disconnect(); visible.clear();
  for (const info of pageEls.values()) { try { info.task?.cancel(); } catch { } }
  pageEls.clear();
  viewer.innerHTML = '';
  pagesBox = document.createElement('div'); pagesBox.className = 'pages';
  viewer.append(pagesBox);
  d.pages.forEach((p, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page'; wrap.dataset.uid = p.uid;
    wrap.innerHTML = `<div class="loading">Memuat…</div><canvas class="pc"></canvas><div class="textLayer"></div><div class="search-layer"></div><svg class="annots" xmlns="http://www.w3.org/2000/svg"></svg><div class="edit-layer"></div><div class="capture"></div><span class="pnum">${i + 1}</span>`;
    pagesBox.append(wrap);
    const info = { wrap, canvas: $('canvas', wrap), text: $('.textLayer', wrap), searchL: $('.search-layer', wrap), svg: $('svg', wrap), edit: $('.edit-layer', wrap), key: null, textKey: null, task: null };
    pageEls.set(p.uid, info);
    layoutPage(p);
    renderAnnots(p);
    io.observe(wrap);
  });
  $('#pageCount').textContent = d.pages.length;
  if (d.zoomMode) d.scale = computeFit(d.zoomMode);
  relayout();
  if (restoreScroll) { viewer.scrollTop = d.scrollTop || 0; viewer.scrollLeft = d.scrollLeft || 0; }
  updateZoomUI(); onScroll.force = true; onScroll();
}
function layoutPage(p) {
  const d = cur(), info = pageEls.get(p.uid); if (!info) return;
  const { W, H } = dims(p);
  info.wrap.style.width = Math.floor(W * d.scale) + 'px';
  info.wrap.style.height = Math.floor(H * d.scale) + 'px';
  info.wrap.style.setProperty('--total-scale-factor', d.scale);
  info.wrap.style.setProperty('--scale-round-x', '1px');
  info.wrap.style.setProperty('--scale-round-y', '1px');
  info.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
}
function relayout() { const d = cur(); if (!d) return; d.pages.forEach(layoutPage); for (const u of visible) queueRender(u); }

let renderQ = [], rendering = 0;
function queueRender(u) { if (!renderQ.includes(u)) renderQ.push(u); pumpRender(); }
function pumpRender() {
  while (rendering < 2 && renderQ.length) {
    const u = renderQ.shift();
    if (!visible.has(u)) continue;
    rendering++;
    renderPage(u).catch(e => { if (e?.name !== 'RenderingCancelledException') console.warn(e); }).finally(() => { rendering--; pumpRender(); });
  }
}
function releasePage(u) {
  const info = pageEls.get(u); if (!info || !info.key) return;
  try { info.task?.cancel(); } catch { }
  info.canvas.width = 0; info.canvas.height = 0; info.key = null;
  info.wrap.querySelector('.loading')?.removeAttribute('hidden');
}
async function renderPage(u) {
  const d = cur(); if (!d) return;
  const p = pageByUid(d, u), info = pageEls.get(u); if (!p || !info) return;
  const src = d.sources[p.src];
  const { total } = dims(p);
  const key = `${d.scale}|${total}|${p.src}|${p.idx}|${src.ver}`;
  if (info.key === key) return;
  const pg = await getPdfPage(src, p.idx);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let k = d.scale * dpr;
  const base = pg.getViewport({ scale: 1, rotation: total });
  const maxPx = 16e6; if (base.width * base.height * k * k > maxPx) k = Math.sqrt(maxPx / (base.width * base.height));
  const vp = pg.getViewport({ scale: k, rotation: total });
  const tmp = document.createElement('canvas');
  tmp.width = Math.floor(vp.width); tmp.height = Math.floor(vp.height);
  try { info.task?.cancel(); } catch { }
  const task = pg.render({ canvasContext: tmp.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE });
  info.task = task;
  await task.promise;
  if (info.task !== task || !pageEls.has(u)) return;
  // tukar kanvas (tanpa kedip)
  info.canvas.width = tmp.width; info.canvas.height = tmp.height;
  info.canvas.getContext('2d').drawImage(tmp, 0, 0);
  info.key = key;
  info.wrap.querySelector('.loading')?.setAttribute('hidden', '');
  // text layer
  const tkey = `${d.scale}|${total}|${p.src}|${p.idx}|${src.ver}`;
  if (info.textKey !== tkey) {
    info.textKey = tkey;
    info.text.innerHTML = '';
    try {
      const tc = await getText(d, p);
      const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: info.text, viewport: pg.getViewport({ scale: d.scale, rotation: total }) });
      await tl.render();
      const eoc = document.createElement('div'); eoc.className = 'endOfContent'; info.text.append(eoc);
    } catch (e) { console.warn('textlayer', e); }
  }
  if (S.tool === 'edittext') buildEditLayer(p);
  if (S.search) paintSearch(p);
}
function getText(d, p) {
  const src = d.sources[p.src];
  const k = `${p.src}:${p.idx}:${src.ver}`;
  return (d.textCache[k] ||= getPdfPage(src, p.idx).then(pg => pg.getTextContent()));
}

/* ------------------------------ zoom ------------------------------ */
function computeFit(mode) {
  const d = cur(); if (!d?.pages.length) return 1;
  const cw = viewer.clientWidth - 52, ch = viewer.clientHeight - 44;
  const p = d.pages[clamp(d.curPage, 0, d.pages.length - 1)];
  const { W, H } = dims(p);
  if (mode === 'fit-page') return clamp(Math.min(cw / W, ch / H), 0.1, 6);
  const maxW = Math.max(...d.pages.slice(0, 50).map(x => dims(x).W));
  return clamp(cw / maxW, 0.1, 6);
}
function setScale(s, mode = null, anchor = null) {
  const d = cur(); if (!d) return;
  s = clamp(s, 0.1, 6);
  const vr = viewer.getBoundingClientRect();
  const ax = anchor ? anchor.x : vr.left + vr.width / 2, ay = anchor ? anchor.y : vr.top + vr.height / 2;
  // cari halaman di titik jangkar
  let ref = null;
  for (const [u, info] of pageEls) {
    const r = info.wrap.getBoundingClientRect();
    if (ay >= r.top - 8 && ay <= r.bottom + 8) { ref = { u, rx: (ax - r.left) / d.scale, ry: (ay - r.top) / d.scale }; break; }
  }
  d.scale = s; d.zoomMode = mode;
  relayout();
  if (ref) {
    const info = pageEls.get(ref.u);
    viewer.scrollTop = info.wrap.offsetTop + ref.ry * s - (ay - vr.top);
    viewer.scrollLeft = info.wrap.offsetLeft + ref.rx * s - (ax - vr.left);
  }
  updateZoomUI(); repositionEditor();
}
function zoomStep(dir, anchor) {
  const d = cur(); if (!d) return;
  const steps = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
  let s = d.scale;
  if (dir > 0) s = steps.find(x => x > s + 0.001) ?? 6; else s = [...steps].reverse().find(x => x < s - 0.001) ?? 0.1;
  setScale(s, null, anchor);
}
function updateZoomUI() {
  const d = cur(); if (!d) return;
  const sel = $('#zoomSel');
  const opt = [...sel.options].find(o => o.value === String(d.scale));
  if (d.zoomMode) sel.value = d.zoomMode;
  else if (opt) sel.value = opt.value;
  else { const c = sel.querySelector('[value=custom]'); c.textContent = Math.round(d.scale * 100) + '%'; sel.value = 'custom'; }
  $('#stZoom').textContent = Math.round(d.scale * 100) + '%';
}
$('#zoomSel').addEventListener('change', e => {
  const v = e.target.value;
  if (v === 'fit-width' || v === 'fit-page') setScale(computeFit(v), v); else if (v !== 'custom') setScale(+v);
  viewer.focus();
});
viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const d = cur(); if (!d) return;
  const f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022));
  setScale(d.scale * f, null, { x: e.clientX, y: e.clientY });
}, { passive: false });
let resizeT;
new ResizeObserver(() => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { const d = cur(); if (d?.zoomMode && !$('#docview').hidden) setScale(computeFit(d.zoomMode), d.zoomMode); }, 120);
}).observe(viewer);

/* ------------------------------ navigation ------------------------------ */
function onScroll() {
  const d = cur(); if (!d || !pagesBox) return;
  const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  let ci = 0;
  const kids = pagesBox.children;
  for (let i = 0; i < kids.length; i++) { if (kids[i].offsetTop <= mid) ci = i; else break; }
  if (d.curPage !== ci || onScroll.force) {
    onScroll.force = false;
    d.curPage = ci;
    if (document.activeElement !== $('#pageInput')) $('#pageInput').value = ci + 1;
    $$('.thumb.cur').forEach(t => t.classList.remove('cur'));
    const th = $(`.thumb[data-uid="${d.pages[ci]?.uid}"]`);
    if (th) { th.classList.add('cur'); }
    updateStatus();
  }
}
viewer.addEventListener('scroll', () => { requestAnimationFrame(onScroll); hideNotePop(); }, { passive: true });
function goToPage(i, smooth = false) {
  const d = cur(); if (!d) return;
  i = clamp(i, 0, d.pages.length - 1);
  const info = pageEls.get(d.pages[i].uid); if (!info) return;
  viewer.scrollTo({ top: info.wrap.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
  d.curPage = i; $('#pageInput').value = i + 1;
  const th = $(`.thumb[data-uid="${d.pages[i].uid}"]`);
  th?.scrollIntoView({ block: 'nearest' });
}
$('#pageInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const n = parseInt(e.target.value, 10); if (n) goToPage(n - 1); viewer.focus(); }
  e.stopPropagation();
});
$('#pageInput').addEventListener('focus', e => e.target.select());

/* =====================================================================
   ANNOTATIONS — RENDER (SVG)
   ===================================================================== */
function assetUrl(d, key) { return d.assets[key] || ''; }
function annotBBox(a) {
  switch (a.type) {
    case 'line': case 'arrow': {
      const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    }
    case 'pen': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of a.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const m = a.width / 2; return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
    }
    case 'watermark': {
      mctx.font = fontCss({ bold: true, font: 'helv' }, a.size);
      const tw = mctx.measureText(a.text).width, th = a.size;
      const r = a.angle * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      const w = tw * c + th * s, h = tw * s + th * c;
      return { x: a.cx - w / 2, y: a.cy - h / 2, w, h };
    }
    default: return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}
function penPath(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) return `M${r2(pts[0][0])} ${r2(pts[0][1])}` + pts.slice(1).map(p => `L${r2(p[0])} ${r2(p[1])}`).join('') + (pts.length === 1 ? `L${r2(pts[0][0] + 0.01)} ${r2(pts[0][1])}` : '');
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${r2(pts[i][0])} ${r2(pts[i][1])} ${r2(mx)} ${r2(my)}`;
  }
  const l = pts[pts.length - 1]; d += `L${r2(l[0])} ${r2(l[1])}`;
  return d;
}
function arrowHead(a) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), L = Math.max(8, a.width * 4), sp = 0.45;
  return [[a.x2 - L * Math.cos(ang - sp), a.y2 - L * Math.sin(ang - sp)], [a.x2, a.y2], [a.x2 - L * Math.cos(ang + sp), a.y2 - L * Math.sin(ang + sp)]];
}
function annotSvg(a, d) {
  const id = `data-id="${a.id}"`;
  const op = a.opacity != null && a.opacity < 1 ? ` opacity="${a.opacity}"` : '';
  switch (a.type) {
    case 'text': {
      const lines = String(a.text ?? '').split('\n');
      const ts = lines.map((l, i) => `<tspan x="${r2(a.x + PAD)}" y="${r2(a.y + PAD + a.size * ASC + i * a.size * LH)}">${esc(l) || ' '}</tspan>`).join('');
      return `<g class="an an-text" ${id}${op}>${a.bg ? `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.bg}"/>` : `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="transparent"/>`}
        <text font-family='${esc(familyCss(a))}' font-size="${a.size}" fill="${a.color}" font-weight="${a.bold ? 700 : 400}" font-style="${a.italic ? 'italic' : 'normal'}" style="white-space:pre;font-kerning:none">${ts}</text></g>`;
    }
    case 'rect': return `<g class="an" ${id}${op}><rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.fill || 'none'}" stroke="${a.stroke || 'none'}" stroke-width="${a.stroke ? a.width : 0}"/><rect class="hit" fill="none" stroke="transparent" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" stroke-width="${Math.max(8, a.width + 6)}"/></g>`;
    case 'ellipse': return `<g class="an" ${id}${op}><ellipse cx="${a.x + a.w / 2}" cy="${a.y + a.h / 2}" rx="${a.w / 2}" ry="${a.h / 2}" fill="${a.fill || 'none'}" stroke="${a.stroke || 'none'}" stroke-width="${a.stroke ? a.width : 0}"/><ellipse class="hit" fill="none" stroke="transparent" cx="${a.x + a.w / 2}" cy="${a.y + a.h / 2}" rx="${a.w / 2}" ry="${a.h / 2}" stroke-width="${Math.max(8, a.width + 6)}"/></g>`;
    case 'line': case 'arrow': {
      const head = a.type === 'arrow' ? `<polyline points="${arrowHead(a).map(p => p.map(r2).join(',')).join(' ')}" fill="none" stroke="${a.stroke}" stroke-width="${a.width}" stroke-linecap="round" stroke-linejoin="round"/>` : '';
      return `<g class="an" ${id}${op}><line x1="${a.x1}" y1="${a.y1}" x2="${a.x2}" y2="${a.y2}" stroke="${a.stroke}" stroke-width="${a.width}" stroke-linecap="round"/>${head}<line class="hit" stroke="transparent" x1="${a.x1}" y1="${a.y1}" x2="${a.x2}" y2="${a.y2}" stroke-width="${Math.max(10, a.width + 8)}"/></g>`;
    }
    case 'pen': { const dd = penPath(a.pts); return `<g class="an" ${id}${op}><path d="${dd}" fill="none" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="round" stroke-linejoin="round"/><path class="hit" fill="none" stroke="transparent" d="${dd}" stroke-width="${Math.max(10, a.width + 8)}"/></g>`; }
    case 'highlight': return `<g class="an" ${id}><rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.color}" opacity="${a.opacity}" style="mix-blend-mode:multiply"/></g>`;
    case 'underline': case 'strike': {
      const y = a.type === 'underline' ? a.y + a.h - a.width / 2 : a.y + a.h * 0.55;
      return `<g class="an" ${id}${op}><line x1="${a.x}" y1="${y}" x2="${a.x + a.w}" y2="${y}" stroke="${a.color}" stroke-width="${a.width}"/><rect class="hit" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="transparent" stroke="none"/></g>`;
    }
    case 'whiteout': return `<g class="an" ${id}><rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.fill}"/></g>`;
    case 'image': return `<g class="an" ${id}${op}><image href="${assetUrl(d, a.img)}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" preserveAspectRatio="none"/><rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="transparent"/></g>`;
    case 'note': return `<g class="an an-note" ${id}><g class="note-ic"><rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="3" fill="${a.color}" stroke="rgba(0,0,0,.45)" stroke-width="0.8"/>
      <path d="M${a.x + 4} ${a.y + 6}h${a.w - 8}M${a.x + 4} ${a.y + 10}h${a.w - 8}M${a.x + 4} ${a.y + 14}h${a.w - 11}" stroke="rgba(0,0,0,.55)" stroke-width="1.2"/></g></g>`;
    case 'watermark': return `<g class="an" ${id}><text x="${a.cx}" y="${a.cy}" transform="rotate(${-a.angle} ${a.cx} ${a.cy})" text-anchor="middle" dominant-baseline="central" font-family='${esc(FONTS.helv.css)}' font-weight="700" font-size="${a.size}" fill="${a.color}" opacity="${a.opacity}">${esc(a.text)}</text></g>`;
  }
  return '';
}
function selectionSvg(a, scale) {
  const hs = 8 / scale, b = annotBBox(a), sw = 1 / scale;
  const pad = 2 / scale;
  let s = `<rect class="sel-box" x="${b.x - pad}" y="${b.y - pad}" width="${b.w + pad * 2}" height="${b.h + pad * 2}" stroke-width="${sw}" stroke-dasharray="${4 / scale} ${3 / scale}"/>`;
  const hd = (n, x, y) => `<rect class="handle" data-h="${n}" x="${x - hs / 2}" y="${y - hs / 2}" width="${hs}" height="${hs}" stroke-width="${sw}" style="cursor:${({ nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' })[n] || 'move'}-resize"/>`;
  if (a.type === 'line' || a.type === 'arrow') return `<g>${hd('p1', a.x1, a.y1)}${hd('p2', a.x2, a.y2)}</g>`;
  if (a.type === 'note' || a.type === 'watermark') return s;
  if (a.type === 'text') return s + hd('se', b.x + b.w + pad, b.y + b.h + pad);
  const x0 = b.x - pad, y0 = b.y - pad, x1 = b.x + b.w + pad, y1 = b.y + b.h + pad, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
  s += hd('nw', x0, y0) + hd('ne', x1, y0) + hd('sw', x0, y1) + hd('se', x1, y1);
  if (a.type !== 'pen') s += hd('n', xm, y0) + hd('s', xm, y1) + hd('w', x0, ym) + hd('e', x1, ym);
  return s;
}
function renderAnnots(p, preview = null) {
  const d = cur(), info = pageEls.get(p.uid); if (!info) return;
  let html = p.annots.map(a => annotSvg(a, d)).join('');
  if (preview) html += annotSvg(preview, d);
  if (S.sel && S.sel.uid === p.uid) {
    const a = p.annots.find(x => x.id === S.sel.id);
    if (a) html += selectionSvg(a, d.scale);
  }
  info.svg.innerHTML = html;
  if (editing && editing.p.uid === p.uid) info.svg.querySelector(`[data-id="${editing.a.id}"]`)?.classList.add('editing');
}
function annotsChanged(p, { thumbs = true, list = true } = {}) {
  renderAnnots(p);
  if (thumbs) refreshThumb(p.uid);
  if (list) renderAnnotList();
}

/* =====================================================================
   TOOLS & POINTER INTERACTION
   ===================================================================== */
const DRAW_TOOLS = ['text', 'note', 'highlight', 'underline', 'strike', 'pen', 'rect', 'ellipse', 'line', 'arrow', 'whiteout'];
function setTool(t) {
  endTextEdit();
  if (S.placing && t !== 'place') cancelPlace();
  S.tool = t;
  viewer.className = 'viewer tool-' + t + (DRAW_TOOLS.includes(t) ? ' drawing' : '') + (S.placing ? ' placing drawing' : '');
  $$('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  if (t !== 'select' && S.sel) { const d = cur(); const p = d && pageByUid(d, S.sel.uid); S.sel = null; if (p) renderAnnots(p); }
  // edit-text layers
  const d = cur();
  if (d) for (const p of d.pages) { const info = pageEls.get(p.uid); if (!info) continue; if (t === 'edittext') { if (info.key) buildEditLayer(p); } else info.edit.innerHTML = ''; }
  if (t === 'edittext') toast('Klik teks pada halaman untuk mengeditnya', '', 2200);
  if (d && ['highlight', 'underline', 'strike'].includes(t)) for (const u of visible) { const p = pageByUid(d, u); if (p && !p._lines) buildLines(p); }
  renderProps();
}
function pagePoint(e, wrap) {
  const r = wrap.getBoundingClientRect(), s = cur().scale;
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}

let drag = null;
viewer.addEventListener('pointerdown', onPointerDown);
viewer.addEventListener('dblclick', onDblClick);
viewer.addEventListener('contextmenu', onViewerContext);

function onPointerDown(e) {
  const d = cur(); if (!d) return;
  if (e.target.closest('.text-editor')) return;
  hideCtx(); hideNotePop();
  // panning
  if (e.button === 1 || (e.button === 0 && (S.tool === 'hand' || S.spaceDown))) {
    e.preventDefault();
    drag = { kind: 'pan', x: e.clientX, y: e.clientY, st: viewer.scrollTop, sl: viewer.scrollLeft };
    viewer.classList.add('panning');
    return startDrag(e);
  }
  if (e.button !== 0) return;
  const wrap = e.target.closest('.page'); if (!wrap) { if (S.tool === 'select') deselect(); return; }
  const p = pageByUid(d, wrap.dataset.uid); const pt = pagePoint(e, wrap);
  if (editing) { endTextEdit(); if (S.tool === 'text') return; }

  if (S.placing) { e.preventDefault(); placeAt(p, pt); return; }

  if (S.tool === 'edittext') {
    const an = e.target.closest('.an-text');
    if (an) { const a = p.annots.find(x => x.id === an.dataset.id); if (a) { e.preventDefault(); editText(p, a, false); } return; }
    const blk = e.target.closest('[data-blk]');
    if (blk) { e.preventDefault(); convertBlock(p, +blk.dataset.blk); }
    return;
  }

  if (S.tool === 'select') {
    const h = e.target.closest('.handle');
    if (h && S.sel?.uid === p.uid) {
      const a = p.annots.find(x => x.id === S.sel.id); if (!a) return;
      e.preventDefault();
      drag = { kind: 'resize', h: h.dataset.h, p, a, orig: structuredClone(a), bb: annotBBox(a), start: pt, snap: snapshot(), moved: false };
      return startDrag(e);
    }
    const an = e.target.closest('.an');
    if (an) {
      const a = p.annots.find(x => x.id === an.dataset.id); if (!a) return;
      e.preventDefault(); window.getSelection()?.removeAllRanges();
      select(p, a);
      drag = { kind: 'move', p, a, orig: structuredClone(a), start: pt, snap: snapshot(), moved: false };
      return startDrag(e);
    }
    deselect();
    return;
  }

  // creation tools
  e.preventDefault();
  const o = S.opts[S.tool];
  if (S.tool === 'text') {
    const hit = document.elementsFromPoint(e.clientX, e.clientY).find(el => el.closest?.('.an-text'));
    if (hit) { const a = p.annots.find(x => x.id === hit.closest('.an-text').dataset.id); if (a) return editText(p, a, false); }
    const a = { id: uid(), type: 'text', x: pt.x - PAD, y: pt.y - o.size * 0.6, text: S.pendingText || '', font: o.font, family: o.family, size: o.size, color: o.color, bold: o.bold, italic: o.italic, bg: o.bg, opacity: o.opacity ?? 1 };
    const pending = S.pendingText; S.pendingText = null;
    measureText(a);
    const snap = snapshot();
    p.annots.push(a); renderAnnots(p);
    editText(p, a, true, snap);
    if (pending) endTextEdit();
    return;
  }
  if (S.tool === 'note') {
    const snap = snapshot();
    const a = { id: uid(), type: 'note', x: pt.x - 10, y: pt.y - 10, w: 20, h: 20, text: '', color: o.color };
    promptDialog('Catatan', 'Isi komentar:', '', { multiline: true, okText: 'Tambahkan' }).then(txt => {
      if (txt == null || !txt.trim()) return;
      a.text = txt; p.annots.push(a); pushUndoSnap(snap); select(p, a); annotsChanged(p); setTool('select');
    });
    return;
  }
  const t = S.tool;
  let a;
  if (t === 'pen') a = { id: uid(), type: 'pen', pts: [[pt.x, pt.y]], color: o.color, width: o.width, opacity: o.opacity };
  else if (t === 'line' || t === 'arrow') a = { id: uid(), type: t, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, stroke: o.stroke, width: o.width, opacity: o.opacity };
  else a = { id: uid(), type: t, x: pt.x, y: pt.y, w: 0, h: 0, ...structuredClone(o) };
  drag = { kind: 'create', p, a, start: pt, wrap };
  startDrag(e);
}
function startDrag(e) {
  try { e.target.setPointerCapture?.(e.pointerId); } catch { }
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
  window.addEventListener('pointercancel', onPointerUp, { once: true });
}
function onPointerMove(e) {
  if (!drag) return;
  const d = cur();
  if (drag.kind === 'pan') { viewer.scrollTop = drag.st - (e.clientY - drag.y); viewer.scrollLeft = drag.sl - (e.clientX - drag.x); return; }
  const info = pageEls.get(drag.p.uid); if (!info) return;
  const pt = pagePoint(e, info.wrap);
  const { W, H } = dims(drag.p);
  pt.x = clamp(pt.x, -20, W + 20); pt.y = clamp(pt.y, -20, H + 20);
  const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
  if (drag.kind === 'create') {
    const a = drag.a, s = drag.start;
    if (a.type === 'pen') { const l = a.pts[a.pts.length - 1]; if (Math.hypot(pt.x - l[0], pt.y - l[1]) > 0.8 / d.scale) a.pts.push([r2(pt.x), r2(pt.y)]); }
    else if (a.type === 'line' || a.type === 'arrow') {
      a.x2 = pt.x; a.y2 = pt.y;
      if (e.shiftKey) { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(dx, dy); a.x2 = s.x + L * Math.cos(ang); a.y2 = s.y + L * Math.sin(ang); }
    } else {
      let w = dx, h = dy;
      if (e.shiftKey && (a.type === 'rect' || a.type === 'ellipse')) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      if (['highlight', 'underline', 'strike'].includes(a.type)) {
        const snapR = snapToText(drag.p, s, pt);
        if (snapR) { Object.assign(a, snapR); return renderAnnots(drag.p, a); }
      }
      a.x = Math.min(s.x, s.x + w); a.y = Math.min(s.y, s.y + h); a.w = Math.abs(w); a.h = Math.abs(h);
    }
    renderAnnots(drag.p, a);
    return;
  }
  if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true;
  if (!drag.moved) return;
  const a = drag.a, o = drag.orig;
  if (drag.kind === 'move') translateAnnot(a, o, dx, dy);
  else if (drag.kind === 'resize') resizeAnnot(a, o, drag.bb, drag.h, dx, dy, pt, e.shiftKey);
  renderAnnots(drag.p);
  if (S.sel) updateSelStatus(a);
}
function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  const g = drag; drag = null;
  viewer.classList.remove('panning');
  if (!g || g.kind === 'pan') return;
  if (g.kind === 'create') {
    const a = g.a; let ok = true;
    if (a.type === 'pen') ok = a.pts.length > 1;
    else if (a.type === 'line' || a.type === 'arrow') ok = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 3;
    else {
      if (['highlight', 'underline', 'strike'].includes(a.type) && a.w > 3 && a.h <= 2) { a.y -= 7; a.h = 14; }
      ok = a.w > 3 && a.h > 2;
    }
    if (!ok) { renderAnnots(g.p); return; }
    pushUndo();
    g.p.annots.push(a);
    annotsChanged(g.p);
    return;
  }
  if (g.moved) { pushUndoSnap(g.snap); annotsChanged(g.p, { list: false }); renderProps(); }
}
function translateAnnot(a, o, dx, dy) {
  if (a.type === 'line' || a.type === 'arrow') { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy; }
  else if (a.type === 'pen') a.pts = o.pts.map(([x, y]) => [r2(x + dx), r2(y + dy)]);
  else if (a.type === 'watermark') { a.cx = o.cx + dx; a.cy = o.cy + dy; }
  else { a.x = o.x + dx; a.y = o.y + dy; }
}
function resizeAnnot(a, o, bb, h, dx, dy, pt, shift) {
  if (h === 'p1') { a.x1 = pt.x; a.y1 = pt.y; return; }
  if (h === 'p2') { a.x2 = pt.x; a.y2 = pt.y; return; }
  if (a.type === 'text') {
    const k = Math.max(0.2, (bb.w + dx) / bb.w);
    a.size = clamp(Math.round(o.size * k * 2) / 2, 4, 400);
    a.minW = 0; a.minH = 0; measureText(a); return;
  }
  let x0 = bb.x, y0 = bb.y, x1 = bb.x + bb.w, y1 = bb.y + bb.h;
  if (h.includes('w')) x0 += dx; if (h.includes('e')) x1 += dx;
  if (h.includes('n')) y0 += dy; if (h.includes('s')) y1 += dy;
  if ((shift || a.type === 'image' && a.keepRatio !== false) && h.length === 2) {
    const r = bb.w / bb.h; const nw = Math.abs(x1 - x0), nh = nw / r;
    if (h.includes('n')) y0 = y1 - nh; else y1 = y0 + nh;
  }
  const nx = Math.min(x0, x1), ny = Math.min(y0, y1), nw = Math.max(2, Math.abs(x1 - x0)), nh = Math.max(2, Math.abs(y1 - y0));
  if (a.type === 'pen') {
    const kx = nw / bb.w, ky = nh / bb.h;
    a.pts = o.pts.map(([x, y]) => [r2(nx + (x - bb.x) * kx), r2(ny + (y - bb.y) * ky)]);
    return;
  }
  a.x = nx; a.y = ny; a.w = nw; a.h = nh;
}
/* Snap highlight/underline ke baris teks yang dilewati */
function snapToText(p, s, e) {
  const d = cur(); const blocks = p._lines;
  if (!blocks) { buildLines(p); return null; }
  const x0 = Math.min(s.x, e.x), x1 = Math.max(s.x, e.x), y0 = Math.min(s.y, e.y), y1 = Math.max(s.y, e.y);
  if (Math.abs(e.y - s.y) > 40) return null;
  let hits = blocks.filter(b => b.y + b.h > y0 && b.y < y1 && b.x < x1 && b.x + b.w > x0);
  if (!hits.length) { // toleransi: baris terdekat dalam jarak 6pt
    const near = blocks.filter(b => b.x < x1 && b.x + b.w > x0).map(b => [b, Math.min(Math.abs(b.y - y0), Math.abs(b.y + b.h - y0))]).filter(x => x[1] < 6).sort((a, b) => a[1] - b[1]);
    if (near.length) hits = [near[0][0]];
  }
  if (!hits.length) return null;
  const top = Math.min(...hits.map(b => b.y)), bot = Math.max(...hits.map(b => b.y + b.h));
  return { x: x0, y: top, w: x1 - x0, h: bot - top };
}
const buildingLines = new WeakSet();
async function buildLines(p) {
  const d = cur(); if (buildingLines.has(p)) return; buildingLines.add(p);
  try { const blocks = await textBlocks(d, p); Object.defineProperty(p, '_lines', { value: blocks, enumerable: false, configurable: true }); }
  catch { } finally { buildingLines.delete(p); }
}

function onDblClick(e) {
  const d = cur(); if (!d || S.tool !== 'select') return;
  const an = e.target.closest('.an'); if (!an) return;
  const p = pageByUid(d, an.closest('.page').dataset.uid);
  const a = p.annots.find(x => x.id === an.dataset.id); if (!a) return;
  if (a.type === 'text') editText(p, a, false);
  else if (a.type === 'note') editNote(p, a);
  else if (a.type === 'watermark') editWatermarkText(p, a);
}
async function editNote(p, a) {
  const t = await promptDialog('Catatan', 'Isi komentar:', a.text, { multiline: true, okText: 'Simpan' });
  if (t == null) return;
  pushUndo(); a.text = t; annotsChanged(p);
}
async function editWatermarkText(p, a) {
  const t = await promptDialog('Watermark', 'Teks watermark:', a.text); if (!t) return;
  pushUndo(); a.text = t; annotsChanged(p);
}

/* note hover */
let notePop = null;
viewer.addEventListener('pointerover', e => {
  const an = e.target.closest('.an-note'); if (!an) return;
  const d = cur(); const p = pageByUid(d, an.closest('.page').dataset.uid); const a = p?.annots.find(x => x.id === an.dataset.id);
  if (!a?.text) return;
  hideNotePop();
  notePop = document.createElement('div'); notePop.className = 'note-pop'; notePop.textContent = a.text;
  const info = pageEls.get(p.uid);
  notePop.style.left = (a.x + a.w + 4) * d.scale + 'px'; notePop.style.top = a.y * d.scale + 'px';
  info.wrap.append(notePop);
});
viewer.addEventListener('pointerout', e => { if (e.target.closest('.an-note')) hideNotePop(); });
function hideNotePop() { notePop?.remove(); notePop = null; }

/* ------------------------------ selection ------------------------------ */
function select(p, a) {
  const d = cur();
  const prev = S.sel && pageByUid(d, S.sel.uid);
  S.sel = { uid: p.uid, id: a.id };
  if (prev && prev !== p) renderAnnots(prev);
  renderAnnots(p); renderProps(); updateSelStatus(a);
}
function deselect() {
  if (!S.sel) return;
  const d = cur(); const p = pageByUid(d, S.sel.uid);
  S.sel = null; if (p) renderAnnots(p); renderProps(); $('#stSel').textContent = '';
}
function selected() {
  const d = cur(); if (!d) return null;
  if (editing) return { p: editing.p, a: editing.a };
  if (!S.sel) return null;
  const p = pageByUid(d, S.sel.uid); const a = p?.annots.find(x => x.id === S.sel.id);
  return a ? { p, a } : null;
}
function updateSelStatus(a) { const b = annotBBox(a); $('#stSel').textContent = `${TYPE_LABEL[a.type] || a.type} · ${Math.round(b.w)}×${Math.round(b.h)} pt`; }
function deleteSelected() {
  const s = selected(); if (!s) return;
  pushUndo(); s.p.annots = s.p.annots.filter(x => x !== s.a); S.sel = null;
  annotsChanged(s.p); renderProps(); $('#stSel').textContent = '';
}
function duplicateSelected() {
  const s = selected(); if (!s) return;
  pushUndo();
  const a = structuredClone(s.a); a.id = uid(); translateAnnot(a, structuredClone(a), 12, 12);
  s.p.annots.push(a); select(s.p, a); annotsChanged(s.p);
}
function reorderSelected(dir) {
  const s = selected(); if (!s) return;
  pushUndo();
  const arr = s.p.annots, i = arr.indexOf(s.a);
  arr.splice(i, 1);
  if (dir > 0) arr.push(s.a); else arr.unshift(s.a);
  annotsChanged(s.p);
}
function copySelected() { const s = selected(); if (!s) return false; S.clipboard = { a: structuredClone(s.a), img: s.a.img ? cur().assets[s.a.img] : null }; toast('Objek disalin'); return true; }
function pasteClipboard() {
  const d = cur(); if (!d || !S.clipboard) return false;
  const p = d.pages[d.curPage];
  const a = structuredClone(S.clipboard.a); a.id = uid();
  if (S.clipboard.img) { d.assets[a.img] = S.clipboard.img; }
  translateAnnot(a, structuredClone(a), 14, 14);
  pushUndo(); p.annots.push(a); setTool('select'); select(p, a); annotsChanged(p);
  return true;
}

/* ------------------------------ system fonts ------------------------------ */
S.sysFonts = null;
async function loadSystemFonts(interactive) {
  if (!('queryLocalFonts' in window)) { if (interactive) toast('Browser ini tidak mendukung huruf komputer. Gunakan Chrome/Edge atau versi .exe.', 'err', 5000); return false; }
  try {
    if (!interactive) {
      const st = await navigator.permissions?.query({ name: 'local-fonts' }).catch(() => null);
      if (!IS_NATIVE && st?.state !== 'granted') return false;
    }
    const list = await window.queryLocalFonts();
    if (!list.length) return false;
    const m = new Map();
    for (const fd of list) { if (!m.has(fd.family)) m.set(fd.family, []); m.get(fd.family).push(fd); }
    S.sysFonts = new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    if (interactive) toast(`${S.sysFonts.size} keluarga huruf komputer siap dipakai`, 'ok');
    return true;
  } catch (e) { if (interactive) toast('Akses huruf komputer tidak diizinkan', 'err'); return false; }
}

/* ------------------------------ text editing ------------------------------ */
let editing = null;
function editText(p, a, isNew, snap = null) {
  endTextEdit();
  const d = cur(); const info = pageEls.get(p.uid); if (!info) return;
  if (S.tool === 'select') select(p, a);
  const ta = document.createElement('textarea');
  ta.className = 'text-editor'; ta.value = a.text || ''; ta.spellcheck = false;
  info.wrap.append(ta);
  editing = { p, a, ta, isNew, snap: snap || snapshot(), orig: a.text };
  styleEditor();
  info.svg.querySelector(`[data-id="${a.id}"]`)?.classList.add('editing');
  ta.addEventListener('input', () => { a.text = ta.value; measureText(a); styleEditor(); });
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); endTextEdit(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (editing?.ta === ta) endTextEdit(); }, 80));
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  ta.focus({ preventScroll: true });
  setTimeout(() => { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  renderProps();
}
function styleEditor() {
  if (!editing) return;
  const { a, ta } = editing, s = cur().scale;
  // baseline textarea ≈ 0.947×ukuran dari atas baris; SVG memakai PAD + ASC×ukuran
  const off = PAD + a.size * (ASC - 0.947);
  Object.assign(ta.style, {
    left: a.x * s + 'px', top: (a.y + off - PAD) * s + 'px', width: (a.w + 8) * s + 'px', height: (a.h + 2) * s + 'px',
    font: fontCss(a, a.size * s), lineHeight: String(LH), color: a.color, padding: `${PAD * s}px ${PAD * s}px 0`,
    background: a.bg || 'rgba(255,255,255,0.01)', opacity: a.opacity ?? 1,
  });
}
function repositionEditor() { if (editing) styleEditor(); }
function endTextEdit() {
  if (!editing) return;
  const { p, a, ta, isNew, snap, orig } = editing;
  editing = null;
  a.text = ta.value.replace(/\s+$/, m => m.includes('\n') ? '' : m);
  ta.remove();
  const d = cur();
  if (!a.text.trim() && !a.fromEdit) {
    p.annots = p.annots.filter(x => x !== a);
    if (!isNew) pushUndoSnap(snap);
    if (S.sel?.id === a.id) S.sel = null;
  } else {
    measureText(a);
    if (isNew || a.text !== orig) pushUndoSnap(snap);
  }
  if (d) { annotsChanged(p); renderProps(); }
}

/* ------------------------------ edit existing text ------------------------------ */
function itemGeom(item, style, V) {
  const tx = mChain(item.transform, V);
  const fh = Math.hypot(tx[2], tx[3]) || 1;
  const ux = tx[0], uy = tx[1], ul = Math.hypot(ux, uy) || 1;
  const u = [ux / ul, uy / ul], v = [tx[2] / fh, tx[3] / fh];
  let asc = style?.ascent || 0.8; if (asc <= 0 || asc > 1.3) asc = 0.8;
  let desc = style?.descent ? Math.abs(style.descent) : 0.2; if (desc > 0.6) desc = 0.2;
  return { o: [tx[4], tx[5]], u, v, fh, asc, desc, angle: Math.atan2(u[1], u[0]), w: item.width };
}
function geomRect(g, t0 = 0, t1 = 1) {
  const pts = [];
  for (const t of [t0, t1]) for (const s of [-g.desc * g.fh, g.asc * g.fh]) {
    pts.push([g.o[0] + g.u[0] * g.w * t + g.v[0] * s, g.o[1] + g.u[1] * g.w * t + g.v[1] * s]);
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
async function textBlocks(d, p) {
  const tc = await getText(d, p);
  const { total } = dims(p);
  const V = vpTransform(p.view, total);
  const pg = await getPdfPage(d.sources[p.src], p.idx);
  const blocks = [];
  let prev = null;
  for (const it of tc.items) {
    if (!it.str) { if (it.hasEOL) prev = null; continue; }
    const g = itemGeom(it, tc.styles[it.fontName], V);
    if (Math.abs(g.angle) > 0.06) { prev = null; continue; }
    const x = g.o[0], base = g.o[1], fs = g.fh, w = g.w;
    if (!it.str.trim()) { if (prev) { prev.str += it.str; prev.w = Math.max(prev.w, x + w - prev.x); } continue; }
    if (prev && Math.abs(base - prev.base) < fs * 0.25 && Math.abs(fs - prev.fs) < fs * 0.25 && x > prev.x + prev.w - fs * 0.6 && x - (prev.x + prev.w) < fs * 1.5) {
      const gap = x - (prev.x + prev.w);
      if (gap > fs * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) prev.str += ' ';
      prev.str += it.str; prev.w = x + w - prev.x;
    } else {
      let fontName = '';
      try { const f = pg.commonObjs.get(it.fontName); fontName = f?.name || ''; } catch { }
      const fam = tc.styles[it.fontName]?.fontFamily || '';
      prev = { x, base, fs, w, str: it.str, fontName, fam };
      blocks.push(prev);
    }
    if (it.hasEOL) prev = null;
  }
  for (const b of blocks) { b.y = b.base - b.fs * 0.92; b.h = b.fs * 1.18; b.str = b.str.replace(/\s+$/, ''); }
  return blocks.filter(b => b.str.trim() && b.w > 1);
}
async function buildEditLayer(p) {
  const d = cur(), info = pageEls.get(p.uid); if (!info) return;
  const blocks = await textBlocks(d, p);
  if (S.tool !== 'edittext') return;
  Object.defineProperty(p, '_blocks', { value: blocks, enumerable: false, configurable: true });
  const { W, H } = dims(p);
  const used = new Set(p.annots.filter(a => a.fromEdit).map(a => a.fromEdit));
  info.edit.innerHTML = blocks.map((b, i) => used.has(blkKey(b)) ? '' :
    `<div data-blk="${i}" title="Klik untuk edit" style="left:${(b.x / W * 100).toFixed(3)}%;top:${(b.y / H * 100).toFixed(3)}%;width:${(b.w / W * 100).toFixed(3)}%;height:${(b.h / H * 100).toFixed(3)}%"></div>`).join('');
}
const blkKey = b => `${Math.round(b.x)}_${Math.round(b.base)}`;
function sampleColors(p, b) {
  const info = pageEls.get(p.uid); const c = info?.canvas;
  const res = { bg: '#ffffff', fg: '#000000' };
  if (!c || !c.width) return res;
  const { W } = dims(p); const k = c.width / W;
  try {
    const ctx = c.getContext('2d');
    const x0 = Math.max(0, Math.floor(b.x * k) - 3), y0 = Math.max(0, Math.floor(b.y * k) - 3);
    const w = Math.min(c.width - x0, Math.ceil(b.w * k) + 6), h = Math.min(c.height - y0, Math.ceil(b.h * k) + 6);
    const data = ctx.getImageData(x0, y0, w, h).data;
    const buckets = new Map();
    const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    const add = c3 => { const q = c3.map(v => v >> 3).join(','); const b = buckets.get(q) || [0, 0, 0, 0]; b[0]++; b[1] += c3[0]; b[2] += c3[1]; b[3] += c3[2]; buckets.set(q, b); };
    for (let x = 0; x < w; x++) for (const y of [0, 1, h - 1, h - 2]) add(px(x, y));
    for (let y = 0; y < h; y++) for (const x of [0, 1, w - 1, w - 2]) add(px(x, y));
    const top = [...buckets.values()].sort((a, b) => b[0] - a[0])[0];
    const bg = [top[1] / top[0], top[2] / top[0], top[3] / top[0]].map(Math.round);
    res.bg = rgbToHex(...bg);
    let best = 0, fg = null;
    for (let y = 3; y < h - 3; y += 1) for (let x = 3; x < w - 3; x += 1) {
      const c3 = px(x, y); const dd = Math.abs(c3[0] - bg[0]) + Math.abs(c3[1] - bg[1]) + Math.abs(c3[2] - bg[2]);
      if (dd > best) { best = dd; fg = c3; }
    }
    if (fg && best > 80) res.fg = rgbToHex(...fg);
    else res.fg = (bg[0] + bg[1] + bg[2]) / 3 > 128 ? '#000000' : '#ffffff';
  } catch { }
  return res;
}
function convertBlock(p, i) {
  const b = p._blocks?.[i]; if (!b) return;
  const { bg, fg } = sampleColors(p, b);
  const fam = /mono|courier/i.test(b.fontName + b.fam) ? 'cour' : (/serif/i.test(b.fam) && !/sans/i.test(b.fam)) || /times|georgia|garamond|roman|cambria|book/i.test(b.fontName) ? 'times' : 'helv';
  const bold = /bold|black|heavy|semibold|demi/i.test(b.fontName);
  const italic = /italic|oblique/i.test(b.fontName);
  const size = Math.round(b.fs * 10) / 10;
  const sysFam = matchSysFamily(b.fontName, b.fam);
  const a = {
    id: uid(), type: 'text', x: b.x - PAD, y: b.base - PAD - size * ASC, text: b.str, font: sysFam ? 'sys' : fam, family: sysFam || undefined, size, color: fg, bold, italic,
    bg, opacity: 1, fromEdit: blkKey(b), origRect: { x: b.x, y: b.y, w: b.w, h: b.h },
  };
  mctx.font = fontCss(a, a.size);
  a.minW = b.w + PAD * 2 + 1.5;
  a.minH = b.fs * 1.18 + PAD * 2;
  a.y = Math.min(a.y, b.y - PAD);
  measureText(a);
  const snap = snapshot();
  p.annots.push(a);
  pushUndoSnap(snap);
  renderAnnots(p);
  info_removeBlock(p, i);
  editText(p, a, false, snapshot());
}
function matchSysFamily(fontName = '', fam = '') {
  if (!S.sysFonts || !fontName) return null;
  const base = fontName.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0];
  if (/^(arial|helvetica|times|courier)/i.test(base)) return null; // huruf standar PDF sudah identik
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(psmt|mt|ps)$/, '');
  const nb = norm(base); if (nb.length < 3) return null;
  for (const f of S.sysFonts.keys()) if (norm(f) === nb) return f;
  for (const [f, faces] of S.sysFonts) if (faces.some(x => norm(String(x.postscriptName).split('-')[0]) === nb)) return f;
  return null;
}
function info_removeBlock(p, i) { pageEls.get(p.uid)?.edit.querySelector(`[data-blk="${i}"]`)?.remove(); }

/* ------------------------------ placing images / stamps ------------------------------ */
function startPlace(img, w, h, label = 'gambar') {
  const d = cur(); if (!d) return;
  const key = 'img_' + uid(); d.assets[key] = img;
  S.placing = { key, w, h };
  $('#placeText').textContent = `Klik di halaman untuk menempatkan ${label}.`;
  $('#placebar').hidden = false;
  viewer.classList.add('placing', 'drawing');
}
function cancelPlace() { S.placing = null; $('#placebar').hidden = true; viewer.classList.remove('placing'); if (!DRAW_TOOLS.includes(S.tool)) viewer.classList.remove('drawing'); }
function placeAt(p, pt) {
  const pl = S.placing; if (!pl) return;
  const { W } = dims(p);
  let w = pl.w, h = pl.h;
  if (w > W * 0.8) { const k = W * 0.8 / w; w *= k; h *= k; }
  const a = { id: uid(), type: 'image', img: pl.key, x: pt.x - w / 2, y: pt.y - h / 2, w, h, opacity: 1, keepRatio: true };
  pushUndo(); p.annots.push(a);
  cancelPlace(); setTool('select'); select(p, a); annotsChanged(p);
}
async function placeImageFile(file) {
  const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  let data = url;
  const img = await loadImage(url);
  if (!/^data:image\/(png|jpeg)/.test(url)) {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0); data = c.toDataURL('image/png');
  }
  const k = Math.min(1, 300 / Math.max(img.naturalWidth, img.naturalHeight)) * 0.75;
  const w = Math.max(30, img.naturalWidth * k), h = Math.max(30 * img.naturalHeight / img.naturalWidth, img.naturalHeight * k);
  // Tempatkan langsung di tengah halaman aktif
  const d = cur(); const p = d.pages[d.curPage];
  const { W, H } = dims(p);
  const key = 'img_' + uid(); d.assets[key] = data;
  const a = { id: uid(), type: 'image', img: key, x: (W - w) / 2, y: (H - h) / 2, w, h, opacity: 1, keepRatio: true };
  pushUndo(); p.annots.push(a); setTool('select'); select(p, a); annotsChanged(p);
}
async function cmdInsertImage() {
  const fs = await pickFiles('#fileImg'); if (!fs) return;
  for (const f of fs) await placeImageFile(f);
}
function symbolImage(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d');
  g.strokeStyle = g.fillStyle = '#111'; g.lineWidth = 12; g.lineCap = g.lineJoin = 'round';
  if (kind === 'check') { g.beginPath(); g.moveTo(16, 52); g.lineTo(38, 74); g.lineTo(80, 22); g.stroke(); }
  if (kind === 'cross') { g.beginPath(); g.moveTo(22, 22); g.lineTo(74, 74); g.moveTo(74, 22); g.lineTo(22, 74); g.stroke(); }
  if (kind === 'dot') { g.beginPath(); g.arc(48, 48, 22, 0, Math.PI * 2); g.fill(); }
  return c.toDataURL('image/png');
}

/* =====================================================================
   CONTEXT MENU
   ===================================================================== */
const ctx = $('#ctxmenu');
function showCtx(x, y, items) {
  ctx.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}">${it.icon ? icon(it.icon) : ''}${esc(it.t)}</button>`).join('');
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  ctx.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  ctx.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; hideCtx(); items[+b.dataset.i].f(); };
}
function hideCtx() { ctx.hidden = true; }
document.addEventListener('pointerdown', e => { if (!e.target.closest('#ctxmenu')) hideCtx(); if (!e.target.closest('.menu')) closeMenus(); }, true);
function onViewerContext(e) {
  const d = cur(); if (!d) return;
  const an = e.target.closest('.an');
  const wrap = e.target.closest('.page');
  if (an && S.tool === 'select') {
    e.preventDefault();
    const p = pageByUid(d, wrap.dataset.uid); const a = p.annots.find(x => x.id === an.dataset.id); if (!a) return;
    select(p, a);
    const items = [];
    if (a.type === 'text') items.push({ t: 'Edit teks', icon: 'type', f: () => editText(p, a, false) });
    if (a.type === 'note') items.push({ t: 'Edit catatan', icon: 'note', f: () => editNote(p, a) });
    items.push({ t: 'Duplikat', icon: 'copy', f: duplicateSelected }, { t: 'Salin', icon: 'copy', f: copySelected },
      { t: 'Ke depan', icon: 'up', f: () => reorderSelected(1) }, { t: 'Ke belakang', icon: 'down', f: () => reorderSelected(-1) }, '-',
      { t: 'Hapus', icon: 'trash', f: deleteSelected });
    showCtx(e.clientX, e.clientY, items);
    return;
  }
  if (wrap && !window.getSelection()?.toString()) {
    e.preventDefault();
    const p = pageByUid(d, wrap.dataset.uid);
    const items = [];
    if (S.clipboard) items.push({ t: 'Tempel objek', icon: 'copy', f: () => { d.curPage = pageIndex(d, p.uid); pasteClipboard(); } });
    items.push({ t: 'Putar halaman ke kanan', icon: 'rotate-cw', f: () => rotatePages([p.uid], 90) },
      { t: 'Putar halaman ke kiri', icon: 'rotate-ccw', f: () => rotatePages([p.uid], -90) },
      { t: 'Sisip halaman kosong setelahnya', icon: 'file-plus', f: () => insertBlank(pageIndex(d, p.uid) + 1) },
      { t: 'Hapus halaman ini', icon: 'trash', f: () => deletePages([p.uid]) });
    showCtx(e.clientX, e.clientY, items);
  }
}

/* =====================================================================
   PROPERTIES PANEL
   ===================================================================== */
const TYPE_LABEL = { text: 'Teks', pen: 'Pena', highlight: 'Sorotan', underline: 'Garis bawah', strike: 'Coretan', rect: 'Kotak', ellipse: 'Lingkaran', line: 'Garis', arrow: 'Panah', whiteout: 'Penutup', note: 'Catatan', image: 'Gambar', watermark: 'Watermark' };
const TOOL_HINT = {
  select: 'Klik objek untuk memilih, seret untuk memindah. Klik dua kali teks untuk mengedit. Seret di halaman untuk memilih/menyalin teks.',
  hand: 'Seret untuk menggeser halaman. Tahan Spasi kapan saja untuk menggeser.',
  edittext: 'Klik teks yang ada di PDF untuk mengubahnya. Warna latar & huruf diambil otomatis. Kosongkan untuk menghapus teks.',
  text: 'Klik di halaman untuk menambahkan teks.',
  highlight: 'Seret di atas teks untuk menyorot.', underline: 'Seret di atas teks untuk menggaris bawahi.', strike: 'Seret di atas teks untuk mencoret.',
  pen: 'Gambar bebas dengan mouse, pena, atau jari.', note: 'Klik untuk menempelkan catatan komentar.',
  rect: 'Seret untuk membuat kotak (Shift = persegi).', ellipse: 'Seret untuk membuat lingkaran (Shift = bulat sempurna).',
  line: 'Seret untuk membuat garis (Shift = sudut 45°).', arrow: 'Seret untuk membuat panah (Shift = sudut 45°).',
  whiteout: 'Seret untuk menutup/menghapus area (misal teks atau gambar lama).',
};
const SWATCH = ['#000000', '#ffffff', '#d7373f', '#e68619', '#ffeb3b', '#2d9d78', '#1473e6', '#6e49cb', '#e2228c', '#808080'];
const HL_SWATCH = ['#ffeb3b', '#a6f16c', '#7fe0ff', '#ff9ecf', '#ffb35c', '#c8a6ff'];
function swatchRow(key, val, { none = false, list = SWATCH } = {}) {
  return `<div class="swatches" data-key="${key}">${none ? `<button class="none ${!val ? 'on' : ''}" data-v="" title="Tanpa warna"></button>` : ''}${list.map(c => `<button style="background:${c}" class="${val && val.toLowerCase() === c ? 'on' : ''}" data-v="${c}" title="${c}"></button>`).join('')}<input type="color" value="${val || '#000000'}" title="Warna lain"></div>`;
}
function renderProps() {
  const box = $('#props'); if (!box) return;
  const s = selected();
  const t = s ? s.a.type : S.tool;
  const src = s ? s.a : S.opts[t];
  const title = s ? (TYPE_LABEL[t] || t) : ({ select: 'Pilih', hand: 'Geser', edittext: 'Edit Teks', ...TYPE_LABEL })[t] || '';
  if (!title) { box.innerHTML = ''; return; }
  let h = `<h4>${esc(title)}${s ? ' <span class="muted small">(terpilih)</span>' : ''}</h4>`;
  if (!s && TOOL_HINT[t]) h += `<p class="hint">${TOOL_HINT[t]}</p>`;
  if (!s && (t === 'edittext' || t === 'text') && !S.sysFonts && 'queryLocalFonts' in window)
    h += `<button class="btn sm" data-act="sysfonts">${icon('type')}Pakai huruf komputer</button><p class="hint">Agar hasil edit memakai huruf asli dokumen (mis. Calibri) dan mendukung semua aksara.</p>`;
  if (src) {
    if (t === 'text') {
      const cur_ = src.font === 'sys' ? 'sys:' + src.family : src.font;
      const sysOpts = S.sysFonts ? `<optgroup label="Huruf komputer">${[...S.sysFonts.keys()].map(f => `<option value="sys:${esc(f)}" ${cur_ === 'sys:' + f ? 'selected' : ''} style="font-family:'${esc(f)}'">${esc(f)}</option>`).join('')}</optgroup>`
        : ('queryLocalFonts' in window ? '<option value="__load">➕ Tampilkan huruf komputer…</option>' : '');
      const missingSys = src.font === 'sys' && !S.sysFonts?.has(src.family) ? `<option value="sys:${esc(src.family)}" selected>${esc(src.family)}</option>` : '';
      h += `<div class="prow"><span>Huruf</span><select data-key="font">${Object.entries(FONTS).map(([k, f]) => `<option value="${k}" ${cur_ === k ? 'selected' : ''}>${f.label}</option>`).join('')}${missingSys}${sysOpts}</select></div>
        <div class="prow"><span>Ukuran</span><input type="number" data-key="size" min="4" max="400" step="0.5" value="${src.size}"><div class="tog"><button data-tog="bold" class="${src.bold ? 'on' : ''}">B</button><button data-tog="italic" class="${src.italic ? 'on' : ''}" style="font-style:italic">I</button></div></div>
        <div class="prow"><span>Warna</span>${swatchRow('color', src.color)}</div>
        <div class="prow"><span>Latar</span>${swatchRow('bg', src.bg, { none: true })}</div>`;
    }
    if (['pen', 'underline', 'strike'].includes(t)) h += `<div class="prow"><span>Warna</span>${swatchRow('color', src.color)}</div><div class="prow"><span>Tebal</span><input type="range" data-key="width" min="0.5" max="${t === 'pen' ? 20 : 6}" step="0.5" value="${src.width}"></div>`;
    if (t === 'highlight') h += `<div class="prow"><span>Warna</span>${swatchRow('color', src.color, { list: HL_SWATCH })}</div>`;
    if (['rect', 'ellipse'].includes(t)) h += `<div class="prow"><span>Garis</span>${swatchRow('stroke', src.stroke, { none: true })}</div><div class="prow"><span>Isi</span>${swatchRow('fill', src.fill, { none: true })}</div><div class="prow"><span>Tebal</span><input type="range" data-key="width" min="0.5" max="20" step="0.5" value="${src.width}"></div>`;
    if (['line', 'arrow'].includes(t)) h += `<div class="prow"><span>Warna</span>${swatchRow('stroke', src.stroke)}</div><div class="prow"><span>Tebal</span><input type="range" data-key="width" min="0.5" max="20" step="0.5" value="${src.width}"></div>`;
    if (t === 'whiteout') h += `<div class="prow"><span>Warna</span>${swatchRow('fill', src.fill)}</div>`;
    if (t === 'note') h += `<div class="prow"><span>Warna</span>${swatchRow('color', src.color, { list: ['#ffd400', '#ff9ecf', '#7fe0ff', '#a6f16c', '#ffb35c'] })}</div>`;
    if (t === 'watermark') h += `<div class="prow"><span>Warna</span>${swatchRow('color', src.color)}</div><div class="prow"><span>Ukuran</span><input type="number" data-key="size" min="8" max="400" value="${src.size}"></div><div class="prow"><span>Sudut</span><input type="number" data-key="angle" min="-180" max="180" value="${src.angle}"></div>`;
    if (['text', 'pen', 'rect', 'ellipse', 'line', 'arrow', 'image', 'underline', 'strike', 'highlight', 'watermark'].includes(t))
      h += `<div class="prow"><span>Opasitas</span><input type="range" data-key="opacity" min="0.05" max="1" step="0.05" value="${src.opacity ?? 1}"></div>`;
  }
  if (s) {
    h += `<div class="pbtns">${s.a.type === 'text' ? `<button class="btn sm" data-act="edit">${icon('type')}Edit</button>` : ''}${s.a.type === 'note' ? `<button class="btn sm" data-act="editnote">${icon('note')}Edit</button>` : ''}
      <button class="btn sm" data-act="dup">${icon('copy')}Duplikat</button><button class="btn sm" data-act="front" title="Ke depan">${icon('up')}</button><button class="btn sm" data-act="back" title="Ke belakang">${icon('down')}</button>
      <button class="btn sm danger" data-act="del">${icon('trash')}Hapus</button></div>`;
  }
  box.innerHTML = h;
}
let propSnap = null;
function applyProp(key, val, final) {
  const s = selected();
  if (s) {
    if (!propSnap) propSnap = snapshot();
    s.a[key] = val;
    if (s.a.type === 'text') { if (key === 'size') { s.a.minW = 0; s.a.minH = 0; } measureText(s.a); }
    renderAnnots(s.p);
    if (editing && editing.a === s.a) styleEditor();
    if (final) { pushUndoSnap(propSnap); propSnap = null; refreshThumb(s.p.uid); }
    const tOpts = S.opts[s.a.type]; if (tOpts && (key in tOpts || key === 'family')) { tOpts[key] = val; saveOpts(); }
  } else {
    const o = S.opts[S.tool]; if (o) { o[key] = val; saveOpts(); }
  }
}
$('#props').addEventListener('click', e => {
  const sw = e.target.closest('.swatches button');
  if (sw) { const key = sw.parentElement.dataset.key; applyProp(key, sw.dataset.v || null, true); renderProps(); return; }
  const tg = e.target.closest('[data-tog]');
  if (tg) { const s = selected(); const src = s ? s.a : S.opts[S.tool]; applyProp(tg.dataset.tog, !src[tg.dataset.tog], true); renderProps(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const s = selected();
  if (act === 'sysfonts') { loadSystemFonts(true).then(() => renderProps()); return; }
  if (act === 'del') deleteSelected();
  if (act === 'dup') duplicateSelected();
  if (act === 'front') reorderSelected(1);
  if (act === 'back') reorderSelected(-1);
  if (act === 'edit' && s) editText(s.p, s.a, false);
  if (act === 'editnote' && s) editNote(s.p, s.a);
});
$('#props').addEventListener('input', e => {
  const el = e.target;
  if (el.matches('.swatches input[type=color]')) return applyProp(el.parentElement.dataset.key, el.value, false);
  if (el.dataset.key && el.type === 'range') applyProp(el.dataset.key, +el.value, false);
});
$('#props').addEventListener('change', e => {
  const el = e.target;
  if (el.matches('.swatches input[type=color]')) { applyProp(el.parentElement.dataset.key, el.value, true); renderProps(); return; }
  if (!el.dataset.key) return;
  const v = el.type === 'number' || el.type === 'range' ? +el.value : el.value;
  if (el.dataset.key === 'font') {
    if (v === '__load') { loadSystemFonts(true).then(() => renderProps()); return; }
    if (v.startsWith('sys:')) { applyProp('family', v.slice(4), false); applyProp('font', 'sys', true); }
    else applyProp('font', v, true);
    return;
  }
  applyProp(el.dataset.key, v, true);
});

/* =====================================================================
   THUMBNAILS, ORGANIZER & PAGE OPERATIONS
   ===================================================================== */
const thumbIO = new IntersectionObserver(ents => { for (const en of ents) if (en.isIntersecting) drawThumb(en.target); }, { root: $('#pane-thumbs'), rootMargin: '400px 0px' });
const orgIO = new IntersectionObserver(ents => { for (const en of ents) if (en.isIntersecting) drawThumb(en.target); }, { root: $('#orgGrid'), rootMargin: '400px 0px' });
function thumbHtml(p, i, cls, actions = false) {
  return `<div class="${cls} ${S.pageSel.has(p.uid) ? 'sel' : ''}" data-uid="${p.uid}" draggable="true">
    <div class="tbox"><canvas></canvas>${actions ? `<div class="oact"><button data-oa="ccw" title="Putar kiri">${icon('rotate-ccw')}</button><button data-oa="cw" title="Putar kanan">${icon('rotate-cw')}</button><button data-oa="dup" title="Duplikat">${icon('copy')}</button><button data-oa="del" title="Hapus">${icon('trash')}</button></div>` : ''}</div>
    <span class="tnum">${i + 1}</span></div>`;
}
function buildThumbs() {
  const d = cur(); const box = $('#thumbs');
  thumbIO.disconnect();
  if (!d) { box.innerHTML = ''; return; }
  box.innerHTML = d.pages.map((p, i) => thumbHtml(p, i, 'thumb' + (i === d.curPage ? ' cur' : ''))).join('');
  $$('.thumb', box).forEach(el => thumbIO.observe(el));
  $('#pageCount').textContent = d.pages.length;
}
function buildOrganizer() {
  const d = cur(); const g = $('#orgGrid');
  orgIO.disconnect();
  g.innerHTML = d.pages.map((p, i) => thumbHtml(p, i, 'og', true)).join('');
  $$('.og', g).forEach(el => orgIO.observe(el));
  updateOrgInfo();
}
function updateOrgInfo() { const d = cur(); if (d) $('#orgInfo').textContent = `${d.pages.length} halaman · ${S.pageSel.size} dipilih (Ctrl/Shift+klik untuk memilih banyak, seret untuk mengurutkan)`; }
async function drawThumb(el) {
  const d = cur(); if (!d) return;
  const p = pageByUid(d, el.dataset.uid); if (!p) return;
  const c = $('canvas', el);
  const src = d.sources[p.src];
  const { W, H, total } = dims(p);
  const tw = el.classList.contains('og') ? 150 : 130;
  const key = `${total}|${src.ver}|${JSON.stringify(p.annots).length}|${tw}`;
  if (c.dataset.key === key) return;
  c.dataset.key = key;
  const k = tw / Math.max(W, H * 0.77);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const pg = await getPdfPage(src, p.idx);
  const vp = pg.getViewport({ scale: k * dpr, rotation: total });
  const tmp = document.createElement('canvas'); tmp.width = Math.floor(vp.width); tmp.height = Math.floor(vp.height);
  try { await pg.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise; } catch { return; }
  if (p.annots.length) {
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tmp.width}" height="${tmp.height}" viewBox="0 0 ${W} ${H}">${p.annots.map(a => annotSvg(a, d)).join('')}</svg>`;
      const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      tmp.getContext('2d').drawImage(img, 0, 0, tmp.width, tmp.height);
    } catch { }
  }
  if (c.dataset.key !== key) return;
  c.width = tmp.width; c.height = tmp.height;
  c.style.width = tmp.width / dpr + 'px'; c.style.height = tmp.height / dpr + 'px';
  c.getContext('2d').drawImage(tmp, 0, 0);
}
const thumbTimers = {};
function refreshThumb(u) {
  clearTimeout(thumbTimers[u]);
  thumbTimers[u] = setTimeout(() => { $$(`[data-uid="${u}"]`).forEach(el => { if (el.matches('.thumb,.og')) drawThumb(el); }); }, 400);
}
function refreshAllThumbs() { $$('.thumb,.og').forEach(el => drawThumb(el)); }

let lastClickedUid = null;
function handleThumbClick(e, el, isOrg) {
  const d = cur(); const u = el.dataset.uid;
  const oa = e.target.closest('[data-oa]');
  if (oa) {
    const a = oa.dataset.oa;
    if (a === 'cw') rotatePages([u], 90); if (a === 'ccw') rotatePages([u], -90);
    if (a === 'dup') duplicatePages([u]); if (a === 'del') deletePages([u]);
    return;
  }
  if (e.shiftKey && lastClickedUid) {
    const i0 = pageIndex(d, lastClickedUid), i1 = pageIndex(d, u);
    for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) S.pageSel.add(d.pages[i].uid);
  } else if (e.ctrlKey || e.metaKey) {
    S.pageSel.has(u) ? S.pageSel.delete(u) : S.pageSel.add(u); lastClickedUid = u;
  } else {
    S.pageSel.clear(); if (isOrg) S.pageSel.add(u); lastClickedUid = u;
    if (!isOrg) goToPage(pageIndex(d, u));
  }
  $$('.thumb,.og').forEach(t => t.classList.toggle('sel', S.pageSel.has(t.dataset.uid)));
  updateOrgInfo();
}
$('#thumbs').addEventListener('click', e => { const el = e.target.closest('.thumb'); if (el) handleThumbClick(e, el, false); });
$('#orgGrid').addEventListener('click', e => { const el = e.target.closest('.og'); if (el) handleThumbClick(e, el, true); else { S.pageSel.clear(); $$('.og').forEach(t => t.classList.remove('sel')); updateOrgInfo(); } });
$('#orgGrid').addEventListener('dblclick', e => { const el = e.target.closest('.og'); if (!el || e.target.closest('[data-oa]')) return; const i = pageIndex(cur(), el.dataset.uid); toggleOrganize(false); setTimeout(() => goToPage(i), 50); });
for (const box of [$('#thumbs'), $('#orgGrid')]) {
  box.addEventListener('contextmenu', e => {
    const el = e.target.closest('.thumb,.og'); if (!el) return;
    e.preventDefault();
    if (!S.pageSel.has(el.dataset.uid)) { S.pageSel.clear(); S.pageSel.add(el.dataset.uid); $$('.thumb,.og').forEach(t => t.classList.toggle('sel', S.pageSel.has(t.dataset.uid))); }
    const us = [...S.pageSel]; const n = us.length; const d = cur();
    showCtx(e.clientX, e.clientY, [
      { t: 'Putar ke kanan', icon: 'rotate-cw', f: () => rotatePages(us, 90) },
      { t: 'Putar ke kiri', icon: 'rotate-ccw', f: () => rotatePages(us, -90) },
      { t: n > 1 ? `Duplikat ${n} halaman` : 'Duplikat', icon: 'copy', f: () => duplicatePages(us) },
      { t: 'Sisip halaman kosong setelahnya', icon: 'file-plus', f: () => insertBlank(pageIndex(d, us[us.length - 1]) + 1) },
      { t: n > 1 ? `Ekstrak ${n} halaman` : 'Ekstrak halaman', icon: 'file-out', f: () => extractPages(us) }, '-',
      { t: n > 1 ? `Hapus ${n} halaman` : 'Hapus halaman', icon: 'trash', f: () => deletePages(us) },
    ]);
  });
  // drag & drop reorder
  box.addEventListener('dragstart', e => {
    const el = e.target.closest('.thumb,.og'); if (!el) return;
    const u = el.dataset.uid;
    const uids = S.pageSel.has(u) ? cur().pages.filter(p => S.pageSel.has(p.uid)).map(p => p.uid) : [u];
    e.dataTransfer.setData('text/x-klm-pages', JSON.stringify(uids)); e.dataTransfer.effectAllowed = 'move';
    S.dragPages = uids;
  });
  box.addEventListener('dragover', e => {
    if (!S.dragPages) return;
    const el = e.target.closest('.thumb,.og'); if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(); const horiz = el.classList.contains('og');
    const after = horiz ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    $$('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) $$('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
  box.addEventListener('drop', e => {
    const uids = S.dragPages; S.dragPages = null;
    const el = e.target.closest('.thumb,.og');
    $$('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    if (!uids || !el) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect(); const horiz = el.classList.contains('og');
    const after = horiz ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    movePages(uids, el.dataset.uid, after);
  });
  box.addEventListener('dragend', () => { S.dragPages = null; $$('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
}
function pagesChanged({ keepScroll = true } = {}) {
  const d = cur();
  if (keepScroll) saveViewState();
  buildViewer(keepScroll); buildThumbs(); if (S.organize) buildOrganizer();
  renderAnnotList(); renderProps(); updateStatus();
}
function movePages(uids, targetUid, after) {
  const d = cur(); if (uids.includes(targetUid)) return;
  pushUndo();
  const moving = d.pages.filter(p => uids.includes(p.uid));
  const rest = d.pages.filter(p => !uids.includes(p.uid));
  let i = rest.findIndex(p => p.uid === targetUid) + (after ? 1 : 0);
  rest.splice(i, 0, ...moving);
  d.pages = rest;
  pagesChanged();
}
function rotateAnnots(p, deg, W, H) {
  const cw = deg === 90;
  const mp = (x, y) => cw ? [H - y, x] : [y, W - x];
  const keepSize = ['text', 'note', 'image', 'underline', 'strike'];
  for (const a of p.annots) {
    if (a.type === 'line' || a.type === 'arrow') { [a.x1, a.y1] = mp(a.x1, a.y1); [a.x2, a.y2] = mp(a.x2, a.y2); }
    else if (a.type === 'pen') a.pts = a.pts.map(([x, y]) => mp(x, y).map(r2));
    else if (a.type === 'watermark') [a.cx, a.cy] = mp(a.cx, a.cy);
    else if (keepSize.includes(a.type)) { const [cx, cy] = mp(a.x + a.w / 2, a.y + a.h / 2); a.x = cx - a.w / 2; a.y = cy - a.h / 2; }
    else { const [x0, y0] = mp(a.x, a.y), [x1, y1] = mp(a.x + a.w, a.y + a.h); a.x = Math.min(x0, x1); a.y = Math.min(y0, y1); a.w = Math.abs(x1 - x0); a.h = Math.abs(y1 - y0); }
  }
}
function rotatePages(uids, deg) {
  const d = cur(); if (!uids?.length) return;
  pushUndo();
  for (const u of uids) {
    const p = pageByUid(d, u); delete p._lines; delete p._blocks;
    for (let k = 0; k < Math.abs(deg) / 90; k++) { const dd = dims(p); rotateAnnots(p, Math.sign(deg) * 90, dd.W, dd.H); p.rot = (p.rot + Math.sign(deg) * 90 + 360) % 360; }
  }
  pagesChanged();
}
async function deletePages(uids) {
  const d = cur(); if (!uids?.length) return;
  if (uids.length >= d.pages.length) { toast('Tidak bisa menghapus semua halaman', 'err'); return; }
  if (uids.length > 1) { const r = await confirmDialog('Hapus halaman', `Hapus ${uids.length} halaman terpilih?`, [{ v: 'cancel', t: 'Batal' }, { v: 'ok', t: 'Hapus', primary: true }]); if (r !== 'ok') return; }
  pushUndo();
  d.pages = d.pages.filter(p => !uids.includes(p.uid));
  uids.forEach(u => S.pageSel.delete(u));
  d.curPage = clamp(d.curPage, 0, d.pages.length - 1);
  pagesChanged();
  toast(uids.length > 1 ? `${uids.length} halaman dihapus` : 'Halaman dihapus');
}
function duplicatePages(uids) {
  const d = cur(); pushUndo();
  const last = Math.max(...uids.map(u => pageIndex(d, u)));
  const copies = d.pages.filter(p => uids.includes(p.uid)).map(p => ({ ...structuredClone(p), uid: uid(), annots: p.annots.map(a => ({ ...structuredClone(a), id: uid() })) }));
  d.pages.splice(last + 1, 0, ...copies);
  pagesChanged();
}
async function insertBlank(at) {
  const d = cur(); if (at == null) at = d.curPage + 1;
  const ref = d.pages[clamp(at - 1, 0, d.pages.length - 1)];
  const { W, H } = dims(ref);
  const src = await loadSource(d, await blankPdfBytes(W, H), 'Halaman kosong');
  const [np] = await pagesFromSource(src);
  pushUndo();
  d.pages.splice(at, 0, np);
  pagesChanged();
  setTimeout(() => goToPage(at), 60);
}
async function insertPdf() {
  const d = cur(); if (!d) return;
  let files;
  if (IS_NATIVE) { const r = await native.openDialog(); if (!r?.length) return; files = r.map(x => ({ name: x.name, bytes: x.data })); }
  else { const fs = await pickFiles('#filePdf'); if (!fs?.length) return; files = await Promise.all(fs.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))); }
  const r = await confirmDialog('Sisipkan halaman', 'Di mana halaman baru disisipkan?', [{ v: 'cancel', t: 'Batal' }, { v: 'start', t: 'Di awal' }, { v: 'after', t: `Setelah hal. ${d.curPage + 1}` }, { v: 'end', t: 'Di akhir', primary: true }]);
  if (r === 'cancel') return;
  let at = r === 'start' ? 0 : r === 'after' ? d.curPage + 1 : d.pages.length;
  const snap = snapshot(); let added = 0;
  await withBusy('Menyisipkan…', async () => {
    for (const f of files) {
      const src = await loadSource(d, f.bytes, f.name); if (!src) continue;
      const pages = await pagesFromSource(src);
      d.pages.splice(at, 0, ...pages); at += pages.length; added += pages.length;
    }
  });
  if (!added) return;
  pushUndoSnap(snap); pagesChanged();
  toast(`${added} halaman ditambahkan`, 'ok');
}
function selectedOrAsk() { const d = cur(); return S.pageSel.size ? d.pages.filter(p => S.pageSel.has(p.uid)).map(p => p.uid) : null; }
async function extractPages(uids) {
  const d = cur();
  if (!uids) {
    const sel = selectedOrAsk();
    const def = sel ? sel.map(u => pageIndex(d, u) + 1).join(',') : String(d.curPage + 1);
    const r = await promptDialog('Ekstrak halaman', `Halaman yang diekstrak (1–${d.pages.length}), contoh: 1-3, 5`, def, { okText: 'Ekstrak' });
    if (!r) return;
    try { uids = parseRanges(r, d.pages.length).flat().map(i => d.pages[i].uid); } catch (e) { toast(e.message, 'err'); return; }
  }
  const pages = d.pages.filter(p => uids.includes(p.uid));
  if (!pages.length) return;
  const bytes = await withBusy('Mengekstrak…', () => buildPdfBytes(d, pages, { protect: false }));
  await openPdfBytes(bytes, stripExt(d.name) + ' (ekstrak).pdf', { dirty: true, noRecent: true });
  toast(`${pages.length} halaman diekstrak ke tab baru. Simpan untuk menyimpannya.`, 'ok', 4000);
}
async function splitPdf() {
  const d = cur(); if (!d) return;
  if ((await openDialog('#dlgSplit')) !== 'ok') return;
  const mode = $('input[name=splitMode]:checked').value;
  let groups = [];
  const N = d.pages.length;
  try {
    if (mode === 'each') groups = d.pages.map((_, i) => [i]);
    else if (mode === 'every') { const n = Math.max(1, +$('#splitN').value || 1); for (let i = 0; i < N; i += n) groups.push([...Array(Math.min(n, N - i)).keys()].map(k => i + k)); }
    else groups = parseRanges($('#splitRanges').value, N);
  } catch (e) { toast(e.message, 'err'); return; }
  if (!groups.length) { toast('Tidak ada rentang halaman', 'err'); return; }
  await withBusy('Memisahkan PDF…', async () => {
    const zip = new JSZip(); const base = stripExt(d.name);
    for (let g = 0; g < groups.length; g++) {
      busyText(`Memisahkan PDF… (${g + 1}/${groups.length})`);
      const grp = groups[g];
      const bytes = await buildPdfBytes(d, grp.map(i => d.pages[i]));
      const lbl = grp.length === 1 ? `hal ${grp[0] + 1}` : `hal ${grp[0] + 1}-${grp[grp.length - 1] + 1}`;
      zip.file(`${base} (${lbl}).pdf`, bytes);
    }
    const out = await zip.generateAsync({ type: 'uint8array' });
    await saveBytesAs(out, base + ' (terpisah).zip', 'zip');
  });
}
function toggleOrganize(on = !S.organize) {
  S.organize = on;
  $('#organizer').hidden = !on;
  $('#btnOrganize').classList.toggle('on', on);
  if (on) { S.pageSel.clear(); buildOrganizer(); }
  else { orgIO.disconnect(); $('#orgGrid').innerHTML = ''; }
}

/* ------------------------------ outline & annotation list ------------------------------ */
async function buildOutline() {
  const d = cur(); const box = $('#outline');
  box.innerHTML = '<p class="muted small">Memuat…</p>';
  try {
    const src = d.sources[d.primary];
    const ol = await src.pdf.getOutline();
    if (!ol?.length) { box.innerHTML = '<p class="muted small">Dokumen ini tidak memiliki penanda (bookmark).</p>'; return; }
    const make = items => items.map(it => `<button class="oi" data-dest='${esc(JSON.stringify(it.dest ?? null))}' title="${esc(it.title)}">${esc(it.title)}</button>${it.items?.length ? `<div class="ochild">${make(it.items)}</div>` : ''}`).join('');
    box.innerHTML = make(ol);
  } catch { box.innerHTML = '<p class="muted small">Penanda tidak tersedia.</p>'; }
}
$('#outline').addEventListener('click', async e => {
  const b = e.target.closest('.oi'); if (!b) return;
  const d = cur(); const src = d.sources[d.primary];
  try {
    let dest = JSON.parse(b.dataset.dest || 'null');
    if (typeof dest === 'string') dest = await src.pdf.getDestination(dest);
    if (!Array.isArray(dest)) return;
    const pi = typeof dest[0] === 'object' ? await src.pdf.getPageIndex(dest[0]) : dest[0];
    const i = d.pages.findIndex(p => p.src === d.primary && p.idx === pi);
    if (i >= 0) goToPage(i); else toast('Halaman tujuan sudah dihapus');
  } catch { }
});
function renderAnnotList() {
  const d = cur(); const box = $('#annotList'); if (!d) return;
  const rows = [];
  d.pages.forEach((p, i) => p.annots.forEach(a => {
    const col = a.color || a.stroke || a.fill || '#888';
    const txt = a.type === 'text' ? a.text : a.type === 'note' ? a.text : a.type === 'watermark' ? a.text : TYPE_LABEL[a.type];
    rows.push(`<button class="ai" data-u="${p.uid}" data-id="${a.id}"><span class="sw" style="background:${col}"></span><span class="at">${esc(txt || TYPE_LABEL[a.type])}</span><span class="ap">hal ${i + 1}</span></button>`);
  }));
  box.innerHTML = rows.length ? rows.join('') : '<p class="muted small">Belum ada anotasi. Gunakan alat di sebelah kiri untuk menambahkan teks, sorotan, gambar, tanda tangan, dll.</p>';
}
$('#annotList').addEventListener('click', e => {
  const b = e.target.closest('.ai'); if (!b) return;
  const d = cur(); const p = pageByUid(d, b.dataset.u); const a = p?.annots.find(x => x.id === b.dataset.id); if (!a) return;
  setTool('select');
  const info = pageEls.get(p.uid); const bb = annotBBox(a);
  viewer.scrollTo({ top: info.wrap.offsetTop + bb.y * d.scale - viewer.clientHeight / 3, behavior: 'smooth' });
  select(p, a);
});

/* =====================================================================
   SEARCH
   ===================================================================== */
function openSearch() { const d = cur(); if (!d) return; $('#searchbar').hidden = false; const i = $('#searchInput'); i.focus(); i.select(); const sel = window.getSelection()?.toString(); if (sel && sel.length < 80 && !sel.includes('\n')) { i.value = sel; runSearch(); } }
function closeSearch(silent) {
  $('#searchbar').hidden = true; S.search = null;
  for (const info of pageEls.values()) info.searchL.innerHTML = '';
  if (!silent) viewer.focus();
}
const runSearchDeb = debounce(() => runSearch(), 250);
async function runSearch() {
  const d = cur(); if (!d) return;
  const q0 = $('#searchInput').value;
  for (const info of pageEls.values()) info.searchL.innerHTML = '';
  if (!q0.trim()) { S.search = null; $('#searchInfo').textContent = ''; return; }
  const cs = $('#searchCase').checked;
  const norm = s => (cs ? s : s.toLowerCase());
  const q = norm(q0);
  const token = Symbol(); S.searchToken = token;
  const matches = [];
  $('#searchInfo').textContent = 'Mencari…';
  for (let pi = 0; pi < d.pages.length; pi++) {
    const p = d.pages[pi];
    const tc = await getText(d, p);
    if (S.searchToken !== token) return;
    let full = ''; const map = [];
    tc.items.forEach((it, ii) => {
      if (!('str' in it)) return;
      for (let c = 0; c < it.str.length; c++) map.push([ii, c]);
      full += it.str;
      if (it.hasEOL) { full += ' '; map.push([-1, 0]); }
    });
    const hay = norm(full);
    let from = 0, idx;
    const { total } = dims(p); const V = vpTransform(p.view, total);
    while ((idx = hay.indexOf(q, from)) !== -1) {
      from = idx + Math.max(1, q.length);
      const segs = new Map();
      for (let k = idx; k < idx + q.length && k < map.length; k++) {
        const [ii, c] = map[k]; if (ii < 0) continue;
        const sgm = segs.get(ii) || [c, c]; sgm[0] = Math.min(sgm[0], c); sgm[1] = Math.max(sgm[1], c); segs.set(ii, sgm);
      }
      const rects = [];
      for (const [ii, [c0, c1]] of segs) {
        const it = tc.items[ii];
        const g = itemGeom(it, tc.styles[it.fontName], V);
        const fam = tc.styles[it.fontName]?.fontFamily || 'sans-serif';
        rects.push(geomRect(g, textFrac(it.str, c0, fam), textFrac(it.str, c1 + 1, fam)));
      }
      if (rects.length) matches.push({ pi, rects });
    }
    if (pi % 10 === 9) $('#searchInfo').textContent = `Mencari… ${pi + 1}/${d.pages.length}`;
  }
  const curI = matches.findIndex(m => m.pi >= d.curPage);
  S.search = { matches, cur: Math.max(0, curI) };
  for (const p of d.pages) paintSearch(p);
  updateSearchInfo();
  if (matches.length) gotoMatch(S.search.cur);
}
const fracCtx = document.createElement('canvas').getContext('2d');
function textFrac(str, n, fam) {
  if (n <= 0) return 0; if (n >= str.length) return 1;
  fracCtx.font = `100px ${/serif/.test(fam) && !/sans/.test(fam) ? 'Times New Roman, serif' : /mono/.test(fam) ? 'Courier New, monospace' : 'Arial, Helvetica, sans-serif'}`;
  const tot = fracCtx.measureText(str).width || 1;
  return fracCtx.measureText(str.slice(0, n)).width / tot;
}
function paintSearch(p) {
  const d = cur(); const info = pageEls.get(p.uid); if (!info || !S.search) return;
  const pi = pageIndex(d, p.uid); const { W, H } = dims(p);
  info.searchL.innerHTML = S.search.matches.map((m, i) => m.pi !== pi ? '' : m.rects.map(r =>
    `<div class="${i === S.search.cur ? 'cur' : ''}" style="left:${r.x / W * 100}%;top:${r.y / H * 100}%;width:${r.w / W * 100}%;height:${r.h / H * 100}%"></div>`).join('')).join('');
}
function updateSearchInfo() { const s = S.search; $('#searchInfo').textContent = s ? (s.matches.length ? `${s.cur + 1} dari ${s.matches.length}` : 'Tidak ditemukan') : ''; }
function gotoMatch(i) {
  const d = cur(), s = S.search; if (!s?.matches.length) return;
  const prevPi = s.matches[s.cur]?.pi;
  s.cur = (i + s.matches.length) % s.matches.length;
  const m = s.matches[s.cur]; const p = d.pages[m.pi]; const info = pageEls.get(p.uid);
  if (prevPi != null && prevPi !== m.pi) paintSearch(d.pages[prevPi]);
  paintSearch(p); updateSearchInfo();
  const r = m.rects[0];
  const top = info.wrap.offsetTop + r.y * d.scale;
  if (top < viewer.scrollTop + 40 || top > viewer.scrollTop + viewer.clientHeight - 60) viewer.scrollTo({ top: top - viewer.clientHeight / 3 });
  const left = info.wrap.offsetLeft + r.x * d.scale;
  if (left < viewer.scrollLeft || left > viewer.scrollLeft + viewer.clientWidth - 40) viewer.scrollLeft = left - 60;
}
$('#searchInput').addEventListener('input', runSearchDeb);
$('#searchCase').addEventListener('change', runSearch);
$('#searchInput').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); if (!S.search) runSearch(); else gotoMatch(S.search.cur + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') closeSearch();
});

/* =====================================================================
   BUILD PDF (SAVE)
   ===================================================================== */
const KLM_MARK = '%KLMPDF-1';
const NEEDS_IMAGE = /[֐-ࣿऀ-෿฀-࿿က-႟ក-᢯יִ-﷿ﹰ-﻿️]|\p{Emoji_Presentation}/u;
const FALLBACK_FAMILIES = ['Segoe UI', 'Arial', 'Malgun Gothic', 'Microsoft YaHei', 'Microsoft JhengHei', 'Yu Gothic', 'Meiryo', 'MS Gothic', 'SimSun', 'Gulim', 'Batang', 'Arial Unicode MS', 'Segoe UI Symbol', 'Segoe UI Historic', 'Noto Sans CJK KR', 'Noto Sans KR', 'Noto Sans CJK SC', 'Noto Sans', 'WenQuanYi Zen Hei', 'IPAGothic', 'DejaVu Sans'];
const LIB_FILE = { helv: 'LiberationSans', times: 'LiberationSerif', cour: 'LiberationMono' };
const faceCache = new Map();
function libFace(font, bold, italic) {
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  const key = `lib:${font}:${style}`;
  if (!faceCache.has(key)) faceCache.set(key, fetch(new URL(`../fonts/${LIB_FILE[font] || LIB_FILE.helv}-${style}.ttf`, import.meta.url))
    .then(r => r.ok ? r.arrayBuffer() : null).then(b => b ? parseFont(b) : null).catch(() => null));
  return faceCache.get(key);
}
function pickSysFace(family, bold, italic) {
  const faces = S.sysFonts?.get(family); if (!faces?.length) return null;
  const isB = s => /bold|black|heavy|semibold|demibold/i.test(s), isI = s => /italic|oblique/i.test(s);
  const score = fd => (isB(fd.style) === !!bold ? 2 : 0) + (isI(fd.style) === !!italic ? 2 : 0) + (/regular|normal|book|^roman$/i.test(fd.style) ? 0.5 : 0) - (/light|thin|narrow|condensed/i.test(fd.style) ? 1 : 0);
  return [...faces].sort((a, b) => score(b) - score(a))[0];
}
async function sysFace(family, bold, italic) {
  const fd = pickSysFace(family, bold, italic); if (!fd) return null;
  const key = 'sys:' + fd.postscriptName;
  if (!faceCache.has(key)) faceCache.set(key, fd.blob().then(b => b.arrayBuffer()).then(buf => {
    const f = parseFont(buf, fd.postscriptName);
    return f && !f.cff && !f.restricted ? f : null;
  }).catch(() => null));
  const face = await faceCache.get(key);
  if (!face) return null;
  return { face, fauxB: !!bold && !/bold|black|heavy|semibold|demibold/i.test(fd.style), fauxI: !!italic && !/italic|oblique/i.test(fd.style) };
}
async function getStdFont(ctx, st) {
  const f = FONTS[st.font] || FONTS.helv;
  const name = f.std[(st.bold ? 1 : 0) + (st.italic ? 2 : 0)];
  return (ctx.fonts[name] ||= ctx.out.embedFont(PL.StandardFonts[name]));
}
async function faceChain(ctx, st) {
  const key = `${st.font}|${st.family || ''}|${st.bold ? 1 : 0}${st.italic ? 1 : 0}`;
  if (ctx.chains[key]) return ctx.chains[key];
  const chain = [];
  if (st.font === 'sys') { const s = await sysFace(st.family, st.bold, st.italic); if (s) chain.push({ kind: 'ttf', ...s }); }
  else chain.push({ kind: 'std', font: await getStdFont(ctx, st) });
  const lib = await libFace(st.font === 'sys' ? 'helv' : st.font, st.bold, st.italic);
  if (lib) chain.push({ kind: 'ttf', face: lib, fauxB: false, fauxI: false });
  for (const fam of FALLBACK_FAMILIES) if (S.sysFonts?.has(fam) && fam !== st.family) chain.push({ kind: 'lazy', fam });
  return (ctx.chains[key] = chain);
}
/* Pecah teks menjadi potongan per font. null = harus dirender sebagai gambar. */
async function textRuns(ctx, text, st) {
  text = String(text).replace(/\t/g, '    ');
  if (NEEDS_IMAGE.test(text)) return null;
  let chain = await faceChain(ctx, st);
  // seluruh baris bisa memakai huruf standar PDF? kalau tidak, pakai huruf tertanam untuk seluruh baris
  if (chain[0]?.kind === 'std') { try { chain[0].font.encodeText(text); return [{ c: chain[0], text, w: chain[0].font.widthOfTextAtSize(text, 1) }]; } catch { chain = chain.slice(1); } }
  const runs = [];
  for (const ch of text) {
    let pick = null;
    for (let i = 0; i < chain.length && !pick; i++) {
      let c = chain[i];
      if (c.kind === 'lazy') { const s = await sysFace(c.fam, st.bold, st.italic); chain[i] = c = s ? { kind: 'ttf', ...s } : { kind: 'none' }; }
      if (c.kind === 'std') { try { c.font.encodeText(ch); pick = c; } catch { } }
      else if (c.kind === 'ttf' && c.face.gid(ch.codePointAt(0))) pick = c;
    }
    if (!pick) return null;
    const last = runs[runs.length - 1];
    if (last && last.c === pick) last.text += ch; else runs.push({ c: pick, text: ch });
  }
  for (const r of runs) r.w = r.c.kind === 'std' ? r.c.font.widthOfTextAtSize(r.text, 1) : ctx.reg.width(r.c.face, r.text, 1);
  return runs;
}
function drawRuns(ctx, lp, runs, x, y, size, color, opacity = 1, angle = 0) {
  const r = angle * Math.PI / 180, ux = Math.cos(r), uy = Math.sin(r);
  const [cr, cg, cb] = hexToRgb01(color);
  let cx = x, cy = y;
  for (const run of runs) {
    if (run.c.kind === 'std') {
      lp.drawText(run.text, { x: cx, y: cy, size, font: run.c.font, color: PL.rgb(cr, cg, cb), opacity, rotate: PL.degrees(angle) });
    } else {
      const e = ctx.reg.entry(run.c.face); const fname = ctx.reg.attach(lp, e);
      const hex = ctx.reg.encode(e, run.text);
      const gs = opacity < 1 ? lp.maybeEmbedGraphicsState({ opacity, borderOpacity: opacity }) : null;
      const sk = run.c.fauxI ? 0.2 : 0;
      const ops = [PL.pushGraphicsState()];
      if (gs) ops.push(PL.setGraphicsState(gs));
      ops.push(PL.setFillingRgbColor(cr, cg, cb));
      if (run.c.fauxB) ops.push(PL.setStrokingRgbColor(cr, cg, cb), PL.setLineWidth(size * 0.03), PL.setTextRenderingMode(PL.TextRenderingMode.FillAndOutline));
      ops.push(PL.beginText(), PL.setFontAndSize(fname, size), PL.setTextMatrix(ux, uy, sk * ux - uy, sk * uy + ux, cx, cy),
        PL.showText(PL.PDFHexString.of(hex)), PL.endText(), PL.popGraphicsState());
      lp.pushOperators(...ops);
    }
    cx += ux * run.w * size; cy += uy * run.w * size;
  }
}
/* Teks yang butuh shaping (Arab, Ibrani, Thai, Hindi…) atau emoji: render tajam lewat browser */
async function textToPng(lines, cssFont, color, w, h, baseY, lineH, padX, k = 5) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * k)); c.height = Math.max(1, Math.ceil(h * k));
  const g = c.getContext('2d'); g.scale(k, k); g.font = cssFont; g.fillStyle = color; g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => g.fillText(l, padX, baseY + i * lineH));
  return new Promise(r => c.toBlob(b => b.arrayBuffer().then(x => r(new Uint8Array(x))), 'image/png'));
}
async function getImg(ctx, d, key) {
  if (ctx.imgs[key]) return ctx.imgs[key];
  const url = d.assets[key];
  const bytes = Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0));
  ctx.imgs[key] = /^data:image\/jpe?g/.test(url) ? await ctx.out.embedJpg(bytes) : await ctx.out.embedPng(bytes);
  return ctx.imgs[key];
}
function pageMatrix(p, view, total) {
  const { H } = dims(p);
  return mChain([1, 0, 0, -1, 0, H], mInv(vpTransform(view, total))); // ruang gambar (y ke atas, kiri-bawah halaman tampilan) → PDF
}
function displayRectToPdf(M, H, r) {
  const pts = [[r.x, H - r.y], [r.x + r.w, H - r.y], [r.x, H - r.y - r.h], [r.x + r.w, H - r.y - r.h]].map(([x, y]) => mApply(M, x, y));
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
async function drawTextAnnot(ctx, lp, a, H) {
  const op = a.opacity ?? 1;
  if (a.bg) lp.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: pdfColor(a.bg), opacity: op });
  const lines = String(a.text ?? '').split('\n');
  const st = { font: a.font || 'helv', family: a.family, bold: a.bold, italic: a.italic };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; if (!l) continue;
    const base = a.y + PAD + a.size * ASC + i * a.size * LH;
    const runs = await textRuns(ctx, l, st);
    if (runs) { drawRuns(ctx, lp, runs, a.x + PAD, H - base, a.size, a.color, op); continue; }
    // baris ini butuh shaping/emoji → gambar tajam satu baris
    const top = base - a.size * 1.0, lh = a.size * 1.35;
    const png = await textToPng([l], fontCss(a, a.size), a.color, a.w, lh, a.size * 1.0, 0, PAD);
    const img = await ctx.out.embedPng(png);
    lp.drawImage(img, { x: a.x, y: H - top - lh, width: a.w, height: lh, opacity: op });
    ctx.imaged++;
  }
}
async function drawWatermark(ctx, lp, a, H) {
  const r = a.angle * Math.PI / 180, ux = Math.cos(r), uy = Math.sin(r);
  const cx = a.cx, cy = H - a.cy;
  const runs = await textRuns(ctx, a.text, { font: 'helv', bold: true });
  if (runs) {
    const tw = runs.reduce((s, x) => s + x.w, 0) * a.size, ch = a.size * 0.35;
    drawRuns(ctx, lp, runs, cx - ux * tw / 2 + uy * ch, cy - uy * tw / 2 - ux * ch, a.size, a.color, a.opacity, a.angle);
    return;
  }
  mctx.font = fontCss({ font: 'helv', bold: true }, a.size);
  const w = mctx.measureText(a.text).width + 4, h = a.size * 1.3;
  const png = await textToPng([a.text], fontCss({ font: 'helv', bold: true }, a.size), a.color, w, h, a.size * 0.95, 0, 2);
  const img = await ctx.out.embedPng(png);
  lp.drawImage(img, { x: cx - ux * w / 2 + uy * h / 2, y: cy - uy * w / 2 - ux * h / 2, width: w, height: h, opacity: a.opacity, rotate: PL.degrees(a.angle) });
}
async function drawAnnotsPdf(ctx, lp, p, view, total, d) {
  const notes = [];
  if (!p.annots.length) return notes;
  const { H } = dims(p);
  const M = pageMatrix(p, view, total);
  if (lp.contentStream) lp.getContentStream(false); // pastikan anotasi masuk stream sendiri
  lp.pushOperators(PL.pushGraphicsState(), PL.concatTransformationMatrix(...M));
  for (const a of p.annots) {
    const op = a.opacity ?? 1;
    switch (a.type) {
      case 'text': await drawTextAnnot(ctx, lp, a, H); break;
      case 'rect':
        lp.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: a.fill ? pdfColor(a.fill) : undefined, borderColor: a.stroke ? pdfColor(a.stroke) : undefined, borderWidth: a.stroke ? a.width : 0, opacity: op, borderOpacity: op });
        break;
      case 'ellipse':
        lp.drawEllipse({ x: a.x + a.w / 2, y: H - a.y - a.h / 2, xScale: a.w / 2, yScale: a.h / 2, color: a.fill ? pdfColor(a.fill) : undefined, borderColor: a.stroke ? pdfColor(a.stroke) : undefined, borderWidth: a.stroke ? a.width : 0, opacity: op, borderOpacity: op });
        break;
      case 'line': case 'arrow': {
        const c = pdfColor(a.stroke);
        lp.drawLine({ start: { x: a.x1, y: H - a.y1 }, end: { x: a.x2, y: H - a.y2 }, thickness: a.width, color: c, opacity: op, lineCap: PL.LineCapStyle.Round });
        if (a.type === 'arrow') {
          const pts = arrowHead(a);
          lp.drawSvgPath(`M${pts[0][0]} ${pts[0][1]}L${pts[1][0]} ${pts[1][1]}L${pts[2][0]} ${pts[2][1]}`, { x: 0, y: H, borderColor: c, borderWidth: a.width, borderOpacity: op, borderLineCap: PL.LineCapStyle.Round });
        }
        break;
      }
      case 'pen':
        lp.drawSvgPath(penPath(a.pts), { x: 0, y: H, borderColor: pdfColor(a.color), borderWidth: a.width, borderOpacity: op, borderLineCap: PL.LineCapStyle.Round });
        break;
      case 'highlight':
        lp.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: pdfColor(a.color), opacity: a.opacity ?? 0.4, blendMode: PL.BlendMode.Multiply });
        break;
      case 'underline': case 'strike': {
        const y = a.type === 'underline' ? a.y + a.h - a.width / 2 : a.y + a.h * 0.55;
        lp.drawLine({ start: { x: a.x, y: H - y }, end: { x: a.x + a.w, y: H - y }, thickness: a.width, color: pdfColor(a.color), opacity: op });
        break;
      }
      case 'whiteout':
        lp.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: pdfColor(a.fill) });
        break;
      case 'image': {
        const img = await getImg(ctx, d, a.img);
        lp.drawImage(img, { x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, opacity: op });
        break;
      }
      case 'watermark': await drawWatermark(ctx, lp, a, H); break;
      case 'note': notes.push(a); break;
    }
  }
  lp.pushOperators(PL.popGraphicsState());
  // Catatan → anotasi komentar asli PDF (terbaca di Acrobat/Edge/Chrome)
  const refs = [];
  for (const a of notes) {
    const c = hexToRgb01(a.color);
    const annot = ctx.out.context.obj({
      Type: 'Annot', Subtype: 'Text', Rect: displayRectToPdf(M, H, a),
      Contents: PL.PDFHexString.fromText(a.text || ''), T: PL.PDFHexString.fromText('KLM PDF'), Name: 'Comment', C: c, F: 4, Open: false,
      M: PL.PDFString.fromDate(new Date()),
    });
    const ref = ctx.out.context.register(annot);
    let arr = lp.node.lookupMaybe(PL.PDFName.of('Annots'), PL.PDFArray);
    if (!arr) { arr = ctx.out.context.obj([]); lp.node.set(PL.PDFName.of('Annots'), arr); }
    arr.push(ref); refs.push(ref);
  }
  return refs;
}
/* Hapus teks asli di bawah "Edit teks" & "Tutup area" agar benar-benar hilang */
function redactPage(lp, p, view, total) {
  const rs = p.annots.filter(a => a.type === 'whiteout' || (a.type === 'text' && a.origRect)).map(a => a.type === 'whiteout' ? a : a.origRect);
  if (!rs.length) return 0;
  const { H } = dims(p); const M = pageMatrix(p, view, total);
  try { return removeTextInRects(lp, rs.map(r => displayRectToPdf(M, H, { x: r.x + 0.2, y: r.y + 0.2, w: r.w - 0.4, h: r.h - 0.4 }))); }
  catch (e) { console.warn('redact', e); return 0; }
}
async function rasterPageInto(out, d, p) {
  const src = d.sources[p.src]; const pg = await getPdfPage(src, p.idx);
  const vp = pg.getViewport({ scale: 3, rotation: 0 });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const jpg = await new Promise(r => c.toBlob(b => b.arrayBuffer().then(x => r(new Uint8Array(x))), 'image/jpeg', 0.95));
  const img = await out.embedJpg(jpg);
  const w0 = p.view[2] - p.view[0], h0 = p.view[3] - p.view[1];
  const lp = out.addPage([w0, h0]);
  lp.drawImage(img, { x: 0, y: 0, width: w0, height: h0 });
  return lp;
}
async function buildPdfBytes(d, pages = d.pages, { keepData = true, protect = true } = {}) {
  const libs = {};
  const load = async (id, key = id) => {
    if (!(key in libs)) {
      try { libs[key] = (await loadPdfLib(d.sources[id].bytes, d.sources[id].password || '')).doc; }
      catch (e) { console.warn('pdf-lib:', e); libs[key] = null; }
    }
    return libs[key];
  };
  const base = await load(d.primary);
  let out; const origPages = base ? base.getPages() : [];
  if (base) { out = base; for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i); }
  else out = await PL.PDFDocument.create();
  const ctx = { out, fonts: {}, imgs: {}, chains: {}, reg: new FontRegistry(out), imaged: 0 };
  const N = PL.PDFName.of;
  const used = new Set(); let rastered = 0; const usedAssets = new Set();
  for (const p of pages) {
    const { total } = dims(p);
    let lp, view = p.view, raster = false;
    if (base && p.src === d.primary && !used.has(p.idx)) { used.add(p.idx); lp = origPages[p.idx]; out.addPage(lp); }
    else {
      const L = p.src === d.primary ? await load(p.src, p.src + ':copy') : await load(p.src);
      if (L) { const [cp] = await out.copyPages(L, [p.idx]); lp = out.addPage(cp); }
      else { lp = await rasterPageInto(out, d, p); view = [0, 0, p.view[2] - p.view[0], p.view[3] - p.view[1]]; rastered++; raster = true; }
    }
    lp.node.delete(N('KLMPDF'));
    lp.setRotation(PL.degrees(total));
    if (p.annots.length) { // resource milik halaman sendiri (jangan ubah dict yang dipakai bersama halaman lain)
      const res = lp.node.Resources(); const cl = res ? res.clone(out.context) : out.context.obj({});
      for (const k of ['Font', 'XObject', 'ExtGState']) { const sub = cl.lookupMaybe(N(k), PL.PDFDict); if (sub) cl.set(N(k), sub.clone(out.context)); }
      lp.node.set(N('Resources'), cl);
    }
    if (!raster) redactPage(lp, p, view, total);
    const resKeys = () => { const r = lp.node.normalizedEntries().Resources; const o = {}; for (const k of ['Font', 'XObject', 'ExtGState']) { const dd = r.lookupMaybe(N(k), PL.PDFDict); o[k] = new Set(dd ? dd.keys().map(x => x.decodeText()) : []); } return o; };
    const before = p.annots.length ? resKeys() : null;
    const noteRefs = await drawAnnotsPdf(ctx, lp, p, view, total, d);
    // simpan data anotasi agar bisa diedit lagi saat dibuka ulang di KLM PDF
    if (keepData && p.annots.length && lp.contentStreamRef) {
      p.annots.forEach(a => a.img && usedAssets.add(a.img));
      const json = new TextEncoder().encode(JSON.stringify({ v: 1, total, raster, annots: p.annots }));
      const dRef = out.context.register(out.context.flateStream(json));
      const after = resKeys(); const added = {};
      for (const k of ['Font', 'XObject', 'ExtGState']) added[k] = [...after[k]].filter(x => !before[k].has(x));
      lp.node.set(N('KLMPDF'), out.context.obj({ S: lp.contentStreamRef, D: dRef, N: noteRefs, R: total, RF: added.Font, RX: added.XObject, RG: added.ExtGState }));
    }
  }
  ctx.reg.finalize();
  out.catalog.delete(N('KLMAssets'));
  if (keepData && usedAssets.size) {
    const map = {}; for (const k of usedAssets) map[k] = d.assets[k];
    out.catalog.set(N('KLMAssets'), out.context.register(out.context.flateStream(new TextEncoder().encode(JSON.stringify(map)))));
  }
  const m = d.meta;
  if (m) { out.setTitle(m.title || ''); out.setAuthor(m.author || ''); out.setSubject(m.subject || ''); out.setKeywords((m.keywords || '').split(',').map(s => s.trim()).filter(Boolean)); }
  try { out.setProducer('KLM PDF ' + APP_VERSION); out.setModificationDate(new Date()); } catch { }
  if (rastered) toast(`${rastered} halaman memakai enkripsi khusus yang tidak didukung, disimpan sebagai gambar`, '', 5000);
  try { gcPdf(out); } catch (e) { console.warn('gc', e); }
  let bytes;
  if (protect && d.protect) {
    await out.flush();
    await encryptPdfDoc(out, d.protect);
    bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
  } else bytes = await out.save();
  if (!keepData) return bytes;
  const mark = new TextEncoder().encode(`\n${KLM_MARK}\n`);
  const all = new Uint8Array(bytes.length + mark.length); all.set(bytes); all.set(mark, bytes.length);
  return all;
}

/* Buang objek yang tidak lagi direferensikan (halaman terhapus, data lama) — pdf-lib tidak melakukannya sendiri */
function gcPdf(doc) {
  const ctx = doc.context; const seen = new Set(); const queue = [];
  const visit = v => {
    if (v instanceof PL.PDFRef) { const k = v.objectNumber + ' ' + v.generationNumber; if (!seen.has(k)) { seen.add(k); queue.push(ctx.lookup(v)); } }
    else if (v instanceof PL.PDFDict) for (const [, x] of v.entries()) visit(x);
    else if (v instanceof PL.PDFArray) for (const x of v.asArray()) visit(x);
    else if (v instanceof PL.PDFStream) visit(v.dict);
  };
  const t = ctx.trailerInfo; [t.Root, t.Info, t.Encrypt].forEach(r => r && visit(r));
  while (queue.length) visit(queue.pop());
  let n = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.objectNumber + ' ' + ref.generationNumber)) { ctx.delete(ref); n++; }
  return n;
}

/* ------------------------------ buka kembali data KLM ------------------------------ */
function hasKlmMark(bytes) {
  const tail = bytes.subarray(Math.max(0, bytes.length - 1048576));
  return new TextDecoder('latin1').decode(tail).includes(KLM_MARK);
}
async function extractKlmData(bytes, password = '') {
  if (!hasKlmMark(bytes)) return null;
  const { doc } = await loadPdfLib(bytes, password);
  const N = PL.PDFName.of; const ctx = doc.context;
  const pages = new Map(); let assets = {};
  const sameRef = (a, b) => a instanceof PL.PDFRef && b instanceof PL.PDFRef && a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;
  doc.getPages().forEach((pg, i) => {
    const node = pg.node;
    const kd = node.lookupMaybe(N('KLMPDF'), PL.PDFDict); if (!kd) return;
    node.delete(N('KLMPDF'));
    try {
      const sRef = kd.get(N('S')); const R = kd.lookup(N('R'))?.asNumber?.() ?? 0;
      const raw = kd.lookup(N('D'));
      const data = JSON.parse(new TextDecoder().decode(PL.decodePDFRawStream(raw).decode()));
      if (data.raster || pg.getRotation().angle % 360 !== R % 360) return; // diubah aplikasi lain → biarkan apa adanya
      const cont = node.get(N('Contents')); const arr = ctx.lookup(cont);
      if (arr instanceof PL.PDFArray) {
        const idx = arr.asArray().findIndex(x => sameRef(x, sRef)); if (idx < 0) return;
        arr.remove(idx);
      } else if (sameRef(cont, sRef)) node.set(N('Contents'), ctx.obj([]));
      else return;
      const nArr = kd.lookup(N('N')); const annots = node.lookupMaybe(N('Annots'), PL.PDFArray);
      if (nArr instanceof PL.PDFArray && annots) for (const r of nArr.asArray()) { const k = annots.asArray().findIndex(x => sameRef(x, r)); if (k >= 0) annots.remove(k); }
      const res = node.Resources();
      for (const [k, key] of [['RF', 'Font'], ['RX', 'XObject'], ['RG', 'ExtGState']]) {
        const names = kd.lookup(N(k)); const dd = res?.lookupMaybe(N(key), PL.PDFDict);
        if (names instanceof PL.PDFArray && dd) for (const nm of names.asArray()) if (nm instanceof PL.PDFName) dd.delete(nm);
      }
      pages.set(i, data.annots || []);
    } catch (e) { console.warn('KLM data', e); }
  });
  try {
    const as = doc.catalog.lookup(N('KLMAssets'));
    if (as) assets = JSON.parse(new TextDecoder().decode(PL.decodePDFRawStream(as).decode()));
    doc.catalog.delete(N('KLMAssets'));
  } catch { }
  if (!pages.size) return null;
  try { gcPdf(doc); } catch { }
  return { bytes: await doc.save(), pages, assets };
}

/* ------------------------------ save ------------------------------ */
async function saveDoc(d = cur(), asNew = false) {
  if (!d) return false;
  endTextEdit();
  let bytes;
  try { bytes = await withBusy('Menyimpan…', () => buildPdfBytes(d)); }
  catch (e) { console.error(e); toast('Gagal menyimpan: ' + (e?.message || e), 'err', 6000); return false; }
  try {
    if (IS_NATIVE) {
      let path = d.path;
      if (asNew || !path) { path = await native.saveAs(d.name, bytes, 'pdf'); if (!path) return false; }
      else await native.writeFile(path, bytes);
      d.path = path; d.name = baseName(path);
    } else if (window.showSaveFilePicker || (d.handle && d.handle.createWritable)) {
      let h = d.handle;
      if (asNew || !h || !h.createWritable) {
        h = await showSaveFilePicker({ suggestedName: d.name, types: [{ description: 'Dokumen PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      }
      if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
        if ((await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('Izin menulis file ditolak');
      }
      const w = await h.createWritable(); await w.write(bytes); await w.close();
      d.handle = h; d.name = h.name;
    } else {
      downloadBytes(bytes, d.name, 'application/pdf');
    }
  } catch (e) {
    if (e?.name === 'AbortError') return false;
    console.error(e); toast('Gagal menyimpan: ' + (e?.message || e), 'err', 6000); return false;
  }
  d.dirty = false; d.size = bytes.length;
  renderTabs(); updateStatus();
  toast('Tersimpan: ' + d.name, 'ok');
  addRecent(d, d.sources[d.primary]).catch(() => { });
  return true;
}
function downloadBytes(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function saveBytesAs(bytes, name, kind) {
  const types = { pdf: ['application/pdf', '.pdf', 'Dokumen PDF'], zip: ['application/zip', '.zip', 'Arsip ZIP'], png: ['image/png', '.png', 'Gambar PNG'], jpg: ['image/jpeg', '.jpg', 'Gambar JPG'] }[kind];
  try {
    if (IS_NATIVE) { const p = await native.saveAs(name, bytes, kind); if (p) toast('Tersimpan: ' + baseName(p), 'ok'); return; }
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: types[2], accept: { [types[0]]: [types[1]] } }] });
      const w = await h.createWritable(); await w.write(bytes); await w.close(); toast('Tersimpan: ' + h.name, 'ok'); return;
    }
    downloadBytes(bytes, name, types[0]);
  } catch (e) { if (e?.name !== 'AbortError') toast('Gagal menyimpan: ' + e.message, 'err'); }
}

/* ------------------------------ print & export ------------------------------ */
async function renderFinalPages(d, indices, dpi, fmt, onEach) {
  const bytes = await buildPdfBytes(d, indices.map(i => d.pages[i]), { keepData: false, protect: false });
  const pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes }).promise;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const vp = pg.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise(r => c.toBlob(r, fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.92));
      await onEach(blob, i, vp.width * 72 / dpi, vp.height * 72 / dpi);
      c.width = 0;
    }
  } finally { closePdf(pdf); }
}
const MARKUP_TYPES = new Set(['highlight', 'underline', 'strike', 'note', 'pen', 'rect', 'ellipse', 'line', 'arrow']);
async function printDoc() {
  const d = cur(); if (!d) return;
  endTextEdit();
  const pages = d.pages.slice();
  const sizes = pages.map(p => { const { W, H } = dims(p); return { w: W, h: H }; });
  const selection = S.pageSel.size ? pages.map((p, i) => S.pageSel.has(p.uid) ? i : -1).filter(i => i >= 0) : null;
  await openPrintDialog({
    title: d.name, pageCount: pages.length, curPage: clamp(d.curPage, 0, pages.length - 1), sizes, selection,
    native: IS_NATIVE ? native : null, toast, closePdf,
    getPdf: async markup => {
      const list = markup ? pages : pages.map(p => ({ ...p, annots: p.annots.filter(a => !MARKUP_TYPES.has(a.type)) }));
      const bytes = await buildPdfBytes(d, list, { keepData: false, protect: false });
      return pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes }).promise;
    },
  });
}
async function exportImages() {
  const d = cur(); if (!d) return;
  if ((await openDialog('#dlgExport')) !== 'ok') return;
  const fmt = $('#exFormat').value, dpi = +$('#exDpi').value;
  let idx;
  try { idx = $('#exRange').value.trim() ? parseRanges($('#exRange').value, d.pages.length).flat() : d.pages.map((_, i) => i); }
  catch (e) { toast(e.message, 'err'); return; }
  if (!idx.length) return;
  const base = stripExt(d.name);
  await withBusy('Mengekspor…', async () => {
    const files = [];
    await renderFinalPages(d, idx, dpi, fmt, async (blob, i) => { busyText(`Mengekspor… ${i}/${idx.length}`); files.push({ name: `${base} - hal ${idx[i - 1] + 1}.${fmt}`, blob }); });
    if (files.length === 1) await saveBytesAs(new Uint8Array(await files[0].blob.arrayBuffer()), files[0].name, fmt);
    else {
      const zip = new JSZip(); for (const f of files) zip.file(f.name, f.blob);
      await saveBytesAs(await zip.generateAsync({ type: 'uint8array' }), `${base} (gambar).zip`, 'zip');
    }
  });
}

/* =====================================================================
   DIALOG TOOLS: signature, stamp, watermark, page numbers, props, form
   ===================================================================== */
/* --- signature --- */
const pad = $('#signPad'), pctx = pad.getContext('2d');
let signMode = 'draw', signDirty = false, signUpload = null, signFont = 0;
const SIGN_FONTS = ['"Segoe Script","Brush Script MT","Lucida Handwriting",cursive', '"Lucida Handwriting","Segoe Script",cursive', '"Brush Script MT","Segoe Print",cursive', '"Segoe Print","Comic Sans MS",cursive'];
function clearPad() { pctx.clearRect(0, 0, pad.width, pad.height); signDirty = false; }
(function initPad() {
  let drawing = false, last = null;
  const pos = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.addEventListener('pointerdown', e => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); pctx.beginPath(); pctx.arc(last[0], last[1], +$('#signWidth').value * 1.2, 0, Math.PI * 2); pctx.fillStyle = $('#signColor').value; pctx.fill(); signDirty = true; });
  pad.addEventListener('pointermove', e => {
    if (!drawing) return; const p = pos(e);
    const pr = e.pressure && e.pointerType === 'pen' ? 0.5 + e.pressure : 1;
    pctx.strokeStyle = $('#signColor').value; pctx.lineWidth = +$('#signWidth').value * 2.4 * pr; pctx.lineCap = pctx.lineJoin = 'round';
    pctx.beginPath(); pctx.moveTo(...last); pctx.lineTo(...p); pctx.stroke(); last = p;
  });
  pad.addEventListener('pointerup', () => drawing = false);
  $('#signClear').onclick = clearPad;
  $('#signTabs').onclick = e => { const b = e.target.closest('[data-st]'); if (!b) return; signMode = b.dataset.st; $$('#signTabs button').forEach(x => x.classList.toggle('on', x === b)); $$('.sign-pane').forEach(p => p.hidden = p.dataset.sp !== signMode); if (signMode === 'type') { renderSignFonts(); $('#signText').focus(); } };
  $('#signText').addEventListener('input', renderSignFonts);
  $('#signFonts').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; signFont = +b.dataset.f; renderSignFonts(); };
  $('#signUpload').onclick = async () => { const fs = await pickFiles('#fileImg'); if (!fs) return; const fr = new FileReader(); fr.onload = () => { signUpload = fr.result; $('#signUpload').style.backgroundImage = `url(${signUpload})`; $('#signUpload').textContent = ''; }; fr.readAsDataURL(fs[0]); };
  $('#signUse').onclick = useSignature;
  $('#savedSigs').onclick = e => {
    const del = e.target.closest('b'); const ss = e.target.closest('.ss'); if (!ss) return;
    const list = getSigs();
    if (del) { list.splice(+ss.dataset.i, 1); setSigs(list); renderSavedSigs(); return; }
    const s = list[+ss.dataset.i]; $('#dlgSign').close(); placeSig(s);
  };
})();
function renderSignFonts() {
  const t = $('#signText').value || 'Tanda Tangan';
  $('#signFonts').innerHTML = SIGN_FONTS.map((f, i) => `<button type="button" data-f="${i}" class="${i === signFont ? 'on' : ''}" style="font-family:${esc(f)};color:${$('#signColor').value}">${esc(t)}</button>`).join('');
}
const getSigs = () => { try { return JSON.parse(localStorage.getItem('klmpdf.sigs') || '[]'); } catch { return []; } };
const setSigs = l => { try { localStorage.setItem('klmpdf.sigs', JSON.stringify(l.slice(0, 8))); } catch { toast('Penyimpanan tanda tangan penuh', 'err'); } };
function renderSavedSigs() {
  const l = getSigs();
  $('#savedSigs').innerHTML = l.length ? l.map((s, i) => `<div class="ss" data-i="${i}" style="background-image:url(${s.img})" title="Gunakan"><b>×</b></div>`).join('') : '<span class="muted small">belum ada</span>';
}
function trimCanvas(c) {
  const g = c.getContext('2d'); const { width: w, height: h } = c; const data = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
async function useSignature() {
  let canvas = null;
  if (signMode === 'draw') { if (!signDirty) return toast('Gambar tanda tangan dulu', 'err'); canvas = trimCanvas(pad); }
  else if (signMode === 'type') {
    const t = $('#signText').value.trim(); if (!t) return toast('Ketik nama dulu', 'err');
    const c = document.createElement('canvas'); c.width = 1400; c.height = 300; const g = c.getContext('2d');
    g.font = `120px ${SIGN_FONTS[signFont]}`; g.fillStyle = $('#signColor').value; g.textBaseline = 'middle'; g.fillText(t, 30, 160);
    canvas = trimCanvas(c);
  } else {
    if (!signUpload) return toast('Pilih gambar dulu', 'err');
    const img = await loadImage(signUpload);
    const c = document.createElement('canvas'); const k = Math.min(1, 1400 / img.naturalWidth); c.width = img.naturalWidth * k; c.height = img.naturalHeight * k;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
    if ($('#signRemoveBg').checked) {
      const id = g.getImageData(0, 0, c.width, c.height); const px = id.data;
      for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; if (l > 215) px[i + 3] = 0; else if (l > 170) px[i + 3] = Math.round(px[i + 3] * (215 - l) / 45); }
      g.putImageData(id, 0, 0);
    }
    canvas = trimCanvas(c);
  }
  if (!canvas) return toast('Tanda tangan kosong', 'err');
  const s = { img: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
  if ($('#signSave').checked) { const l = getSigs(); if (!l.some(x => x.img === s.img)) { l.unshift(s); setSigs(l); } }
  $('#dlgSign').close();
  placeSig(s);
}
function placeSig(s) { let w = 160, h = w * s.h / s.w; if (h > 80) { h = 80; w = h * s.w / s.h; } startPlace(s.img, w, h, 'tanda tangan'); }
function cmdSignature() { if (!cur()) return; clearPad(); renderSavedSigs(); renderSignFonts(); showDlg('#dlgSign'); }

/* --- stamp --- */
const STAMPS = [['DISETUJUI', '#12805c'], ['DITOLAK', '#c0262d'], ['LUNAS', '#1473e6'], ['RAHASIA', '#c0262d'], ['DRAFT', '#6b6b6b'], ['SALINAN', '#6e49cb'], ['DITERIMA', '#12805c'], ['PENTING', '#e68619']];
function stampImage(text, color, withDate) {
  const c = document.createElement('canvas'); const g = c.getContext('2d');
  const fs = 64; g.font = `800 ${fs}px Arial, Helvetica, sans-serif`;
  const tw = g.measureText(text).width; const date = withDate ? todayStr() : '';
  const W = Math.max(tw + 70, 300), Hh = withDate ? 150 : 110;
  c.width = W; c.height = Hh;
  g.strokeStyle = g.fillStyle = color; g.lineWidth = 7;
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  rr(6, 6, W - 12, Hh - 12, 16); g.stroke();
  g.lineWidth = 2.5; rr(16, 16, W - 32, Hh - 32, 10); g.stroke();
  g.font = `800 ${fs}px Arial, Helvetica, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, W / 2, withDate ? 62 : Hh / 2 + 2);
  if (withDate) { g.font = `700 28px Arial, Helvetica, sans-serif`; g.fillText(date, W / 2, 112); }
  return { img: c.toDataURL('image/png'), w: W, h: Hh };
}
function cmdStamp() {
  if (!cur()) return;
  const withDate = $('#stampDate').checked;
  $('#stampGrid').innerHTML = STAMPS.map(([t, c], i) => `<button type="button" data-s="${i}"><img src="${stampImage(t, c, withDate).img}" alt="${t}"></button>`).join('');
  showDlg('#dlgStamp');
}
$('#stampDate').addEventListener('change', () => { if ($('#dlgStamp').open) cmdStamp(); });
$('#stampGrid').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b) return; const [t, c] = STAMPS[+b.dataset.s]; const s = stampImage(t, c, $('#stampDate').checked); $('#dlgStamp').close(); startPlace(s.img, s.w * 0.45, s.h * 0.45, 'stempel'); });
$('#stampUse').addEventListener('click', () => { const t = $('#stampText').value.trim().toUpperCase(); if (!t) return toast('Isi teks stempel', 'err'); const s = stampImage(t, $('#stampColor').value, $('#stampDate').checked); $('#dlgStamp').close(); startPlace(s.img, s.w * 0.45, s.h * 0.45, 'stempel'); });

/* --- watermark --- */
async function cmdWatermark() {
  const d = cur(); if (!d) return;
  if ((await openDialog('#dlgWatermark')) !== 'ok') return;
  const text = $('#wmText').value.trim(); if (!text) return;
  const o = { text, size: +$('#wmSize').value || 72, angle: +$('#wmAngle').value || 0, color: $('#wmColor').value, opacity: +$('#wmOpacity').value };
  Object.assign(S.opts.watermark, o); saveOpts();
  pushUndo();
  const pages = $('#wmPages').value === 'cur' ? [d.pages[d.curPage]] : d.pages;
  for (const p of pages) { const { W, H } = dims(p); p.annots.push({ id: uid(), type: 'watermark', ...o, cx: W / 2, cy: H / 2 }); renderAnnots(p); refreshThumb(p.uid); }
  renderAnnotList();
  toast(`Watermark ditambahkan ke ${pages.length} halaman`, 'ok');
}
/* --- page numbers --- */
async function cmdPageNumbers() {
  const d = cur(); if (!d) return;
  if ((await openDialog('#dlgPagenum')) !== 'ok') return;
  const fmt = $('#pnFormat').value, pos = $('#pnPos').value, size = +$('#pnSize').value || 10, start = +$('#pnStart').value || 1, skip = +$('#pnSkip').value || 0;
  pushUndo();
  const totalN = d.pages.length - skip;
  d.pages.forEach((p, i) => {
    if (i < skip) return;
    const n = i - skip + start;
    const text = fmt.replace('{n}', n).replace('{t}', totalN + start - 1);
    const { W, H } = dims(p);
    const a = { id: uid(), type: 'text', text, font: 'helv', size, color: '#000000', bold: false, italic: false, bg: null, opacity: 1, x: 0, y: 0 };
    measureText(a);
    const m = 28;
    a.x = pos[1] === 'l' ? m : pos[1] === 'r' ? W - m - a.w : (W - a.w) / 2;
    a.y = pos[0] === 't' ? m * 0.7 : H - m * 0.7 - a.h;
    p.annots.push(a); renderAnnots(p); refreshThumb(p.uid);
  });
  renderAnnotList();
  toast('Nomor halaman ditambahkan', 'ok');
}
/* --- document properties --- */
async function cmdDocProps() {
  const d = cur(); if (!d) return;
  const src = d.sources[d.primary]; const info = d.info || {};
  const m = d.meta || { title: info.Title || '', author: info.Author || '', subject: info.Subject || '', keywords: info.Keywords || '' };
  $('#mTitle').value = m.title; $('#mAuthor').value = m.author; $('#mSubject').value = m.subject; $('#mKeywords').value = m.keywords;
  const pd = s => { try { return pdfjsLib.PDFDateString.toDateObject(s)?.toLocaleString('id-ID') || '-'; } catch { return '-'; } };
  const p0 = d.pages[d.curPage]; const { W, H } = dims(p0);
  const rows = [['File', d.name], ['Lokasi', d.path || (d.handle ? '(file lokal)' : '-')], ['Ukuran file', fmtBytes(d.size)], ['Jumlah halaman', d.pages.length],
    ['Ukuran halaman', `${(W / 72 * 25.4).toFixed(0)} × ${(H / 72 * 25.4).toFixed(0)} mm`], ['Versi PDF', info.PDFFormatVersion || '-'], ['Dibuat oleh', info.Creator || '-'], ['Producer', info.Producer || '-'],
    ['Tanggal dibuat', pd(info.CreationDate)], ['Diubah', pd(info.ModDate)], ['Terenkripsi', src.openPassword ? 'Ya (kata sandi)' : 'Tidak'], ['Saat disimpan', d.protect ? 'Dikunci kata sandi (AES-256)' : 'Tanpa kata sandi']];
  $('#propInfo').innerHTML = rows.map(([k, v]) => `<span>${k}</span><span>${esc(v)}</span>`).join('');
  if ((await openDialog('#dlgProps')) !== 'ok') return;
  d.meta = { title: $('#mTitle').value, author: $('#mAuthor').value, subject: $('#mSubject').value, keywords: $('#mKeywords').value };
  markDirty(d); toast('Properti diperbarui — simpan untuk menerapkan', 'ok');
}
/* --- forms --- */
async function cmdFillForm() {
  const d = cur(); if (!d) return;
  const src = d.sources[d.primary];
  let lib;
  try { lib = (await loadPdfLib(src.bytes, src.password || '')).doc; } catch (e) { toast('Formulir tidak bisa diproses: ' + e.message, 'err'); return; }
  let fields = [];
  try { fields = lib.getForm().getFields(); } catch { }
  if (!fields.length) {
    await confirmDialog('Isi formulir', 'PDF ini tidak memiliki kolom formulir interaktif. Gunakan alat "Tambah teks" (T), centang ✓, atau tanda tangan untuk mengisi formulir biasa.', [{ v: 'ok', t: 'Mengerti', primary: true }]);
    setTool('text'); return;
  }
  const box = $('#formFields');
  const html = [];
  fields.forEach((f, i) => {
    const name = f.getName(); const label = esc(name.split('.').pop());
    const T = f.constructor.name;
    try {
      if (f instanceof PL.PDFTextField) html.push(`<label class="field"><span>${label}</span>${f.isMultiline() ? `<textarea data-f="${i}" rows="3">${esc(f.getText() || '')}</textarea>` : `<input data-f="${i}" value="${esc(f.getText() || '')}">`}</label>`);
      else if (f instanceof PL.PDFCheckBox) html.push(`<label class="field chk"><input type="checkbox" data-f="${i}" ${f.isChecked() ? 'checked' : ''}> ${label}</label>`);
      else if (f instanceof PL.PDFDropdown) { const sel = f.getSelected()[0]; html.push(`<label class="field"><span>${label}</span><select data-f="${i}"><option value=""></option>${f.getOptions().map(o => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`); }
      else if (f instanceof PL.PDFRadioGroup) { const sel = f.getSelected(); html.push(`<label class="field"><span>${label}</span><select data-f="${i}"><option value=""></option>${f.getOptions().map(o => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`); }
      else if (f instanceof PL.PDFOptionList) { const sel = f.getSelected(); html.push(`<label class="field"><span>${label}</span><select data-f="${i}" multiple size="3">${f.getOptions().map(o => `<option ${sel.includes(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`); }
      else html.push(`<label class="field"><span>${label}</span><input disabled value="(${T})"></label>`);
    } catch { }
  });
  box.innerHTML = html.join('');
  if ((await openDialog('#dlgForm')) !== 'ok') return;
  await withBusy('Menerapkan isian formulir…', async () => {
    $$('[data-f]', box).forEach(el => {
      const f = fields[+el.dataset.f];
      try {
        if (f instanceof PL.PDFTextField) f.setText(el.value);
        else if (f instanceof PL.PDFCheckBox) el.checked ? f.check() : f.uncheck();
        else if (f instanceof PL.PDFDropdown) el.value ? f.select(el.value) : f.clear();
        else if (f instanceof PL.PDFRadioGroup) el.value ? f.select(el.value) : f.clear();
        else if (f instanceof PL.PDFOptionList) f.select([...el.selectedOptions].map(o => o.value));
      } catch (e) { console.warn(e); }
    });
    const form = lib.getForm();
    const helv = await lib.embedFont(PL.StandardFonts.Helvetica);
    const fctx = { out: lib, fonts: {}, imgs: {}, chains: {}, reg: new FontRegistry(lib), imaged: 0 };
    for (const f of fields) {
      try { f.defaultUpdateAppearances?.(helv); }
      catch { // nilai berisi aksara di luar Helvetica (mis. Korea, Kirilik) → tampilan dibuat sendiri
        const txt = f instanceof PL.PDFTextField ? (f.getText() || '') : f instanceof PL.PDFDropdown ? (f.getSelected()[0] || '') : null;
        if (txt != null) { try { await unicodeAppearance(fctx, f, txt, helv); } catch (e) { console.warn('appearance', e); } }
      }
    }
    fctx.reg.finalize();
    if ($('#formFlatten').checked) { try { form.flatten({ updateFieldAppearances: false }); } catch (e) { console.warn(e); } }
    const bytes = await lib.save({ updateFieldAppearances: false });
    // ganti sumber utama dengan versi yang sudah diisi
    const oldPdf = src.pdf;
    src.bytes = bytes; src.password = null; src.pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise; src.pages = {}; src.ver++;
    closePdf(oldPdf);
    markDirty(d);
    for (const p of d.pages) if (p.src === src.id) { const info = pageEls.get(p.uid); if (info) info.key = info.textKey = null; refreshThumb(p.uid); }
    for (const u of visible) queueRender(u);
  });
  toast('Formulir diisi. Simpan untuk menyimpan hasilnya.', 'ok');
}

async function unicodeAppearance(fctx, f, text, helv) {
  const ctx = fctx.out.context;
  const da = f.acroField.getDefaultAppearance?.() || '';
  const mfs = /([\d.]+)\s+Tf/.exec(da); const fs0 = mfs ? parseFloat(mfs[1]) : 0;
  const mc = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const col = mc ? [+mc[1], +mc[2], +mc[3]] : [0, 0, 0];
  const multi = f instanceof PL.PDFTextField && f.isMultiline();
  const lines = multi ? String(text).split('\n') : [String(text).replace(/\n/g, ' ')];
  for (const w of f.acroField.getWidgets()) {
    const r = w.getRectangle(); const W = r.width, H = r.height;
    const size = fs0 || Math.max(4, Math.min(12, (multi ? 12 : H * 0.65)));
    const fontRes = {};
    const ops = [];
    const rgbOf = c => !c ? null : c.length === 1 ? [c[0], c[0], c[0]] : c.length === 3 ? c : c.length === 4 ? [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])] : null;
    try {
      const mk = w.getAppearanceCharacteristics?.();
      const bg = rgbOf(mk?.getBackgroundColor?.()), bc = rgbOf(mk?.getBorderColor?.());
      const bw = w.getBorderStyle?.()?.getWidth?.() ?? 1;
      if (bg) ops.push(PL.setFillingRgbColor(...bg), PL.rectangle(0, 0, W, H), PL.fill());
      if (bc && bw) ops.push(PL.setStrokingRgbColor(...bc), PL.setLineWidth(bw), PL.rectangle(bw / 2, bw / 2, W - bw, H - bw), PL.stroke());
    } catch { }
    ops.push(PL.beginMarkedContent('Tx'), PL.pushGraphicsState(), PL.rectangle(1, 1, W - 2, H - 2), PL.clip(), PL.endPath(), PL.setFillingRgbColor(...col), PL.beginText());
    for (let i = 0; i < lines.length; i++) {
      const runs = lines[i] ? await textRuns(fctx, lines[i], { font: 'helv' }) : [];
      if (!runs) continue;
      const y = multi ? H - 2 - size * (0.9 + i * 1.15) : (H - size) / 2 + size * 0.22;
      let x = 2;
      for (const run of runs) {
        let name, hex;
        if (run.c.kind === 'std') { name = 'Helv'; fontRes.Helv = helv.ref; hex = helv.encodeText(run.text); }
        else { const e = fctx.reg.entry(run.c.face); name = e.name; fontRes[name] = e.ref; hex = PL.PDFHexString.of(fctx.reg.encode(e, run.text)); }
        ops.push(PL.setFontAndSize(name, size), PL.setTextMatrix(1, 0, 0, 1, x, y), PL.showText(hex));
        x += run.w * size;
      }
    }
    ops.push(PL.endText(), PL.popGraphicsState(), PL.endMarkedContent());
    const xo = ctx.formXObject(ops, { BBox: ctx.obj([0, 0, W, H]), Resources: ctx.obj({ Font: fontRes }) });
    w.setNormalAppearance(ctx.register(xo));
  }
}

/* --- scan dokumen --- */
const PAPER = { a4: [595.28, 841.89], letter: [612, 792], f4: [609.45, 935.43] };
async function scanToPdfBytes(pages, paper) {
  const d = await PL.PDFDocument.create();
  for (const pg of pages) {
    const img = pg.type === 'image/png' ? await d.embedPng(pg.bytes) : await d.embedJpg(pg.bytes);
    let PW, PH, w, h;
    if (paper === 'fit' || !PAPER[paper]) { PW = 595.28; PH = PW * pg.h / pg.w; w = PW; h = PH; }
    else {
      [PW, PH] = PAPER[paper]; if (pg.w > pg.h) [PW, PH] = [PH, PW];
      const k = Math.min(PW / pg.w, PH / pg.h); w = pg.w * k; h = pg.h * k;
    }
    const page = d.addPage([PW, PH]);
    page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
  }
  d.setTitle('Hasil scan'); d.setProducer('KLM PDF ' + APP_VERSION);
  return d.save();
}
function cmdScan() {
  openScanner({
    hasDoc: !!cur(), toast,
    onDone: async (pages, { mode, paper }) => withBusy('Membuat PDF hasil scan…', async () => {
      const bytes = await scanToPdfBytes(pages, paper);
      const d = cur();
      if (mode === 'insert' && d) {
        const src = await loadSource(d, bytes, 'Hasil scan');
        const np = await pagesFromSource(src);
        const at = S.organize && S.pageSel.size ? Math.max(...[...S.pageSel].map(u => pageIndex(d, u))) + 1 : d.curPage + 1;
        pushUndo(); d.pages.splice(at, 0, ...np); pagesChanged();
        setTimeout(() => goToPage(at), 80);
        toast(`${np.length} halaman scan disisipkan`, 'ok');
      } else {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
        await openPdfBytes(bytes, `Scan ${stamp}.pdf`, { dirty: true, noRecent: true });
        toast(`PDF hasil scan (${pages.length} halaman) siap. Simpan untuk menyimpannya.`, 'ok', 4000);
      }
    }),
  });
}

/* --- kata sandi & keamanan --- */
async function cmdSecurity() {
  const d = cur(); if (!d) return;
  const pr = d.protect;
  $('#secOn').checked = !!pr; $('#secPw').value = pr?.userPassword || ''; $('#secPw2').value = pr?.userPassword || '';
  $('#secOwner').value = pr && pr.ownerPassword !== pr.userPassword ? pr.ownerPassword : '';
  const pm = pr?.permissions || {};
  $('#secPrint').checked = pm.print !== false; $('#secCopy').checked = pm.copy !== false; $('#secModify').checked = pm.modify !== false;
  const sync = () => $$('#dlgSecurity .sec-body input').forEach(i => i.disabled = !$('#secOn').checked);
  $('#secOn').onchange = sync; sync();
  if ((await openDialog('#dlgSecurity')) !== 'ok') return;
  if (!$('#secOn').checked) { if (d.protect) { d.protect = null; markDirty(d); toast('Kata sandi akan dihapus saat disimpan', 'ok'); } return; }
  const pw = $('#secPw').value;
  if (!pw) return toast('Isi kata sandi', 'err');
  if (pw !== $('#secPw2').value) return toast('Konfirmasi kata sandi tidak sama', 'err');
  d.protect = { userPassword: pw, ownerPassword: $('#secOwner').value || pw, permissions: { print: $('#secPrint').checked, copy: $('#secCopy').checked, modify: $('#secModify').checked, annotate: $('#secModify').checked } };
  markDirty(d); toast('Dokumen akan dikunci (AES-256) saat disimpan', 'ok');
}

/* --- default app --- */
function cmdDefaultApp() {
  const isWin = /Windows/i.test(navigator.userAgent);
  let html = '';
  if (IS_NATIVE) {
    html = `<div class="step"><b class="n">1</b><div><h5>Buka Pengaturan aplikasi default</h5><p>Klik tombol <b>Buka Pengaturan Default Windows</b> di bawah.</p></div></div>
      <div class="step"><b class="n">2</b><div><h5>Cari ".pdf"</h5><p>Ketik <b>.pdf</b> di kotak pencarian "Set a default for a file type".</p></div></div>
      <div class="step"><b class="n">3</b><div><h5>Pilih KLM PDF</h5><p>Klik aplikasi yang sekarang terpasang untuk .pdf (mis. Edge), lalu pilih <b>KLM PDF</b> → <b>Set default</b>.</p></div></div>
      <div class="note">Cara cepat: klik kanan file PDF mana pun → <b>Open with</b> → <b>Choose another app</b> → pilih <b>KLM PDF</b> → klik <b>Always</b>.</div>`;
  } else {
    html = `<div class="step"><b class="n">1</b><div><h5>Instal KLM PDF</h5><p>${window.matchMedia('(display-mode: standalone)').matches ? 'Sudah terpasang sebagai aplikasi ✓' : 'Klik tombol <b>Instal</b> di kanan atas (atau ikon instal di bilah alamat Chrome/Edge).'}</p></div></div>
      <div class="step"><b class="n">2</b><div><h5>Buka PDF dengan KLM PDF</h5><p>${isWin ? 'Di File Explorer, klik kanan file PDF → <b>Open with</b> → <b>Choose another app</b> → pilih <b>KLM PDF</b> → centang/klik <b>Always</b>.' : 'Klik kanan file PDF → Buka dengan → KLM PDF, lalu jadikan bawaan.'}</p></div></div>
      <div class="step"><b class="n">3</b><div><h5>Izinkan saat diminta</h5><p>Pertama kali, browser bisa menanyakan izin agar KLM PDF boleh membuka file. Pilih <b>Izinkan</b>.</p></div></div>
      <div class="note">Agar hasil paling mulus di Windows (termasuk klik dua kali file PDF), gunakan versi <b>.exe</b> (installer Windows). Saat instalasi, KLM PDF otomatis terdaftar sebagai pembuka file .pdf.</div>`;
  }
  $('#defaultSteps').innerHTML = html;
  $('#btnOpenDefaults').hidden = !IS_NATIVE;
  showDlg('#dlgDefault');
}
$('#btnOpenDefaults').onclick = () => native?.openDefaultApps?.();

/* =====================================================================
   RECENT FILES (IndexedDB)
   ===================================================================== */
const idb = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => { const r = indexedDB.open('klmpdf', 1); r.onupgradeneeded = () => r.result.createObjectStore('recent', { keyPath: 'key' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('recent', mode); const st = t.objectStore('recent'); const out = fn(st); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); }); };
  return { all: () => tx('readonly', s => s.getAll()), put: v => tx('readwrite', s => s.put(v)), del: k => tx('readwrite', s => s.delete(k)), clear: () => tx('readwrite', s => s.clear()) };
})();
async function addRecent(d, src) {
  if (!d.path && !d.handle) return;
  let thumb = '';
  try {
    const pg = await getPdfPage(src, d.pages[0].idx); const vp0 = pg.getViewport({ scale: 1, rotation: dims(d.pages[0]).total });
    const vp = pg.getViewport({ scale: 220 / vp0.width, rotation: dims(d.pages[0]).total });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; thumb = c.toDataURL('image/jpeg', 0.7);
  } catch { }
  const key = d.path || ('h:' + d.name);
  const all = await idb.all();
  if (d.handle) for (const r of all) { if (r.handle && await r.handle.isSameEntry?.(d.handle).catch(() => false)) await idb.del(r.key); }
  await idb.put({ key, name: d.name, path: d.path, handle: d.handle || null, time: Date.now(), pages: d.pages.length, thumb });
  const rest = (await idb.all()).sort((a, b) => b.time - a.time).slice(16);
  for (const r of rest) await idb.del(r.key);
}
async function renderRecent() {
  const box = $('#recent');
  let list = [];
  try { list = (await idb.all()).sort((a, b) => b.time - a.time); } catch { }
  if (!list.length) { box.innerHTML = '<p class="muted">Belum ada file. File yang Anda buka akan muncul di sini.</p>'; return; }
  box.innerHTML = list.map(r => `<div class="rcard" data-key="${esc(r.key)}" title="${esc(r.path || r.name)}"><div class="rthumb" style="background-image:url('${r.thumb}')"></div>
    <div class="rmeta"><div class="rname">${esc(r.name)}</div><div class="rtime">${fmtDate(r.time)} · ${r.pages} hal</div></div><button class="rdel" data-del title="Hapus dari daftar">${icon('x')}</button></div>`).join('');
}
$('#recent').addEventListener('click', async e => {
  const card = e.target.closest('.rcard'); if (!card) return;
  const key = card.dataset.key;
  if (e.target.closest('[data-del]')) { await idb.del(key); renderRecent(); return; }
  const r = (await idb.all()).find(x => x.key === key); if (!r) return;
  try {
    if (r.path && IS_NATIVE) { const f = await native.readFile(r.path); await openPdfBytes(f.data, f.name, { path: r.path }); }
    else if (r.handle) {
      if ((await r.handle.queryPermission({ mode: 'read' })) !== 'granted' && (await r.handle.requestPermission({ mode: 'read' })) !== 'granted') return;
      const f = await r.handle.getFile(); await openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name, { handle: r.handle });
    } else toast('File tidak bisa dibuka ulang dari sini. Gunakan "Buka file".', 'err');
  } catch (err) { toast('File tidak ditemukan atau sudah dipindah', 'err'); await idb.del(key); renderRecent(); }
});

/* =====================================================================
   COMMANDS, MENUS, KEYBOARD
   ===================================================================== */
function applyPanels() {
  $('#sidebar').classList.toggle('closed', !S.sidebarOpen);
  $('#rightpanel').classList.toggle('closed', !S.panelOpen);
}
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; localStorage.setItem('klmpdf.theme', t);
  $('.theme-ic use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  native?.setTheme?.(t);
}
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#btnInstall').hidden = false; });
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; toast('KLM PDF terpasang! Sekarang bisa dijadikan aplikasi PDF default.', 'ok', 5000); });

const CMDS = {
  home: showHome, open: cmdOpen, 'new-blank': cmdNewBlank, 'images-to-pdf': () => imagesToPdf(), merge: cmdMerge,
  save: () => saveDoc(), 'save-as': () => saveDoc(cur(), true), 'export-images': exportImages, print: printDoc, 'doc-props': cmdDocProps,
  'close-tab': () => cur() && closeDoc(S.curId),
  undo, redo, 'copy-annot': copySelected, 'paste-annot': pasteClipboard, 'dup-annot': duplicateSelected, 'delete-annot': deleteSelected,
  find: openSearch, 'search-next': () => S.search ? gotoMatch(S.search.cur + 1) : runSearch(), 'search-prev': () => S.search && gotoMatch(S.search.cur - 1), 'search-close': () => closeSearch(),
  'zoom-in': () => zoomStep(1), 'zoom-out': () => zoomStep(-1), 'zoom-100': () => setScale(1), 'fit-width': () => setScale(computeFit('fit-width'), 'fit-width'), 'fit-page': () => setScale(computeFit('fit-page'), 'fit-page'),
  'prev-page': () => goToPage(cur().curPage - 1), 'next-page': () => goToPage(cur().curPage + 1),
  'rotate-cw': () => rotatePages(S.pageSel.size ? [...S.pageSel] : [cur().pages[cur().curPage].uid], 90),
  'rotate-ccw': () => rotatePages(S.pageSel.size ? [...S.pageSel] : [cur().pages[cur().curPage].uid], -90),
  'toggle-sidebar': () => { S.sidebarOpen = !S.sidebarOpen; localStorage.setItem('klmpdf.sidebar', S.sidebarOpen ? '1' : '0'); applyPanels(); },
  'toggle-panel': () => { S.panelOpen = !S.panelOpen; localStorage.setItem('klmpdf.panel', S.panelOpen ? '1' : '0'); applyPanels(); },
  organize: () => toggleOrganize(), theme: toggleTheme,
  fullscreen: () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(),
  'insert-image': cmdInsertImage, signature: cmdSignature, stamp: cmdStamp, 'fill-form': cmdFillForm,
  'insert-date': () => { S.pendingText = todayStr(); setTool('text'); toast('Klik di halaman untuk menempatkan tanggal'); },
  'sym-check': () => startPlace(symbolImage('check'), 14, 14, 'centang'), 'sym-cross': () => startPlace(symbolImage('cross'), 14, 14, 'silang'), 'sym-dot': () => startPlace(symbolImage('dot'), 10, 10, 'titik'),
  'cancel-place': () => { cancelPlace(); setTool('select'); },
  'insert-blank': () => insertBlank(S.organize && S.pageSel.size ? Math.max(...[...S.pageSel].map(u => pageIndex(cur(), u))) + 1 : undefined),
  'insert-pdf': insertPdf, extract: () => extractPages(selectedOrAsk()), split: splitPdf,
  'delete-pages': async () => { const d = cur(); let us = selectedOrAsk(); if (!us) { const r = await promptDialog('Hapus halaman', `Halaman yang dihapus (1–${d.pages.length}):`, String(d.curPage + 1), { okText: 'Hapus' }); if (!r) return; try { us = parseRanges(r, d.pages.length).flat().map(i => d.pages[i].uid); } catch (e) { return toast(e.message, 'err'); } } deletePages(us); },
  'dup-pages': () => { const us = selectedOrAsk(); if (us) duplicatePages(us); else toast('Pilih halaman dulu'); },
  'org-rotate-cw': () => { const us = selectedOrAsk(); us ? rotatePages(us, 90) : toast('Pilih halaman dulu'); },
  'org-rotate-ccw': () => { const us = selectedOrAsk(); us ? rotatePages(us, -90) : toast('Pilih halaman dulu'); },
  watermark: cmdWatermark, 'page-numbers': cmdPageNumbers,
  'default-app': cmdDefaultApp, security: cmdSecurity, scan: cmdScan, shortcuts: () => showDlg('#dlgKeys'), about: () => { $('#aboutVer').textContent = `Versi ${APP_VERSION} · ${IS_NATIVE ? 'Aplikasi Windows' : (matchMedia('(display-mode: standalone)').matches ? 'Aplikasi terpasang (PWA)' : 'Web')}`; showDlg('#dlgAbout'); },
  install: async () => { if (!installEvt) return cmdDefaultApp(); installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#btnInstall').hidden = true; },
  'clear-recent': async () => { await idb.clear(); renderRecent(); },
};
const NEEDS_DOC = new Set(['security', 'save', 'save-as', 'export-images', 'print', 'doc-props', 'undo', 'redo', 'find', 'zoom-in', 'zoom-out', 'zoom-100', 'fit-width', 'fit-page', 'prev-page', 'next-page', 'rotate-cw', 'rotate-ccw', 'organize', 'insert-image', 'signature', 'stamp', 'fill-form', 'insert-date', 'insert-blank', 'insert-pdf', 'extract', 'split', 'delete-pages', 'watermark', 'page-numbers', 'sym-check', 'sym-cross', 'sym-dot', 'toggle-sidebar', 'toggle-panel', 'dup-pages']);
const CLOSE_ORG = new Set(['scan', 'insert-image', 'signature', 'stamp', 'fill-form', 'insert-date', 'sym-check', 'sym-cross', 'sym-dot', 'find', 'fit-width', 'fit-page', 'zoom-100', 'prev-page', 'next-page', 'watermark', 'page-numbers']);
async function runCmd(name) {
  if (NEEDS_DOC.has(name) && !cur()) return;
  closeMenus(); hideCtx();
  if (S.organize && CLOSE_ORG.has(name)) toggleOrganize(false);
  try { await CMDS[name]?.(); } catch (e) { console.error(e); toast(e?.message || String(e), 'err', 5000); }
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-cmd]');
  if (c && !c.closest('dialog')) { e.preventDefault(); runCmd(c.dataset.cmd); return; }
  const t = e.target.closest('[data-tool]');
  if (t && cur()) { closeMenus(); if (S.organize) toggleOrganize(false); setTool(t.dataset.tool); }
  const sd = e.target.closest('[data-side]');
  if (sd) { $$('.side-tabs button').forEach(b => b.classList.toggle('on', b === sd)); $$('.side-pane').forEach(p => p.hidden = p.id !== 'pane-' + sd.dataset.side); }
});
/* menus */
function closeMenus() { $$('.menu.open').forEach(m => m.classList.remove('open')); }
$('#menubar').addEventListener('click', e => {
  const b = e.target.closest('.menu-btn'); if (!b) return;
  const m = b.parentElement; const was = m.classList.contains('open'); closeMenus(); if (!was) { updateMenus(); m.classList.add('open'); }
});
$('#menubar').addEventListener('pointerover', e => { const b = e.target.closest('.menu-btn'); if (b && $('.menu.open') && !b.parentElement.classList.contains('open')) { closeMenus(); b.parentElement.classList.add('open'); } });

const TOOL_KEYS = { v: 'select', h: 'hand', e: 'edittext', t: 'text', l: 'highlight', u: 'underline', k: 'strike', p: 'pen', n: 'note', r: 'rect', o: 'ellipse', a: 'arrow', w: 'whiteout' };
document.addEventListener('keydown', e => {
  const tag = e.target.tagName; const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable;
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
  if (mod) {
    const map = { o: 'open', s: e.shiftKey ? 'save-as' : 'save', p: 'print', f: 'find', w: 'close-tab', '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', '0': 'fit-page', '1': 'zoom-100', '2': 'fit-width' };
    if (k === 'z' && !typing) { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (k === 'y' && !typing) { e.preventDefault(); return redo(); }
    if (k === 'tab') { e.preventDefault(); if (!S.docs.length) return; const i = S.docs.findIndex(d => d.id === S.curId); const n = S.docs[(i + (e.shiftKey ? -1 : 1) + S.docs.length) % S.docs.length]; if (n) switchDoc(n.id); return; }
    if (!typing && k === 'c' && selected() && !window.getSelection()?.toString()) { e.preventDefault(); copySelected(); return; }
    if (!typing && k === 'v' && S.clipboard && cur()) { e.preventDefault(); pasteClipboard(); return; }
    if (!typing && k === 'd' && selected()) { e.preventDefault(); duplicateSelected(); return; }
    if (map[k]) { e.preventDefault(); runCmd(map[k]); return; }
    return;
  }
  if (e.key === 'F11') { e.preventDefault(); runCmd('fullscreen'); return; }
  if (e.key === 'F4') { e.preventDefault(); runCmd('toggle-sidebar'); return; }
  if (typing || !cur()) return;
  if (e.key === 'Escape') {
    if (S.placing) { cancelPlace(); setTool('select'); return; }
    if (!$('#searchbar').hidden) { closeSearch(); return; }
    if (S.organize) { toggleOrganize(false); return; }
    if (S.sel) deselect(); else if (S.tool !== 'select') setTool('select');
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected()) { e.preventDefault(); deleteSelected(); return; }
  if ((e.key === 'Delete') && S.organize && S.pageSel.size) { e.preventDefault(); deletePages([...S.pageSel]); return; }
  if (e.key.startsWith('Arrow') && selected()) {
    e.preventDefault();
    const s = selected(); const st = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
    if (!S.nudgeSnap) S.nudgeSnap = snapshot();
    translateAnnot(s.a, structuredClone(s.a), dx, dy); renderAnnots(s.p);
    clearTimeout(S.nudgeT); S.nudgeT = setTimeout(() => { pushUndoSnap(S.nudgeSnap); S.nudgeSnap = null; refreshThumb(s.p.uid); }, 500);
    return;
  }
  if (e.key === ' ' && !S.spaceDown) { S.spaceDown = true; viewer.classList.add('tool-hand'); e.preventDefault(); return; }
  if (e.key === 'Home') { e.preventDefault(); goToPage(0); return; }
  if (e.key === 'End') { e.preventDefault(); goToPage(cur().pages.length - 1); return; }
  if (e.key === 'PageDown' && e.altKey) { goToPage(cur().curPage + 1); return; }
  if (e.key === 'PageUp' && e.altKey) { goToPage(cur().curPage - 1); return; }
  if (k === 's' && !e.altKey) { runCmd('signature'); return; }
  if (TOOL_KEYS[k] && !e.altKey) { if (S.organize) toggleOrganize(false); setTool(TOOL_KEYS[k]); }
});
document.addEventListener('keyup', e => { if (e.key === ' ') { S.spaceDown = false; if (S.tool !== 'hand') viewer.classList.remove('tool-hand'); } });

/* paste images from clipboard */
document.addEventListener('paste', async e => {
  if (!cur() || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); await placeImageFile(f); }
});

/* drag & drop files */
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; $('#dropzone').hidden = false; });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true;
  const fallback = [...e.dataTransfer.files];
  const entries = [...e.dataTransfer.items || []].filter(it => it.kind === 'file').map(it => ({
    f: it.getAsFile(), hp: !IS_NATIVE && it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : null,
  })).filter(x => x.f);
  for (const en of entries) if (en.hp && /\.pdf$/i.test(en.f.name)) { try { en.f.handle = await en.hp; } catch { } }
  openFiles(entries.length ? entries.map(x => x.f) : fallback);
});

/* status bar */
function updateStatus() {
  const d = cur();
  if (!d) { $('#stFile').textContent = 'Siap'; $('#stPage').textContent = ''; $('#stZoom').textContent = ''; $('#stSel').textContent = ''; return; }
  const p = d.pages[d.curPage]; const { W, H } = p ? dims(p) : { W: 0, H: 0 };
  $('#stFile').textContent = (d.path || d.name) + (d.dirty ? ' — belum disimpan' : '');
  $('#stPage').textContent = `Halaman ${d.curPage + 1} dari ${d.pages.length} · ${(W / 72 * 25.4).toFixed(0)}×${(H / 72 * 25.4).toFixed(0)} mm`;
  $('#stZoom').textContent = Math.round(d.scale * 100) + '%';
  updateUndoButtons();
}

/* before unload */
window.addEventListener('beforeunload', e => {
  if (!IS_NATIVE && S.docs.some(d => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
});

/* =====================================================================
   PLATFORM INTEGRATION: PWA file handling & Electron
   ===================================================================== */
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    for (const h of params.files || []) {
      try { const f = await h.getFile(); await openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name, { handle: h }); }
      catch (e) { toast('Gagal membuka file: ' + e.message, 'err'); }
    }
  });
}
if (!IS_NATIVE && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
if (IS_NATIVE) {
  native.onOpenFiles?.(async files => { for (const f of files) { try { const r = await native.readFile(f); await openPdfBytes(r.data, r.name, { path: f }); } catch (e) { toast('Gagal membuka ' + f, 'err'); } } });
  let closingAsk = false;
  native.onBeforeClose?.(async () => {
    if (closingAsk) return; // pertanyaan sudah tampil
    const dirty = S.docs.filter(d => d.dirty);
    if (!dirty.length) return native.confirmClose(true);
    closingAsk = true;
    try {
    const r = await confirmDialog('Keluar dari KLM PDF?', `${dirty.length} dokumen memiliki perubahan yang belum disimpan.`, [{ v: 'cancel', t: 'Batal' }, { v: 'discard', t: 'Keluar tanpa menyimpan', danger: true }, { v: 'save', t: 'Simpan semua', primary: true }]);
    if (r === 'cancel') return native.confirmClose(false);
    if (r === 'save') { for (const d of dirty) { switchDoc(d.id); if (!(await saveDoc(d))) return native.confirmClose(false); } }
    native.confirmClose(true);
    } finally { closingAsk = false; }
  });
}

$$('dialog').forEach(dl => dl.addEventListener('keydown', e => {
  if (dl.id === 'dlgPrint' || dl.id === 'dlgScan') return;
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !/checkbox|radio|color|range/.test(e.target.type)) {
    const b = dl.querySelector('.dlg-actions .btn.primary'); if (b) { e.preventDefault(); b.click(); }
  }
}));

/* ------------------------------ boot ------------------------------ */
(async function boot() {
  $('.theme-ic use').setAttribute('href', document.documentElement.dataset.theme === 'dark' ? '#i-sun' : '#i-moon');
  renderTabs(); renderRecent(); updateMenus();
  loadSystemFonts(false);
  wireScanner();
  wirePrintDialog();
  if (IS_NATIVE) {
    native.setTheme?.(document.documentElement.dataset.theme);
    const files = await native.ready();
    for (const f of files || []) { try { const r = await native.readFile(f); await openPdfBytes(r.data, r.name, { path: f }); } catch (e) { toast('Gagal membuka ' + f, 'err'); } }
  }
  // ?open=URL (untuk pengujian / tautan)
  const u = new URLSearchParams(location.search).get('open');
  if (u) { try { const r = await fetch(u); await openPdfBytes(new Uint8Array(await r.arrayBuffer()), decodeURIComponent(u.split('/').pop()), { noRecent: true }); } catch (e) { toast('Gagal memuat ' + u, 'err'); } }
})();

// untuk debug/pengujian otomatis
window.KLM = { S, cur, openPdfBytes, buildPdfBytes, setTool, saveDoc, dims };
