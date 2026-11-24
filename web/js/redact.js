/* =====================================================================
   KLM PDF — hapus teks asli di dalam area tertentu (content stream)
   Dipakai untuk "Edit teks" dan "Tutup/hapus area" agar teks lama
   benar-benar hilang (tidak bisa disalin/dicari), bukan sekadar ditimpa.
   Posisi glyph lain tetap persis karena glyph yang dihapus diganti
   pergeseran (angka di operator TJ).
   ===================================================================== */
const PL = window.PDFLib;
const N = PL.PDFName.of;
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const mul = (f, s) => [f[0] * s[0] + f[1] * s[2], f[0] * s[1] + f[1] * s[3], f[2] * s[0] + f[3] * s[2], f[2] * s[1] + f[3] * s[3], f[4] * s[0] + f[5] * s[2] + s[4], f[4] * s[1] + f[5] * s[3] + s[5]];
const app = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* ---------------- tokenizer ---------------- */
function tokenize(b) {
  const ops = []; let args = [], opStart = -1, i = 0; const n = b.length;
  const stack = [];
  const push = tok => { if (stack.length) stack[stack.length - 1].items.push(tok); else args.push(tok); };
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (opStart < 0) opStart = i;
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; if (!args.length && !stack.length) opStart = -1; continue; }
    if (c === 40) { // (string)
      const out = []; let depth = 1; i++;
      while (i < n && depth) {
        let ch = b[i++];
        if (ch === 92) {
          const e = b[i++];
          if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9); else if (e === 98) out.push(8); else if (e === 102) out.push(12);
          else if (e >= 48 && e <= 55) { let v = e - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48; out.push(v & 255); }
          else if (e === 13) { if (b[i] === 10) i++; }
          else if (e === 10) { }
          else out.push(e);
          continue;
        }
        if (ch === 40) depth++; else if (ch === 41) { depth--; if (!depth) break; }
        out.push(ch);
      }
      push({ t: 's', v: Uint8Array.from(out) }); continue;
    }
    if (c === 60 && b[i + 1] === 60) { stack.push({ t: 'd', items: [] }); i += 2; continue; }
    if (c === 62 && b[i + 1] === 62) { const d = stack.pop(); i += 2; if (d) push(d); continue; }
    if (c === 60) { // <hex>
      i++; let h = '';
      while (i < n && b[i] !== 62) { if (!WS.has(b[i])) h += String.fromCharCode(b[i]); i++; }
      i++; if (h.length % 2) h += '0';
      const v = new Uint8Array(h.length / 2); for (let k = 0; k < v.length; k++) v[k] = parseInt(h.substr(k * 2, 2), 16) || 0;
      push({ t: 's', v }); continue;
    }
    if (c === 91) { stack.push({ t: 'a', items: [] }); i++; continue; }
    if (c === 93) { const a = stack.pop(); i++; if (a) push(a); continue; }
    if (c === 123 || c === 125) { i++; continue; }
    if (c === 47) { let j = i + 1; while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++; push({ t: 'n', v: String.fromCharCode(...b.subarray(i + 1, j)) }); i = j; continue; }
    // angka atau operator
    let j = i; while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
    if (j === i) { i++; continue; }
    const word = String.fromCharCode(...b.subarray(i, j));
    if (/^[+\-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push({ t: 'f', v: parseFloat(word) }); i = j; continue; }
    if (word === 'true' || word === 'false' || word === 'null') { push({ t: 'k', v: word }); i = j; continue; }
    if (stack.length) { i = j; continue; } // operator di dalam array/dict — rusak, abaikan
    if (word === 'BI') { // gambar inline: lewati sampai EI
      let k = j;
      while (k < n) {
        if (b[k] === 69 && b[k + 1] === 73 && (k === 0 || WS.has(b[k - 1])) && (k + 2 >= n || WS.has(b[k + 2]))) { k += 2; break; }
        k++;
      }
      ops.push({ op: 'BI', args: [], s: opStart, e: k }); args = []; opStart = -1; i = k; continue;
    }
    ops.push({ op: word, args, s: opStart, e: j }); args = []; opStart = -1; i = j;
  }
  return ops;
}

/* ---------------- fonts ---------------- */
const mctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
function fontInfo(ctx, dict) {
  if (!(dict instanceof PL.PDFDict)) return null;
  const nm = k => { const v = dict.lookup(N(k)); return v instanceof PL.PDFName ? v.decodeText() : null; };
  const sub = nm('Subtype');
  if (sub === 'Type3') return null;
  if (sub === 'Type0') {
    const enc = nm('Encoding');
    if (enc !== 'Identity-H' && enc !== 'Identity-V') return null;
    const df = dict.lookup(N('DescendantFonts'));
    const d = df instanceof PL.PDFArray ? df.lookup(0) : null;
    if (!(d instanceof PL.PDFDict)) return null;
    const dwv = d.lookup(N('DW')); const DW = dwv instanceof PL.PDFNumber ? dwv.asNumber() : 1000;
    const W = new Map(); const arr = d.lookup(N('W'));
    if (arr instanceof PL.PDFArray) {
      for (let i = 0; i < arr.size();) {
        const a = arr.lookup(i), b = arr.lookup(i + 1);
        if (b instanceof PL.PDFArray) { const s = a.asNumber(); for (let k = 0; k < b.size(); k++) W.set(s + k, b.lookup(k).asNumber()); i += 2; }
        else { const s = a.asNumber(), e = b.asNumber(), w = arr.lookup(i + 2).asNumber(); for (let k = s; k <= e && k - s < 70000; k++) W.set(k, w); i += 3; }
      }
    }
    return { bytes: 2, width: c => W.get(c) ?? DW };
  }
  const fc = dict.lookup(N('FirstChar')); const ws = dict.lookup(N('Widths'));
  const first = fc instanceof PL.PDFNumber ? fc.asNumber() : 0;
  const desc = dict.lookup(N('FontDescriptor'));
  const mwv = desc instanceof PL.PDFDict ? desc.lookup(N('MissingWidth')) : null;
  const missing = mwv instanceof PL.PDFNumber ? mwv.asNumber() : 0;
  if (ws instanceof PL.PDFArray && ws.size()) {
    const w = []; for (let i = 0; i < ws.size(); i++) { const v = ws.lookup(i); w.push(v instanceof PL.PDFNumber ? v.asNumber() : 0); }
    return { bytes: 1, width: c => (c >= first && c < first + w.length) ? w[c - first] : missing };
  }
  // 14 font standar tanpa /Widths → ukur dengan huruf yang metriknya setara
  const base = nm('BaseFont') || 'Helvetica';
  const fam = /courier/i.test(base) ? '"Courier New",Courier,monospace' : /times/i.test(base) ? '"Times New Roman",Times,serif' : 'Arial,Helvetica,sans-serif';
  const wt = /bold/i.test(base) ? 'bold ' : ''; const it = /italic|oblique/i.test(base) ? 'italic ' : '';
  const cache = new Map();
  return {
    bytes: 1, width: c => {
      if (!cache.has(c)) { mctx.font = `${it}${wt}1000px ${fam}`; cache.set(c, mctx.measureText(String.fromCharCode(c)).width); }
      return cache.get(c);
    },
  };
}

/* ---------------- main ---------------- */
const fmtN = v => { const s = (Math.round(v * 1000) / 1000).toString(); return s === '-0' ? '0' : s; };
const hex = b => '<' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('') + '>';
function streamBytes(s) {
  if (s instanceof PL.PDFRawStream) return PL.decodePDFRawStream(s).decode();
  if (typeof s?.getUnencodedContents === 'function') return s.getUnencodedContents();
  throw new Error('stream?');
}

/**
 * Hapus glyph teks yang titik tengahnya berada di dalam salah satu rects (ruang PDF: [x0,y0,x1,y1]).
 * @returns {number} jumlah glyph yang dihapus
 */
export function removeTextInRects(page, rects) {
  if (!rects.length) return 0;
  const node = page.node, ctx = node.context;
  const cont = node.Contents();
  let streams = [];
  if (cont instanceof PL.PDFArray) for (let i = 0; i < cont.size(); i++) streams.push(cont.lookup(i));
  else if (cont) streams = [cont];
  if (!streams.length) return 0;
  let bytes;
  try {
    const parts = streams.map(streamBytes); const tot = parts.reduce((s, p) => s + p.length + 1, 0);
    bytes = new Uint8Array(tot); let p = 0; for (const x of parts) { bytes.set(x, p); p += x.length; bytes[p++] = 10; }
  } catch (e) { console.warn('redact: stream tidak terbaca', e); return 0; }

  const res = node.Resources();
  const fontDict = res?.lookup(N('Font'));
  const fonts = new Map();
  const getFont = name => {
    if (!fonts.has(name)) fonts.set(name, fontDict instanceof PL.PDFDict ? fontInfo(ctx, fontDict.lookup(N(name))) : null);
    return fonts.get(name);
  };
  const inside = (x, y) => rects.some(r => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);

  const ops = tokenize(bytes);
  let gs = { ctm: [1, 0, 0, 1, 0, 0], Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, fs: 0, rise: 0 };
  const stack = [];
  let Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0];
  const repl = []; let removed = 0;
  const num = a => a?.t === 'f' ? a.v : 0;
  const td = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm; };

  const show = (elems, opObj, prefix) => {
    const f = gs.font, fs = gs.fs, Th = gs.Th;
    const out = []; let changed = false, unknown = !f || !fs || !Th;
    for (const el of elems) {
      if (el.t === 'f') { const tx = -el.v / 1000 * fs * Th; Tm = mul([1, 0, 0, 1, tx, 0], Tm); out.push({ n: el.v }); continue; }
      if (el.t !== 's') continue;
      const s = el.v;
      if (unknown) { out.push({ s }); continue; }
      let keep = [];
      for (let i = 0; i + f.bytes <= s.length; i += f.bytes) {
        const code = f.bytes === 2 ? (s[i] << 8) | s[i + 1] : s[i];
        const w0 = (f.width(code) || 0) / 1000;
        const trm = mul(mul([fs * Th, 0, 0, fs, 0, gs.rise], Tm), gs.ctm);
        const [cx, cy] = app(trm, w0 / 2, 0.3);
        const tx = (w0 * fs + gs.Tc + (f.bytes === 1 && code === 32 ? gs.Tw : 0)) * Th;
        if (inside(cx, cy)) {
          if (keep.length) { out.push({ s: Uint8Array.from(keep) }); keep = []; }
          out.push({ n: -tx / (fs * Th) * 1000 }); changed = true; removed++;
        } else for (let k = 0; k < f.bytes; k++) keep.push(s[i + k]);
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
      }
      if (keep.length) out.push({ s: Uint8Array.from(keep) });
    }
    if (changed) {
      let arr = ''; let pend = 0, hasPend = false;
      for (const x of out) {
        if ('n' in x) { pend += x.n; hasPend = true; continue; }
        if (hasPend) { arr += fmtN(pend) + ' '; pend = 0; hasPend = false; }
        arr += hex(x.s) + ' ';
      }
      if (hasPend) arr += fmtN(pend);
      repl.push({ s: opObj.s, e: opObj.e, text: `${prefix}[${arr.trim()}] TJ` });
    }
  };

  for (const o of ops) {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push({ ...gs, ctm: [...gs.ctm] }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': if (a.length >= 6) gs.ctm = mul(a.slice(0, 6).map(num), gs.ctm); break;
      case 'BT': Tm = [1, 0, 0, 1, 0, 0]; Tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': gs.font = a[0]?.t === 'n' ? getFont(a[0].v) : null; gs.fs = num(a[1]); break;
      case 'Tc': gs.Tc = num(a[0]); break;
      case 'Tw': gs.Tw = num(a[0]); break;
      case 'Tz': gs.Th = num(a[0]) / 100; break;
      case 'TL': gs.TL = num(a[0]); break;
      case 'Ts': gs.rise = num(a[0]); break;
      case 'Td': td(num(a[0]), num(a[1])); break;
      case 'TD': gs.TL = -num(a[1]); td(num(a[0]), num(a[1])); break;
      case 'Tm': if (a.length >= 6) { Tm = a.slice(0, 6).map(num); Tlm = Tm; } break;
      case 'T*': td(0, -gs.TL); break;
      case 'Tj': if (a[0]) show([a[0]], o, ''); break;
      case 'TJ': if (a[0]?.t === 'a') show(a[0].items, o, ''); break;
      case "'": td(0, -gs.TL); if (a[0]) show([a[0]], o, 'T* '); break;
      case '"': gs.Tw = num(a[0]); gs.Tc = num(a[1]); td(0, -gs.TL); if (a[2]) show([a[2]], o, `${fmtN(gs.Tw)} Tw ${fmtN(gs.Tc)} Tc T* `); break;
    }
  }
  if (!repl.length) return 0;
  // susun ulang content stream
  const enc = new TextEncoder(); const chunks = []; let pos = 0;
  for (const r of repl) { chunks.push(bytes.subarray(pos, r.s), enc.encode(r.text)); pos = r.e; }
  chunks.push(bytes.subarray(pos));
  const tot = chunks.reduce((s, c) => s + c.length, 0);
  const outB = new Uint8Array(tot); let p = 0; for (const c of chunks) { outB.set(c, p); p += c.length; }
  node.set(N('Contents'), ctx.register(ctx.flateStream(outB)));
  return removed;
}
