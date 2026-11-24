/* =====================================================================
   KLM PDF — TrueType: parser, subset (kosongkan glyph tak terpakai),
   dan penyematan ke PDF sebagai font Type0 / CIDFontType2 (Identity-H)
   lengkap dengan ToUnicode agar teks bisa dipilih, disalin, dan dicari.
   ===================================================================== */
const PL = window.PDFLib;
const tagAt = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** Uraikan file .ttf / .ttc. wantPs = nama PostScript yang dicari di dalam koleksi. */
export function parseFont(input, wantPs = null) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offsets = [0];
  if (tagAt(dv, 0) === 'ttcf') {
    const n = dv.getUint32(8); offsets = [];
    for (let i = 0; i < n; i++) offsets.push(dv.getUint32(12 + i * 4));
  }
  let first = null;
  for (const off of offsets) {
    let f; try { f = parseFace(bytes, dv, off); } catch { f = null; }
    if (!f) continue;
    if (!wantPs || f.psName === wantPs) return f;
    first ||= f;
  }
  return first;
}

function parseFace(bytes, dv, off) {
  const ver = dv.getUint32(off);
  if (ver === 0x4F54544F) return { cff: true }; // 'OTTO' (CFF) — tidak didukung untuk subset
  const nt = dv.getUint16(off + 4);
  const tables = {};
  for (let i = 0; i < nt; i++) { const r = off + 12 + i * 16; tables[tagAt(dv, r)] = { off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) }; }
  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap']) if (!tables[t]) return null;
  const f = { bytes, dv, tables };
  const h = tables.head.off;
  f.upm = dv.getUint16(h + 18) || 1000;
  f.bbox = [dv.getInt16(h + 36), dv.getInt16(h + 38), dv.getInt16(h + 40), dv.getInt16(h + 42)];
  f.locFmt = dv.getInt16(h + 50);
  f.macStyle = dv.getUint16(h + 44);
  const hh = tables.hhea.off;
  f.ascent = dv.getInt16(hh + 4); f.descent = dv.getInt16(hh + 6); f.nHM = dv.getUint16(hh + 34) || 1;
  f.numGlyphs = dv.getUint16(tables.maxp.off + 4);
  f.capHeight = Math.round(f.ascent * 0.7); f.italicAngle = 0; f.fsType = 0; f.weight = f.macStyle & 1 ? 700 : 400;
  const os2 = tables['OS/2'];
  if (os2) {
    const o = os2.off, v = dv.getUint16(o);
    f.weight = dv.getUint16(o + 4) || f.weight; f.fsType = dv.getUint16(o + 8);
    if (v >= 2 && os2.len >= 90) f.capHeight = dv.getInt16(o + 88) || f.capHeight;
  }
  if (tables.post) f.italicAngle = dv.getInt32(tables.post.off + 4) / 65536;
  f.italic = !!(f.macStyle & 2) || f.italicAngle !== 0;
  f.psName = readName(f, 6) || 'KLMFont';
  f.family = readName(f, 1) || f.psName;
  f.restricted = (f.fsType & 0x000F) === 0x0002; // lisensi melarang penyematan
  f.gid = makeCmap(f);
  return f;
}

function readName(f, id) {
  const t = f.tables.name; if (!t) return null;
  const { dv, bytes } = f; const o = t.off;
  const count = dv.getUint16(o + 2), so = o + dv.getUint16(o + 4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const r = o + 6 + i * 12;
    const pid = dv.getUint16(r), eid = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), nid = dv.getUint16(r + 6);
    if (nid !== id) continue;
    const len = dv.getUint16(r + 8), off = so + dv.getUint16(r + 10);
    let s = '';
    if (pid === 3 || pid === 0) { for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(off + k)); }
    else if (pid === 1) { for (let k = 0; k < len; k++) s += String.fromCharCode(bytes[off + k]); }
    else continue;
    const score = (pid === 3 && lang === 0x409 ? 3 : pid === 3 ? 2 : 1);
    if (!best || score > best.score) best = { s, score };
  }
  return best?.s?.replace(/\0/g, '') || null;
}

function makeCmap(f) {
  const { dv } = f; const c = f.tables.cmap.off;
  const n = dv.getUint16(c + 2);
  let s12 = null, s4 = null;
  for (let i = 0; i < n; i++) {
    const r = c + 4 + i * 8, pid = dv.getUint16(r), eid = dv.getUint16(r + 2), so = c + dv.getUint32(r + 4);
    const fmt = dv.getUint16(so);
    if (fmt === 12 && ((pid === 3 && eid === 10) || pid === 0)) s12 ||= so;
    if (fmt === 4 && ((pid === 3 && (eid === 1 || eid === 0)) || pid === 0)) s4 ||= so;
  }
  const cache = new Map();
  if (s12) {
    const ng = dv.getUint32(s12 + 12), g0 = s12 + 16;
    return cp => {
      let lo = 0, hi = ng - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1, r = g0 + m * 12, st = dv.getUint32(r), en = dv.getUint32(r + 4);
        if (cp < st) hi = m - 1; else if (cp > en) lo = m + 1; else return dv.getUint32(r + 8) + (cp - st);
      }
      return 0;
    };
  }
  if (s4) {
    const segX2 = dv.getUint16(s4 + 6), seg = segX2 / 2;
    const ends = s4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ros = deltas + segX2;
    return cp => {
      if (cp > 0xFFFF) return 0;
      if (cache.has(cp)) return cache.get(cp);
      let lo = 0, hi = seg - 1, g = 0;
      while (lo < hi) { const m = (lo + hi) >> 1; if (dv.getUint16(ends + m * 2) < cp) lo = m + 1; else hi = m; }
      const m = lo, st = dv.getUint16(starts + m * 2);
      if (dv.getUint16(ends + m * 2) >= cp && st <= cp) {
        const delta = dv.getInt16(deltas + m * 2), ro = dv.getUint16(ros + m * 2);
        if (!ro) g = (cp + delta) & 0xFFFF;
        else { const a = ros + m * 2 + ro + (cp - st) * 2; const gi = a + 1 < dv.byteLength ? dv.getUint16(a) : 0; g = gi ? (gi + delta) & 0xFFFF : 0; }
      }
      if (g >= 0xFFFF) g = 0;
      cache.set(cp, g); return g;
    };
  }
  return () => 0;
}

export function advance(f, gid) {
  const h = f.tables.hmtx.off;
  return f.dv.getUint16(h + Math.min(gid, f.nHM - 1) * 4);
}
function locaAt(f, g) { const o = f.tables.loca.off; return f.locFmt ? f.dv.getUint32(o + g * 4) : f.dv.getUint16(o + g * 2) * 2; }

/** Subset: semua glyph selain yang dipakai dikosongkan (GID tetap sama). */
export function subsetFont(f, gids) {
  const { dv, bytes } = f; const glyf = f.tables.glyf.off;
  const keep = new Set([0, ...gids]); const stack = [...keep];
  while (stack.length) { // komponen glyph komposit
    const g = stack.pop(); if (g >= f.numGlyphs) continue;
    const s = locaAt(f, g), e = locaAt(f, g + 1); if (e - s < 10) continue;
    let p = glyf + s; if (dv.getInt16(p) >= 0) continue;
    p += 10;
    for (let guard = 0; guard < 500; guard++) {
      const fl = dv.getUint16(p), cg = dv.getUint16(p + 2);
      if (!keep.has(cg)) { keep.add(cg); stack.push(cg); }
      p += 4 + (fl & 1 ? 4 : 2) + (fl & 8 ? 2 : fl & 0x40 ? 4 : fl & 0x80 ? 8 : 0);
      if (!(fl & 0x20)) break;
    }
  }
  const parts = []; let size = 0;
  const loca = new DataView(new ArrayBuffer((f.numGlyphs + 1) * 4));
  for (let g = 0; g < f.numGlyphs; g++) {
    loca.setUint32(g * 4, size);
    if (!keep.has(g)) continue;
    const s = locaAt(f, g), e = locaAt(f, g + 1);
    if (e > s) { const len = e - s, pad = (4 - (len & 3)) & 3; parts.push(bytes.subarray(glyf + s, glyf + e)); if (pad) parts.push(new Uint8Array(pad)); size += len + pad; }
  }
  loca.setUint32(f.numGlyphs * 4, size);
  const glyfOut = new Uint8Array(size); let p = 0; for (const x of parts) { glyfOut.set(x, p); p += x.length; }
  const tbl = t => f.tables[t] && bytes.slice(f.tables[t].off, f.tables[t].off + f.tables[t].len);
  const head = tbl('head'); const hv = new DataView(head.buffer); hv.setUint32(8, 0); hv.setInt16(50, 1);
  const out = { head, hhea: tbl('hhea'), maxp: tbl('maxp'), hmtx: tbl('hmtx'), loca: new Uint8Array(loca.buffer), glyf: glyfOut };
  for (const t of ['cvt ', 'fpgm', 'prep']) if (f.tables[t]) out[t] = tbl(t);
  return writeSfnt(out);
}
function writeSfnt(tables) {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  let off = 12 + n * 16;
  const recs = tags.map(t => { const d = tables[t]; const r = { t, d, off, len: d.length }; off += (d.length + 3) & ~3; return r; });
  const out = new Uint8Array(off); const dv = new DataView(out.buffer);
  let es = 0; while ((1 << (es + 1)) <= n) es++;
  dv.setUint32(0, 0x00010000); dv.setUint16(4, n); dv.setUint16(6, (1 << es) * 16); dv.setUint16(8, es); dv.setUint16(10, n * 16 - (1 << es) * 16);
  recs.forEach((r, i) => {
    out.set(r.d, r.off);
    let sum = 0; const pdv = new DataView(out.buffer, r.off, (r.len + 3) & ~3);
    for (let k = 0; k < pdv.byteLength; k += 4) sum = (sum + pdv.getUint32(k)) >>> 0;
    const b = 12 + i * 16;
    for (let k = 0; k < 4; k++) dv.setUint8(b + k, r.t.charCodeAt(k));
    dv.setUint32(b + 4, sum); dv.setUint32(b + 8, r.off); dv.setUint32(b + 12, r.len);
  });
  return out;
}

/* ---------------- penyematan ke PDF ---------------- */
const randTag = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
export class FontRegistry {
  constructor(pdfDoc) { this.doc = pdfDoc; this.entries = new Map(); this.n = 0; }
  entry(face, key = face.psName) {
    let e = this.entries.get(key);
    if (!e) { e = { face, ref: this.doc.context.nextRef(), name: 'KF' + randTag() + (++this.n), used: new Map() }; this.entries.set(key, e); }
    return e;
  }
  /** teks → string hex GID (mencatat glyph yang dipakai) */
  encode(e, text) {
    let hex = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0); const g = e.face.gid(cp);
      if (!e.used.has(g)) e.used.set(g, cp);
      hex += g.toString(16).padStart(4, '0');
    }
    return hex;
  }
  width(face, text, size) { let w = 0; for (const ch of text) w += advance(face, face.gid(ch.codePointAt(0))); return w * size / face.upm; }
  /** daftarkan font di resource halaman; kembalikan nama yang dipakai (unik per halaman) */
  attach(page, e) {
    const dict = page.node.normalizedEntries().Font;
    let name = e.name;
    for (let i = 0; ; i++) {
      const cur = dict.get(PL.PDFName.of(name));
      if (!cur) { dict.set(PL.PDFName.of(name), e.ref); return name; }
      if (cur instanceof PL.PDFRef && cur.objectNumber === e.ref.objectNumber) return name;
      name = e.name + '_' + i;
    }
  }
  finalize() {
    const ctx = this.doc.context;
    for (const e of this.entries.values()) {
      const f = e.face, k = 1000 / f.upm;
      const gids = [...e.used.keys()].sort((a, b) => a - b);
      const sub = subsetFont(f, gids);
      const ff = ctx.register(ctx.flateStream(sub, { Length1: sub.length }));
      const base = randTag() + '+' + f.psName.replace(/[^A-Za-z0-9\-_.]/g, '');
      const desc = ctx.register(ctx.obj({
        Type: 'FontDescriptor', FontName: base, Flags: 4 | (f.italic ? 64 : 0),
        FontBBox: f.bbox.map(v => Math.round(v * k)), ItalicAngle: f.italicAngle,
        Ascent: Math.round(f.ascent * k), Descent: Math.round(f.descent * k), CapHeight: Math.round(f.capHeight * k),
        StemV: f.weight >= 600 ? 140 : 80, FontFile2: ff,
      }));
      const W = [];
      for (let i = 0; i < gids.length;) {
        const start = gids[i], ws = [];
        while (i < gids.length && gids[i] === start + ws.length) { ws.push(Math.round(advance(f, gids[i]) * k)); i++; }
        W.push(start, ws);
      }
      const cid = ctx.register(ctx.obj({
        Type: 'Font', Subtype: 'CIDFontType2', BaseFont: base,
        CIDSystemInfo: { Registry: PL.PDFString.of('Adobe'), Ordering: PL.PDFString.of('Identity'), Supplement: 0 },
        FontDescriptor: desc, W, DW: 1000, CIDToGIDMap: 'Identity',
      }));
      const tu = ctx.register(ctx.flateStream(new TextEncoder().encode(toUnicodeCMap(e.used))));
      ctx.assign(e.ref, ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: base, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
    }
  }
}
function toUnicodeCMap(used) {
  const hex = n => n.toString(16).padStart(4, '0');
  const u16 = cp => cp > 0xFFFF ? hex(0xD800 + ((cp - 0x10000) >> 10)) + hex(0xDC00 + ((cp - 0x10000) & 0x3FF)) : hex(cp);
  const ent = [...used.entries()].filter(([g]) => g);
  let body = '';
  for (let i = 0; i < ent.length; i += 100) {
    const ch = ent.slice(i, i + 100);
    body += `${ch.length} beginbfchar\n${ch.map(([g, cp]) => `<${hex(g)}> <${u16(cp)}>`).join('\n')}\nendbfchar\n`;
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}
