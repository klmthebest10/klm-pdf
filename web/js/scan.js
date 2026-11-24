/* =====================================================================
   KLM PDF — Scan dokumen
   Kamera / foto → deteksi tepi kertas otomatis → luruskan perspektif →
   filter ala scanner (Dokumen, Hitam-putih, Abu-abu, Asli) → halaman PDF
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const MAX_SIDE = 2400;          // resolusi maksimum hasil
const DET_SIDE = 360;           // resolusi untuk deteksi tepi

/* ---------------- util gambar ---------------- */
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
function scaledCopy(src, maxSide) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = canvasOf(src.width * k, src.height * k);
  const g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
async function fileToCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Gambar tidak bisa dibaca: ' + file.name)); i.src = url; }); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, 4000 / Math.max(w, h));
  const c = canvasOf(w * k, h * k); ctx2d(c).drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}
function rotateCanvas(src, dir) { // dir: 1 = kanan, -1 = kiri
  const c = canvasOf(src.height, src.width); const g = ctx2d(c);
  g.translate(c.width / 2, c.height / 2); g.rotate(dir * Math.PI / 2); g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/* ---------------- deteksi tepi kertas ---------------- */
function otsu(gray) {
  const hist = new Uint32Array(256); for (const v of gray) hist[v]++;
  const total = gray.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = t; }
  }
  return thr;
}
/** Kembalikan 4 titik sudut [tl, tr, br, bl] dalam koordinat gambar asli, atau null. */
export function detectCorners(src) {
  const sm = scaledCopy(src, DET_SIDE); const w = sm.width, h = sm.height;
  const d = ctx2d(sm).getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
  // haluskan ringan (box blur 3x3) agar teks tidak memecah kertas
  const bl = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += gray[(y + dy) * w + x + dx];
    bl[y * w + x] = s / 9;
  }
  const thr = otsu(bl);
  const mask = new Uint8Array(w * h); for (let i = 0; i < mask.length; i++) mask[i] = bl[i] > thr ? 1 : 0;
  // tutup lubang kecil (teks hitam di kertas): dilatasi 2x lalu erosi 2x
  const morph = (m, dil) => { const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dil ? 0 : 1; for (let dy = -2; dy <= 2 && (dil ? !v : v); dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx; const q = yy < 0 || yy >= h || xx < 0 || xx >= w ? 0 : m[yy * w + xx];
      if (dil && q) { v = 1; break; } if (!dil && !q) { v = 0; break; }
    } o[y * w + x] = v; } return o; };
  const closed = morph(morph(mask, true), false);
  // komponen terbesar
  const lab = new Int32Array(w * h); let best = 0, bestId = 0, id = 0; const stack = [];
  for (let i = 0; i < closed.length; i++) {
    if (!closed[i] || lab[i]) continue; id++; let n = 0; stack.push(i); lab[i] = id;
    while (stack.length) { const p = stack.pop(); n++; const x = p % w, y = (p / w) | 0;
      if (x > 0 && closed[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && closed[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && closed[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && closed[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); } }
    if (n > best) { best = n; bestId = id; }
  }
  if (best < w * h * 0.12 || best > w * h * 0.985) return null; // tidak ada kertas jelas / kertas memenuhi foto
  // sudut = titik ekstrem pada arah diagonal
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl2 = [0, 0, Infinity];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lab[y * w + x] !== bestId) continue;
    const s = x + y, df = x - y;
    if (s < tl[2]) tl = [x, y, s]; if (s > br[2]) br = [x, y, s];
    if (df > tr[2]) tr = [x, y, df]; if (df < bl2[2]) bl2 = [x, y, df];
  }
  const k = src.width / w;
  let pts = [tl, tr, br, bl2].map(([x, y]) => [x * k, y * k]);
  // geser sedikit ke dalam agar tepi meja tidak ikut terpotong masuk
  const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
  const inset = Math.hypot(src.width, src.height) * 0.006;
  pts = pts.map(([x, y]) => { const dx = cx - x, dy = cy - y, L = Math.hypot(dx, dy) || 1; return [x + dx / L * inset, y + dy / L * inset]; });
  // validasi: luas segi empat cukup besar
  const area = Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % 4]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  if (area < src.width * src.height * 0.1) return null;
  return pts;
}
export function defaultCorners(src) { const m = Math.min(src.width, src.height) * 0.03; return [[m, m], [src.width - m, m], [src.width - m, src.height - m], [m, src.height - m]]; }

/* ---------------- luruskan perspektif ---------------- */
function homography(srcPts, dstPts) { // H memetakan dst → src (untuk inverse mapping)
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dstPts[i], [u, v] = srcPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) { // eliminasi Gauss
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]).concat(1);
}
export function warp(src, corners) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [tl, tr, br, bl] = corners;
  let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, MAX_SIDE / Math.max(W, H)); W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  const Hm = homography(corners, [[0, 0], [W, 0], [W, H], [0, H]]);
  const sd = ctx2d(src).getImageData(0, 0, src.width, src.height).data, sw = src.width, sh = src.height;
  const out = canvasOf(W, H); const og = ctx2d(out); const od = og.createImageData(W, H); const o = od.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const X = x + 0.5, Y = y + 0.5, z = Hm[6] * X + Hm[7] * Y + Hm[8];
      let u = (Hm[0] * X + Hm[1] * Y + Hm[2]) / z - 0.5, v = (Hm[3] * X + Hm[4] * Y + Hm[5]) / z - 0.5;
      u = Math.min(Math.max(u, 0), sw - 1.001); v = Math.min(Math.max(v, 0), sh - 1.001);
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, j = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) o[j + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      o[j + 3] = 255;
    }
  }
  og.putImageData(od, 0, 0);
  return out;
}

/* ---------------- filter ala scanner ---------------- */
export function applyFilter(src, mode) {
  const c = canvasOf(src.width, src.height); const g = ctx2d(c); g.drawImage(src, 0, 0);
  if (mode === 'none') return c;
  const id = g.getImageData(0, 0, c.width, c.height); const p = id.data; const n = c.width * c.height;
  const lum = new Float32Array(n); for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = 0.299 * p[j] + 0.587 * p[j + 1] + 0.114 * p[j + 2];
  if (mode === 'bw') { // ambang adaptif (rata-rata lokal via integral image) → teks hitam tegas, latar putih bersih
    const w = c.width, h = c.height, I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += lum[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    const r = Math.max(8, Math.round(Math.max(w, h) / 40));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const mean = s / ((x1 - x0) * (y1 - y0)); const v = lum[y * w + x] < mean * 0.86 ? 0 : 255; const j = (y * w + x) * 4;
      p[j] = p[j + 1] = p[j + 2] = v;
    }
  } else { // 'doc' (warna) & 'gray': ratakan pencahayaan lalu regangkan kontras
    const w = c.width, h = c.height;
    // estimasi latar (kertas) dengan blur besar → bagi agar bayangan/cahaya tak merata hilang
    const bs = Math.max(1, Math.round(Math.max(w, h) / 24));
    const small = canvasOf(Math.ceil(w / bs), Math.ceil(h / bs)); const sg = ctx2d(small);
    sg.imageSmoothingQuality = 'high'; sg.drawImage(src, 0, 0, small.width, small.height);
    const sd = sg.getImageData(0, 0, small.width, small.height).data;
    const bgS = new Float32Array(small.width * small.height);
    for (let i = 0, j = 0; i < bgS.length; i++, j += 4) bgS[i] = Math.max(sd[j], sd[j + 1], sd[j + 2]);
    // maksimum lokal 3x3 di peta kecil (latar = bagian paling terang)
    const bgM = new Float32Array(bgS.length); const sw = small.width, sh = small.height;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { let m = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < sh && xx >= 0 && xx < sw) m = Math.max(m, bgS[yy * sw + xx]); } bgM[y * sw + x] = Math.max(m, 40); }
    const bgAt = (x, y) => { // bilinear
      const fx = Math.min(sw - 1, Math.max(0, x / bs - 0.5)), fy = Math.min(sh - 1, Math.max(0, y / bs - 0.5));
      const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      return (bgM[y0 * sw + x0] * (1 - ax) + bgM[y0 * sw + x1] * ax) * (1 - ay) + (bgM[y1 * sw + x0] * (1 - ax) + bgM[y1 * sw + x1] * ax) * ay;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4; const k = 255 / bgAt(x, y);
      if (mode === 'gray') { const v = lum[y * w + x] * k; p[j] = p[j + 1] = p[j + 2] = v; }
      else { p[j] *= k; p[j + 1] *= k; p[j + 2] *= k; }
    }
    // kontras: titik hitam di persentil 2%, putih dibulatkan
    const hist = new Uint32Array(256); for (let j = 0; j < p.length; j += 4) hist[Math.min(255, (p[j] + p[j + 1] + p[j + 2]) / 3 | 0)]++;
    let acc = 0, lo = 0; while (lo < 200 && (acc += hist[lo]) < n * 0.02) lo++;
    const hi = 235, sc = 255 / Math.max(30, hi - lo);
    for (let j = 0; j < p.length; j += 4) for (let c3 = 0; c3 < 3; c3++) { const v = (p[j + c3] - lo) * sc; p[j + c3] = v < 0 ? 0 : v > 255 ? 255 : v; }
  }
  g.putImageData(id, 0, 0);
  return c;
}

/* =====================================================================
   UI pemindai
   ===================================================================== */
const FILTERS = [['doc', 'Dokumen'], ['bw', 'Hitam-putih'], ['gray', 'Abu-abu'], ['none', 'Asli']];
let state = null;

export function openScanner({ hasDoc, toast, onDone }) {
  const dlg = $('#dlgScan');
  state = { pages: [], cur: -1, stream: null, deviceId: null, toast, onDone, dragging: null };
  $('#scanMode').innerHTML = hasDoc ? '<option value="new">Dokumen PDF baru</option><option value="insert">Sisipkan ke dokumen yang terbuka</option>' : '<option value="new">Dokumen PDF baru</option>';
  $('#scanFilter').innerHTML = FILTERS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  try { $('#scanFilter').value = localStorage.getItem('klmpdf.scanFilter') || 'doc'; } catch { $('#scanFilter').value = 'doc'; }
  renderStrip(); showEditor(false);
  if (!dlg.open) dlg.showModal();
  dlg.addEventListener('close', stopCamera, { once: true });
  if (navigator.mediaDevices?.getUserMedia) startCamera().catch(() => { });
  else setCamMsg('Kamera tidak tersedia di perangkat ini. Gunakan "Pilih foto".');
}

function setCamMsg(t) { const m = $('#scanCamMsg'); m.textContent = t || ''; m.hidden = !t; }
async function startCamera(deviceId) {
  stopCamera();
  setCamMsg('Menyalakan kamera…');
  const video = $('#scanVideo');
  try {
    const constraints = { video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } } : { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.stream; await video.play().catch(() => { });
    const track = state.stream.getVideoTracks()[0];
    state.deviceId = track?.getSettings?.().deviceId || deviceId || null;
    setCamMsg('');
    $('#scanShot').disabled = false;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const sel = $('#scanCam');
    sel.innerHTML = cams.map((c, i) => `<option value="${c.deviceId}" ${c.deviceId === state.deviceId ? 'selected' : ''}>${(c.label || 'Kamera ' + (i + 1)).replace(/[<>&"]/g, '')}</option>`).join('');
    sel.hidden = cams.length < 2;
  } catch (e) {
    $('#scanShot').disabled = true;
    setCamMsg(e?.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan kamera, atau gunakan "Pilih foto".' : e?.name === 'NotFoundError' ? 'Tidak ada kamera. Gunakan "Pilih foto" (foto dari HP/scanner).' : 'Kamera tidak bisa dibuka: ' + (e?.message || e));
  }
}
function stopCamera() {
  if (!state?.stream) return;
  for (const t of state.stream.getTracks()) t.stop();
  state.stream = null; const v = $('#scanVideo'); if (v) v.srcObject = null;
}

async function addSource(canvas) {
  const corners = detectCorners(canvas);
  const page = { src: canvas, corners: corners || defaultCorners(canvas), auto: !!corners, filter: $('#scanFilter').value, thumb: null };
  state.pages.push(page);
  state.cur = state.pages.length - 1;
  await refreshThumb(page);
  renderStrip(); showEditor(true);
}
async function refreshThumb(page) {
  const out = applyFilter(scaledCopy(warp(scaledCopy(page.src, 900), page.corners.map(([x, y]) => [x * Math.min(1, 900 / Math.max(page.src.width, page.src.height)), y * Math.min(1, 900 / Math.max(page.src.width, page.src.height))])), 260), page.filter);
  page.thumb = out.toDataURL('image/jpeg', 0.8);
}
function renderStrip() {
  const s = $('#scanStrip');
  s.innerHTML = state.pages.map((p, i) => `<button type="button" class="sp ${i === state.cur ? 'on' : ''}" data-i="${i}" title="Halaman ${i + 1}"><img src="${p.thumb}" alt=""><span>${i + 1}</span></button>`).join('')
    || '<p class="muted small">Belum ada halaman. Ambil foto dengan kamera atau pilih foto dokumen.</p>';
  $('#scanCount').textContent = state.pages.length ? `${state.pages.length} halaman` : '';
  $('#scanDone').disabled = !state.pages.length;
}
function showEditor(on) {
  $('#scanEdit').hidden = !on || state.cur < 0;
  $('#scanLive').hidden = on && state.cur >= 0;
  if (on && state.cur >= 0) { const p = state.pages[state.cur]; $('#scanFilter').value = p.filter; drawEditor(); }
}
/* editor sudut */
function drawEditor() {
  const p = state.pages[state.cur]; if (!p) return;
  const cv = $('#scanCanvas'); const box = $('#scanEditBox');
  const maxW = box.clientWidth || 640, maxH = Math.min(box.clientHeight || 420, window.innerHeight * 0.55);
  const k = Math.min(maxW / p.src.width, maxH / p.src.height);
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.style.width = p.src.width * k + 'px'; cv.style.height = p.src.height * k + 'px';
  cv.width = Math.round(p.src.width * k * dpr); cv.height = Math.round(p.src.height * k * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
  g.drawImage(p.src, 0, 0);
  const c = p.corners;
  g.fillStyle = 'rgba(0,0,0,.45)'; g.beginPath(); g.rect(0, 0, p.src.width, p.src.height);
  g.moveTo(...c[0]); g.lineTo(...c[3]); g.lineTo(...c[2]); g.lineTo(...c[1]); g.closePath(); g.fill('evenodd');
  g.strokeStyle = '#1473e6'; g.lineWidth = 2.5 / k; g.beginPath(); g.moveTo(...c[0]); for (const q of [c[1], c[2], c[3], c[0]]) g.lineTo(...q); g.stroke();
  for (const q of c) { g.beginPath(); g.arc(q[0], q[1], 11 / k, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,.9)'; g.fill(); g.lineWidth = 3 / k; g.stroke(); }
  state.k = k;
  $('#scanEditInfo').textContent = p.auto ? 'Tepi kertas terdeteksi otomatis — seret titik biru untuk menyesuaikan.' : 'Seret titik biru ke sudut-sudut kertas.';
}
function canvasPoint(e) { const r = $('#scanCanvas').getBoundingClientRect(); return [(e.clientX - r.left) / state.k, (e.clientY - r.top) / state.k]; }

let wired = false;
export function wireScanner() {
  if (wired) return; wired = true;
  const cv = $('#scanCanvas');
  cv.addEventListener('pointerdown', e => {
    const p = state?.pages[state.cur]; if (!p) return;
    const pt = canvasPoint(e); let bi = -1, bd = 34 / state.k;
    p.corners.forEach((q, i) => { const d = Math.hypot(q[0] - pt[0], q[1] - pt[1]); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) return;
    state.dragging = bi; cv.setPointerCapture(e.pointerId); e.preventDefault();
  });
  cv.addEventListener('pointermove', e => {
    if (state?.dragging == null) return; const p = state.pages[state.cur]; const pt = canvasPoint(e);
    p.corners[state.dragging] = [Math.min(Math.max(pt[0], 0), p.src.width), Math.min(Math.max(pt[1], 0), p.src.height)];
    p.auto = false; drawEditor();
  });
  const end = async () => { if (state?.dragging == null) return; state.dragging = null; const p = state.pages[state.cur]; await refreshThumb(p); renderStrip(); };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

  $('#scanShot').addEventListener('click', async () => {
    const v = $('#scanVideo'); if (!v.videoWidth) return;
    const c = canvasOf(v.videoWidth, v.videoHeight); ctx2d(c).drawImage(v, 0, 0);
    const fl = $('#scanFlash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
    await addSource(c);
  });
  $('#scanCam').addEventListener('change', e => startCamera(e.target.value));
  $('#scanPick').addEventListener('click', () => $('#scanFile').click());
  $('#scanFile').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      if (!f.type.startsWith('image/')) { state.toast?.('Lewati ' + f.name + ' (bukan gambar)', 'err'); continue; }
      try { await addSource(await fileToCanvas(f)); } catch (err) { state.toast?.(err.message, 'err'); }
    }
  });
  $('#scanStrip').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; state.cur = +b.dataset.i; renderStrip(); showEditor(true); });
  $('#scanBack').addEventListener('click', () => { state.cur = -1; renderStrip(); showEditor(false); });
  $('#scanFilter').addEventListener('change', async e => {
    try { localStorage.setItem('klmpdf.scanFilter', e.target.value); } catch { }
    const p = state.pages[state.cur]; if (!p) return; p.filter = e.target.value; await refreshThumb(p); renderStrip();
  });
  $('#scanAuto').addEventListener('click', async () => {
    const p = state.pages[state.cur]; if (!p) return;
    const c = detectCorners(p.src); p.corners = c || defaultCorners(p.src); p.auto = !!c;
    if (!c) state.toast?.('Tepi kertas tidak terdeteksi — atur titik secara manual', 'err');
    drawEditor(); await refreshThumb(p); renderStrip();
  });
  $('#scanFull').addEventListener('click', async () => {
    const p = state.pages[state.cur]; if (!p) return; const w = p.src.width, h = p.src.height;
    p.corners = [[0, 0], [w, 0], [w, h], [0, h]]; p.auto = false; drawEditor(); await refreshThumb(p); renderStrip();
  });
  for (const [id, dir] of [['#scanRotL', -1], ['#scanRotR', 1]]) $(id).addEventListener('click', async () => {
    const p = state.pages[state.cur]; if (!p) return;
    const W = p.src.width, H = p.src.height;
    p.src = rotateCanvas(p.src, dir);
    p.corners = p.corners.map(([x, y]) => dir > 0 ? [H - y, x] : [y, W - x]);
    if (dir > 0) p.corners.unshift(p.corners.pop()); else p.corners.push(p.corners.shift());
    drawEditor(); await refreshThumb(p); renderStrip();
  });
  $('#scanDel').addEventListener('click', () => {
    if (state.cur < 0) return; state.pages.splice(state.cur, 1);
    state.cur = Math.min(state.cur, state.pages.length - 1); renderStrip(); showEditor(state.cur >= 0);
  });
  $('#scanLeft').addEventListener('click', () => move(-1));
  $('#scanRight').addEventListener('click', () => move(1));
  function move(d) { const i = state.cur, j = i + d; if (i < 0 || j < 0 || j >= state.pages.length) return; [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]]; state.cur = j; renderStrip(); }
  window.addEventListener('resize', () => { if ($('#dlgScan').open && state?.cur >= 0) drawEditor(); });

  $('#scanDone').addEventListener('click', async () => {
    if (!state.pages.length) return;
    const btn = $('#scanDone'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Memproses…';
    try {
      const out = [];
      for (const p of state.pages) {
        const img = applyFilter(warp(p.src, p.corners), p.filter);
        const type = p.filter === 'bw' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise(r => img.toBlob(r, type, 0.9));
        out.push({ bytes: new Uint8Array(await blob.arrayBuffer()), type, w: img.width, h: img.height });
      }
      const mode = $('#scanMode').value, paper = $('#scanPaper').value;
      $('#dlgScan').close();
      await state.onDone(out, { mode, paper });
    } catch (e) { state.toast?.('Gagal memproses scan: ' + (e?.message || e), 'err', 5000); }
    finally { btn.disabled = false; btn.textContent = old; }
  });
}
