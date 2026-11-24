/* =====================================================================
   KLM PDF — Cetak (dialog ala Acrobat dengan pratinjau)
   Halaman disusun sendiri menjadi lembar kertas (ukuran, orientasi, skala,
   n-per-lembar, hitam-putih) sehingga hasil cetak = pratinjau.
   Windows (.exe): dicetak langsung ke printer yang dipilih.
   Browser/PWA: lembar yang sudah disusun dikirim ke dialog cetak browser.
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const MM = 72 / 25.4;
export const PAPERS = {
  a4: { label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89, el: 'A4' },
  letter: { label: 'Letter (8,5 × 11 in)', w: 612, h: 792, el: 'Letter' },
  legal: { label: 'Legal (8,5 × 14 in)', w: 612, h: 1008, el: 'Legal' },
  f4: { label: 'F4 / Folio (215 × 330 mm)', w: 215 * MM, h: 330 * MM },
  a3: { label: 'A3 (297 × 420 mm)', w: 841.89, h: 1190.55, el: 'A3' },
  a5: { label: 'A5 (148 × 210 mm)', w: 419.53, h: 595.28, el: 'A5' },
  b5: { label: 'B5 (176 × 250 mm)', w: 176 * MM, h: 250 * MM },
};
const SAFE = 4.2 * MM;      // margin aman (area yang bisa dicetak printer)
const GUTTER = 3 * MM;      // jarak antarhalaman pada n-per-lembar
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- perencanaan lembar ---------------- */
export function parsePageList(str, max) {
  const out = [];
  for (const part of String(str).split(/[,;]+/)) {
    const s = part.trim(); if (!s) continue;
    const m = s.match(/^(\d+)\s*(?:-\s*(\d*))?$/);
    if (!m) throw new Error('Format halaman tidak valid: "' + s + '". Contoh: 1-3, 5, 8-');
    let a = +m[1], b = m[2] === undefined ? a : (m[2] === '' ? max : +m[2]);
    if (a < 1 || a > max) throw new Error(`Halaman ${a} tidak ada (dokumen ${max} halaman)`);
    b = Math.min(b, max);
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1); else for (let i = a; i >= b; i--) out.push(i - 1);
  }
  if (!out.length) throw new Error('Tidak ada halaman yang dipilih');
  return out;
}
function nearPaper(w, h) {
  for (const [k, p] of Object.entries(PAPERS)) {
    if ((Math.abs(p.w - w) < 4 && Math.abs(p.h - h) < 4) || (Math.abs(p.w - h) < 4 && Math.abs(p.h - w) < 4)) return k;
  }
  return null;
}
/** Kembalikan daftar lembar: { W, H, cells:[{ page, x, y, w, h, rot }] } (pt) */
export function planSheets(sizes, indices, o) {
  const n = +o.perSheet || 1;
  const first = sizes[indices[0]];
  let base = o.paper === 'doc' ? { w: Math.min(first.w, first.h), h: Math.max(first.w, first.h) } : PAPERS[o.paper] || PAPERS.a4;
  const pageLand = first.w > first.h;
  let land;
  if (o.orient === 'portrait') land = false;
  else if (o.orient === 'landscape') land = true;
  else land = n === 2 || n === 6 ? !pageLand : pageLand;
  const W = land ? base.h : base.w, H = land ? base.w : base.h;
  const grid = n === 1 ? [1, 1] : n === 2 ? (land ? [2, 1] : [1, 2]) : n === 4 ? [2, 2] : n === 6 ? (land ? [3, 2] : [2, 3]) : n === 9 ? [3, 3] : n === 16 ? [4, 4] : [1, 1];
  const [cols, rows] = grid, per = cols * rows;
  const sheets = [];
  for (let s = 0; s < indices.length; s += per) {
    const cells = [];
    for (let k = 0; k < per && s + k < indices.length; k++) {
      const page = indices[s + k], sz = sizes[page];
      const col = k % cols, row = (k / cols) | 0;
      let areaX, areaY, areaW, areaH;
      if (per === 1) {
        const m = o.scale === 'fit' || o.scale === 'shrink' ? SAFE : 0;
        areaX = m; areaY = m; areaW = W - 2 * m; areaH = H - 2 * m;
      } else {
        const cw = (W - 2 * SAFE - (cols - 1) * GUTTER) / cols, ch = (H - 2 * SAFE - (rows - 1) * GUTTER) / rows;
        areaX = SAFE + col * (cw + GUTTER); areaY = SAFE + row * (ch + GUTTER); areaW = cw; areaH = ch;
      }
      // putar otomatis bila orientasi halaman berbeda dengan area
      const rot = o.autoRotate && ((sz.w > sz.h) !== (areaW > areaH)) && Math.abs(sz.w - sz.h) > 2 ? 90 : 0;
      const pw = rot ? sz.h : sz.w, ph = rot ? sz.w : sz.h;
      let k2;
      const fitK = Math.min(areaW / pw, areaH / ph);
      if (per > 1 || o.scale === 'fit') k2 = fitK;
      else if (o.scale === 'shrink') k2 = Math.min(1, fitK);
      else if (o.scale === 'custom') k2 = Math.max(0.1, Math.min(4, (+o.customPct || 100) / 100));
      else k2 = 1;
      const w = pw * k2, h = ph * k2;
      cells.push({ page, rot, x: areaX + (areaW - w) / 2, y: areaY + (areaH - h) / 2, w, h, border: per > 1 && o.borders });
    }
    sheets.push({ W, H, cells });
  }
  return { sheets, land, W, H, paperKey: o.paper === 'doc' ? nearPaper(base.w, base.h) : o.paper };
}

/* ---------------- penyusunan gambar lembar ---------------- */
export async function composeSheet(sheet, scale, getPageCanvas, gray) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sheet.W * scale)); c.height = Math.max(1, Math.round(sheet.H * scale));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  for (const cell of sheet.cells) {
    const need = Math.max(cell.w, cell.h) * scale;
    const src = await getPageCanvas(cell.page, need);
    g.save();
    if (gray) g.filter = 'grayscale(1)';
    g.imageSmoothingQuality = 'high';
    const x = cell.x * scale, y = cell.y * scale, w = cell.w * scale, h = cell.h * scale;
    if (cell.rot) { g.translate(x + w, y); g.rotate(Math.PI / 2); g.drawImage(src, 0, 0, h, w); }
    else g.drawImage(src, x, y, w, h);
    g.restore();
    if (cell.border) { g.strokeStyle = '#999'; g.lineWidth = Math.max(1, scale * 0.5); g.strokeRect(x, y, w, h); }
  }
  return c;
}

/* =====================================================================
   DIALOG
   ===================================================================== */
let S = null;
const OPT_KEY = 'klmpdf.print';
function loadOpts() {
  const def = { range: 'all', subset: 'all', reverse: false, paper: 'auto', orient: 'auto', scale: 'fit', customPct: 100, perSheet: 1, borders: true, autoRotate: true, color: 'color', duplex: 'simplex', quality: '200', copies: 1, collate: true, markup: true, printer: '' };
  try { const saved = JSON.parse(localStorage.getItem(OPT_KEY) || '{}'); return { ...def, ...saved, range: 'all', subset: 'all', reverse: false, copies: 1, perSheet: 1, paper: 'auto', orient: 'auto' }; } catch { return def; }
}
function saveOpts() { try { const { rangeText, ...o } = S.o; localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { } }

/**
 * @param {object} cfg
 *  title, pageCount, curPage, sizes:[{w,h}] (pt, sudah termasuk rotasi tampilan)
 *  getPdf(markup:boolean) → Promise<pdfjs document>  (halaman final, urut sama)
 *  closePdf(pdf), native (klmNative|null), toast(msg,type)
 */
export async function openPrintDialog(cfg) {
  const o = loadOpts();
  S = { cfg, o, pdfs: {}, cache: new Map(), plan: null, prevIdx: 0, token: 0, ptok: 0, printing: false, printers: [] };
  const dlg = $('#dlgPrint');
  // kertas default: cocokkan dengan halaman pertama
  const first = cfg.sizes[0];
  const autoPaper = nearPaper(first.w, first.h) || 'doc';
  if (o.paper === 'auto' || (!PAPERS[o.paper] && o.paper !== 'doc')) o.paper = autoPaper;
  $('#prPaper').innerHTML = `<option value="doc">Sesuai dokumen (${Math.round(Math.min(first.w, first.h) / MM)} × ${Math.round(Math.max(first.w, first.h) / MM)} mm)</option>` +
    Object.entries(PAPERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  $('#prTitle').textContent = cfg.title;
  $('#prPageCount').textContent = cfg.pageCount;
  // printer
  const native = cfg.native;
  $('#prNativeRows').hidden = !native?.getPrinters;
  $('#prBrowserNote').hidden = !!native?.getPrinters;
  $('#prSystem').hidden = !native?.getPrinters;
  if (native?.getPrinters) {
    $('#prPrinter').innerHTML = '<option>Memuat daftar printer…</option>';
    native.getPrinters().then(list => {
      S.printers = list || [];
      if (!S.printers.length) { $('#prPrinter').innerHTML = '<option value="">(Tidak ada printer terpasang)</option>'; return; }
      const def = S.printers.find(p => p.name === o.printer) || S.printers.find(p => p.isDefault) || S.printers[0];
      $('#prPrinter').innerHTML = S.printers.map(p => `<option value="${esc(p.name)}" ${p === def ? 'selected' : ''}>${esc(p.displayName || p.name)}${p.isDefault ? ' (default)' : ''}</option>`).join('');
      o.printer = def.name;
    }).catch(() => { $('#prPrinter').innerHTML = '<option value="">(Printer tidak terbaca)</option>'; });
  }
  // isi kontrol dari opsi
  const setVal = (id, v) => { const el = $(id); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
  $$('input[name=prRange]').forEach(r => r.checked = r.value === 'all');
  $('#prRangeText').value = '';
  $('#prCurNum').textContent = cfg.curPage + 1;
  setVal('#prSubset', o.subset); setVal('#prReverse', o.reverse); setVal('#prPaper', o.paper); setVal('#prOrient', o.orient);
  $$('input[name=prScale]').forEach(r => r.checked = r.value === o.scale);
  setVal('#prCustomPct', o.customPct); setVal('#prPerSheet', String(o.perSheet)); setVal('#prBorders', o.borders); setVal('#prAutoRotate', o.autoRotate);
  setVal('#prColor', o.color); setVal('#prDuplex', o.duplex); setVal('#prQuality', o.quality); setVal('#prCopies', 1); setVal('#prCollate', o.collate); setVal('#prMarkup', o.markup);
  $('#prSelected').disabled = !cfg.selection?.length;
  $('#prSelectedLbl').classList.toggle('muted', !cfg.selection?.length);
  syncDisabled();
  $('#prProgress').hidden = true; $('#prProgress').textContent = ''; $('#prErr').textContent = '';
  $('#prGo').disabled = false; dlg.classList.remove('busy'); S.prevIdx = 0;
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('#prGo').focus(), 0);
  dlg.addEventListener('close', cleanup, { once: true });
  await refresh();
}
function cleanup() {
  if (!S) return;
  S.token++; S.ptok++;
  for (const p of Object.values(S.pdfs)) Promise.resolve(p).then(pdf => S?.cfg.closePdf?.(pdf)).catch(() => { });
  const keep = S; setTimeout(() => { keep.cache.clear(); }, 0);
  S = null;
}
function syncDisabled() {
  const o = S.o; const n = +o.perSheet;
  $$('input[name=prScale]').forEach(r => r.disabled = n > 1);
  $('#prCustomPct').disabled = n > 1 || o.scale !== 'custom';
  $('#prBorders').closest('label').hidden = n === 1;
}
function readOpts() {
  const o = S.o;
  o.range = $('input[name=prRange]:checked')?.value || 'all';
  o.rangeText = $('#prRangeText').value;
  o.subset = $('#prSubset').value; o.reverse = $('#prReverse').checked;
  o.paper = $('#prPaper').value; o.orient = $('#prOrient').value;
  o.scale = $('input[name=prScale]:checked')?.value || 'fit'; o.customPct = +$('#prCustomPct').value || 100;
  o.perSheet = +$('#prPerSheet').value || 1; o.borders = $('#prBorders').checked; o.autoRotate = $('#prAutoRotate').checked;
  o.color = $('#prColor').value; o.duplex = $('#prDuplex').value; o.quality = $('#prQuality').value;
  o.copies = Math.max(1, Math.min(999, parseInt($('#prCopies').value, 10) || 1)); o.collate = $('#prCollate').checked; o.markup = $('#prMarkup').checked;
  if (S.printers.length) o.printer = $('#prPrinter').value;
  syncDisabled();
}
function indicesFor() {
  const { o, cfg } = S; const N = cfg.pageCount;
  let idx;
  if (o.range === 'current') idx = [cfg.curPage];
  else if (o.range === 'selected' && cfg.selection?.length) idx = [...cfg.selection];
  else if (o.range === 'range') idx = parsePageList(o.rangeText || '', N);
  else idx = [...Array(N).keys()];
  if (o.subset === 'odd') idx = idx.filter(i => i % 2 === 0);
  else if (o.subset === 'even') idx = idx.filter(i => i % 2 === 1);
  if (o.reverse) idx.reverse();
  if (!idx.length) throw new Error('Tidak ada halaman yang cocok dengan pilihan ganjil/genap');
  return idx;
}
function getPdf(markup) { return (S.pdfs[markup ? 1 : 0] ||= S.cfg.getPdf(markup)); }
async function pageCanvas(markup, page, needPx, highQ) {
  // tingkatkan resolusi bertahap; cache menyimpan kanvas terbesar
  const key = (markup ? 'm' : 'n') + page;
  const hit = S.cache.get(key);
  if (hit && hit.px >= needPx * 0.98) return hit.c;
  const pdf = await getPdf(markup);
  const pg = await pdf.getPage(page + 1);
  const vp0 = pg.getViewport({ scale: 1 });
  const px = Math.min(needPx, highQ ? 7000 : 1800);
  const k = px / Math.max(vp0.width, vp0.height);
  const vp = pg.getViewport({ scale: k });
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: g, viewport: vp, intent: 'print' }).promise;
  if (!highQ) S.cache.set(key, { c, px });
  return c;
}

let refreshT = null;
function refreshSoon() { clearTimeout(refreshT); refreshT = setTimeout(refresh, 120); }
async function refresh() {
  if (!S) return;
  readOpts();
  const tok = ++S.token;
  let idx;
  try { idx = indicesFor(); $('#prErr').textContent = ''; }
  catch (e) { $('#prErr').textContent = e.message; $('#prGo').disabled = true; S.plan = null; drawEmpty(); return; }
  S.plan = planSheets(S.cfg.sizes, idx, S.o);
  S.idx = idx;
  const nSheets = S.plan.sheets.length;
  S.prevIdx = Math.min(S.prevIdx, nSheets - 1);
  $('#prGo').disabled = false;
  const sheetsTotal = nSheets * S.o.copies;
  const paperTxt = `${Math.round(S.plan.W / MM)} × ${Math.round(S.plan.H / MM)} mm`;
  $('#prSummary').textContent = `${idx.length} halaman → ${nSheets} lembar${S.o.copies > 1 ? ` × ${S.o.copies} salinan = ${sheetsTotal} lembar` : ''}${S.o.duplex !== 'simplex' ? ' (bolak-balik: ±' + Math.ceil(sheetsTotal / 2) + ' kertas)' : ''} · ${paperTxt}`;
  await drawPreview(tok);
}
function drawEmpty() { const c = $('#prCanvas'); c.width = 10; c.height = 10; c.getContext('2d').clearRect(0, 0, 10, 10); $('#prNav').textContent = '–'; }
async function drawPreview(tok) {
  const plan = S.plan; if (!plan) return;
  const sheet = plan.sheets[S.prevIdx];
  const box = $('#prPreviewBox');
  const bw = box.clientWidth - 24 || 420, bh = box.clientHeight - 24 || 520;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const k = Math.min(bw / sheet.W, bh / sheet.H);
  $('#prNav').textContent = `Lembar ${S.prevIdx + 1} dari ${plan.sheets.length}`;
  $('#prPrev').disabled = S.prevIdx <= 0; $('#prNext').disabled = S.prevIdx >= plan.sheets.length - 1;
  $('#prLoading').hidden = false;
  try {
    const c = await composeSheet(sheet, k * dpr, (p, need) => pageCanvas(S.o.markup, p, need, false), S.o.color === 'gray');
    if (!S || tok !== S.token) return;
    const out = $('#prCanvas');
    out.width = c.width; out.height = c.height;
    out.style.width = sheet.W * k + 'px'; out.style.height = sheet.H * k + 'px';
    out.getContext('2d').drawImage(c, 0, 0);
  } catch (e) { if (S && tok === S.token) $('#prErr').textContent = 'Pratinjau gagal: ' + (e?.message || e); }
  finally { if (S && tok === S.token) $('#prLoading').hidden = true; }
}

/* ---------------- cetak ---------------- */
async function doPrint(useSystemDialog = false) {
  readOpts();
  if (!S.plan) return;
  const { cfg, o, plan } = S;
  const native = cfg.native?.getPrinters ? cfg.native : null;
  if (native && !useSystemDialog && !o.printer && S.printers.length) o.printer = S.printers[0].name;
  if (native && !useSystemDialog && !S.printers.length) { cfg.toast('Tidak ada printer terpasang di Windows. Tambahkan printer lewat Pengaturan Windows.', 'err', 6000); return; }
  saveOpts();
  const dpi = +o.quality || 200;
  const scale = dpi / 72;
  const btn = $('#prGo'); btn.disabled = true;
  const prog = $('#prProgress'); prog.hidden = false;
  const setP = (t) => { prog.textContent = t; };
  const tok = ++S.ptok; S.printing = true;
  $('#dlgPrint').classList.add('busy');
  let job = null;
  try {
    const sheets = plan.sheets;
    if (native) job = await native.printBegin();
    const blobs = [];
    for (let i = 0; i < sheets.length; i++) {
      if (!S || tok !== S.ptok) throw new Error('dibatalkan');
      setP(`Menyiapkan lembar ${i + 1} dari ${sheets.length}…`);
      const c = await composeSheet(sheets[i], scale, (p, need) => pageCanvas(o.markup, p, need, true), o.color === 'gray');
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
      c.width = c.height = 0;
      if (native) await native.printAdd(job, i, new Uint8Array(await blob.arrayBuffer()));
      else blobs.push(blob);
    }
    setP('Mengirim ke printer…');
    const land = plan.W > plan.H;
    if (native) {
      const p = PAPERS[plan.paperKey];
      const res = await native.printRun(job, {
        count: sheets.length, sheetW: plan.W, sheetH: plan.H, title: cfg.title,
        silent: !useSystemDialog, deviceName: o.printer, copies: o.copies, collate: o.collate,
        color: o.color !== 'gray', duplexMode: o.duplex, landscape: land,
        pageSizeName: p?.el || null, pageSizeMicrons: { width: Math.round(Math.min(plan.W, plan.H) / 72 * 25400), height: Math.round(Math.max(plan.W, plan.H) / 72 * 25400) },
        dpi,
      });
      job = null;
      if (res?.ok) { cfg.toast(useSystemDialog ? 'Dokumen dikirim ke printer' : `Dikirim ke ${o.printer} — ${sheets.length} lembar${o.copies > 1 ? ' × ' + o.copies : ''}`, 'ok', 4500); $('#dlgPrint').close(); }
      else if (res?.reason && /cancel/i.test(res.reason)) setP('Cetak dibatalkan.');
      else throw new Error(res?.reason || 'printer tidak merespons');
    } else {
      await browserPrint(blobs, plan, cfg.title);
      $('#dlgPrint').close();
    }
  } catch (e) {
    if (job && native) native.printCancel?.(job).catch(() => { });
    if (String(e?.message) !== 'dibatalkan') { cfg.toast('Gagal mencetak: ' + (e?.message || e), 'err', 6000); setP('Gagal: ' + (e?.message || e)); }
  } finally {
    if (S) { S.printing = false; $('#dlgPrint').classList.remove('busy'); }
    if (S && $('#dlgPrint').open) { btn.disabled = false; setTimeout(() => { if (S && !S.printing) prog.hidden = true; }, 2500); }
  }
}
async function browserPrint(blobs, plan, title) {
  const urls = blobs.map(b => URL.createObjectURL(b));
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden';
  document.body.append(frame);
  const W = plan.W, H = plan.H;
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page{size:${W}pt ${H}pt;margin:0}
    html,body{margin:0;padding:0;background:#fff}
    .s{width:${W}pt;height:${H - 0.5}pt;overflow:hidden;break-after:page;page-break-after:always;display:block}
    .s:last-child{break-after:auto;page-break-after:auto}
    .s img{width:100%;height:100%;object-fit:contain;display:block}
  </style></head><body>${urls.map(u => `<div class="s"><img src="${u}"></div>`).join('')}</body></html>`);
  doc.close();
  await Promise.all([...doc.images].map(im => im.decode ? im.decode().catch(() => { }) : new Promise(r => { if (im.complete) r(); else im.onload = im.onerror = r; })));
  const cleanup = () => setTimeout(() => { frame.remove(); urls.forEach(u => URL.revokeObjectURL(u)); }, 1500);
  frame.contentWindow.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 10 * 60 * 1000);
  frame.contentWindow.focus();
  frame.contentWindow.print();
}

/* ---------------- event ---------------- */
let wired = false;
export function wirePrintDialog() {
  if (wired) return; wired = true;
  const dlg = $('#dlgPrint');
  dlg.addEventListener('input', e => {
    if (!S || S.printing) return;
    if (e.target.id === 'prRangeText') { const r = $('input[name=prRange][value=range]'); if (r) r.checked = true; }
    refreshSoon();
  });
  dlg.addEventListener('change', e => { if (!S || S.printing) return; if (e.target.id === 'prPrinter') { readOpts(); return; } refreshSoon(); });
  $('#prRangeText').addEventListener('focus', () => { const r = $('input[name=prRange][value=range]'); if (r && !r.checked) { r.checked = true; refreshSoon(); } });
  $('#prPrev').addEventListener('click', () => { if (!S || S.prevIdx <= 0) return; S.prevIdx--; drawPreview(++S.token); });
  $('#prNext').addEventListener('click', () => { if (!S || !S.plan || S.prevIdx >= S.plan.sheets.length - 1) return; S.prevIdx++; drawPreview(++S.token); });
  $('#prGo').addEventListener('click', () => S && !S.printing && doPrint(false));
  $('#prSystem').addEventListener('click', () => S && !S.printing && doPrint(true));
  $('#prCancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', e => {
    if (!S) return;
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); e.stopPropagation(); if (!$('#prGo').disabled && !S.printing) doPrint(false); }
    if ((e.key === 'PageDown' || (e.key === 'ArrowRight' && e.target === dlg))) $('#prNext').click();
    if ((e.key === 'PageUp' || (e.key === 'ArrowLeft' && e.target === dlg))) $('#prPrev').click();
  });
  window.addEventListener('resize', () => { if (S && dlg.open) drawPreview(++S.token); });
}
