/* =====================================================================
   KLM PDF — dekripsi PDF (Standard Security Handler, R2–R6)
   RC4 40–128 bit, AES-128 (AESV2), AES-256 (AESV3 / R5 & R6)
   Bekerja bersama pdf-lib: objek & stream didekripsi saat dimuat,
   lalu kamus /Encrypt dibuang sehingga hasil simpan tidak terkunci.
   ===================================================================== */
const PL = window.PDFLib;
const subtle = globalThis.crypto?.subtle;

/* ---------------- MD5 ---------------- */
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5(data) {
  const len = data.length, nBlocks = ((len + 8) >> 6) + 1;
  const buf = new Uint8Array(nBlocks * 64);
  buf.set(data); buf[len] = 0x80;
  const bits = len * 8, dv = new DataView(buf.buffer);
  dv.setUint32(nBlocks * 64 - 8, bits >>> 0, true);
  dv.setUint32(nBlocks * 64 - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let blk = 0; blk < nBlocks; blk++) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(blk * 64 + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

/* ---------------- RC4 ---------------- */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/* ---------------- AES (WebCrypto) ---------------- */
const keyCache = new Map();
async function aesKey(raw) {
  const k = Array.from(raw).join(',');
  let p = keyCache.get(k);
  if (!p) { p = subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt', 'decrypt']); keyCache.set(k, p); if (keyCache.size > 2000) keyCache.clear(); }
  return p;
}
/* AES-CBC tanpa padding (enkripsi) */
export async function aesEncNoPad(raw, iv, data) {
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, await aesKey(raw), data));
  return out.subarray(0, data.length);
}
/* AES-CBC dekripsi tanpa validasi padding (trik blok tambahan), lalu buang padding PKCS#7 bila valid */
export async function aesDecRaw(raw, iv, ct) {
  ct = ct.subarray(0, ct.length - (ct.length % 16));
  if (!ct.length) return new Uint8Array(0);
  const key = await aesKey(raw);
  const last = ct.subarray(ct.length - 16);
  const x = new Uint8Array(16); for (let i = 0; i < 16; i++) x[i] = last[i] ^ 16;
  const extra = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, x)).subarray(0, 16);
  const all = new Uint8Array(ct.length + 16); all.set(ct); all.set(extra, ct.length);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, all));
}
function stripPad(p) {
  if (!p.length) return p;
  const n = p[p.length - 1];
  if (n < 1 || n > 16 || n > p.length) return p;
  for (let i = p.length - n; i < p.length; i++) if (p[i] !== n) return p;
  return p.subarray(0, p.length - n);
}
async function aesDecrypt(key, data) {
  if (data.length < 16) return new Uint8Array(0);
  return stripPad(await aesDecRaw(key, data.subarray(0, 16), data.subarray(16)));
}
const sha = async (alg, d) => new Uint8Array(await subtle.digest(alg, d));

/* ---------------- key derivation ---------------- */
const PADDING = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const eq = (a, b, n = a.length) => { if (a.length < n || b.length < n) return false; for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
function padPw(pw) { const b = new Uint8Array(32); const s = latin1(pw).subarray(0, 32); b.set(s); b.set(PADDING.subarray(0, 32 - s.length), s.length); return b; }
function latin1(s) { return Uint8Array.from(String(s ?? ''), c => c.charCodeAt(0) & 255); }
const utf8 = s => new TextEncoder().encode(String(s ?? '').normalize('NFKC')).subarray(0, 127);

function alg2(pwPadded, e) {
  const n = e.keyLen;
  const p = new Uint8Array(4); new DataView(p.buffer).setInt32(0, e.P, true);
  let h = md5(cat(pwPadded, e.O.subarray(0, 32), p, e.id0, e.R >= 4 && !e.encryptMetadata ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
  if (e.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}
function checkUser(key, e) {
  if (e.R === 2) return eq(rc4(key, PADDING), e.U, 32);
  let x = rc4(key, md5(cat(PADDING, e.id0)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map(b => b ^ i), x);
  return eq(x, e.U, 16);
}
function ownerToUserPw(pw, e) {
  let h = md5(padPw(pw));
  if (e.R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const k = h.subarray(0, e.keyLen);
  if (e.R === 2) return rc4(k, e.O.subarray(0, 32));
  let x = e.O.subarray(0, 32);
  for (let i = 19; i >= 0; i--) x = rc4(k.map(b => b ^ i), x);
  return x;
}
/* Algorithm 2.B (R6) / SHA-256 sederhana (R5) */
async function hash6(pw, salt, udata, R) {
  let K = await sha('SHA-256', cat(pw, salt, udata));
  if (R === 5) return K;
  let E, i = 0;
  for (; ;) {
    const unit = cat(pw, K, udata);
    const K1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) K1.set(unit, j * unit.length);
    E = await aesEncNoPad(K.subarray(0, 16), K.subarray(16, 32), K1);
    let sum = 0; for (let j = 0; j < 16; j++) sum += E[j];
    K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], E);
    i++;
    if (i >= 64 && E[E.length - 1] <= i - 32) break;
  }
  return K.subarray(0, 32);
}
async function fileKeyV5(pw, e) {
  const p = utf8(pw);
  const U = e.U, O = e.O;
  if (eq(await hash6(p, U.subarray(32, 40), new Uint8Array(0), e.R), U, 32)) {
    const ik = await hash6(p, U.subarray(40, 48), new Uint8Array(0), e.R);
    return aesDecRaw(ik, new Uint8Array(16), e.UE.subarray(0, 32));
  }
  const u48 = U.subarray(0, 48);
  if (eq(await hash6(p, O.subarray(32, 40), u48, e.R), O, 32)) {
    const ik = await hash6(p, O.subarray(40, 48), u48, e.R);
    return aesDecRaw(ik, new Uint8Array(16), e.OE.subarray(0, 32));
  }
  return null;
}

/* ---------------- membaca kamus /Encrypt ---------------- */
const num = (d, k, def) => { const v = d.lookup(PL.PDFName.of(k)); return v instanceof PL.PDFNumber ? v.asNumber() : def; };
const bytesOf = v => (v instanceof PL.PDFString || v instanceof PL.PDFHexString) ? v.asBytes() : new Uint8Array(0);
const nameOf = v => v instanceof PL.PDFName ? v.decodeText?.() ?? v.asString().slice(1) : null;

export function readEncrypt(doc) {
  const ctx = doc.context;
  const encRef = ctx.trailerInfo.Encrypt;
  const enc = encRef && ctx.lookup(encRef);
  if (!(enc instanceof PL.PDFDict)) return null;
  const filter = nameOf(enc.lookup(PL.PDFName.of('Filter')));
  const idArr = ctx.lookup(ctx.trailerInfo.ID);
  const id0 = idArr instanceof PL.PDFArray ? bytesOf(idArr.lookup(0)) : new Uint8Array(0);
  const V = num(enc, 'V', 0), R = num(enc, 'R', 2);
  const em = enc.lookup(PL.PDFName.of('EncryptMetadata'));
  const e = {
    encRef, filter, V, R, id0,
    P: num(enc, 'P', -1) | 0,
    O: bytesOf(enc.lookup(PL.PDFName.of('O'))), U: bytesOf(enc.lookup(PL.PDFName.of('U'))),
    OE: bytesOf(enc.lookup(PL.PDFName.of('OE'))), UE: bytesOf(enc.lookup(PL.PDFName.of('UE'))),
    encryptMetadata: !(em instanceof PL.PDFBool) || em.asBoolean(),
    keyLen: V === 1 ? 5 : Math.max(5, Math.min(16, (num(enc, 'Length', 40) || 40) / 8)),
    stm: 'rc4', str: 'rc4',
  };
  if (V >= 4) {
    const cf = enc.lookup(PL.PDFName.of('CF'));
    const method = fname => {
      if (!fname || fname === 'Identity') return 'none';
      const f = cf instanceof PL.PDFDict ? cf.lookup(PL.PDFName.of(fname)) : null;
      const cfm = f instanceof PL.PDFDict ? nameOf(f.lookup(PL.PDFName.of('CFM'))) : null;
      if (f instanceof PL.PDFDict) { const L = num(f, 'Length', 0); if (L && V === 4) e.keyLen = L > 32 ? L / 8 : L; }
      return cfm === 'AESV2' ? 'aes' : cfm === 'AESV3' ? 'aes256' : cfm === 'None' ? 'none' : 'rc4';
    };
    e.stm = method(nameOf(enc.lookup(PL.PDFName.of('StmF'))) || 'Identity');
    e.str = method(nameOf(enc.lookup(PL.PDFName.of('StrF'))) || 'Identity');
    e.keyLen = Math.min(16, Math.max(5, e.keyLen || 16));
  }
  return e;
}

/* Hitung kunci file dari kata sandi (pengguna atau pemilik). null = salah / tidak didukung */
export async function computeFileKey(e, password = '') {
  if (e.filter !== 'Standard') return null;
  if (e.R >= 5) return fileKeyV5(password, e);
  let key = alg2(padPw(password), e);
  if (checkUser(key, e)) return key;
  key = alg2(ownerToUserPw(password, e), e);
  if (checkUser(key, e)) return key;
  return null;
}

function objKey(fileKey, e, method, num, gen) {
  if (method === 'aes256') return fileKey;
  const salt = method === 'aes' ? new Uint8Array([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0);
  const b = new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  return md5(cat(fileKey, b, salt)).subarray(0, Math.min(fileKey.length + 5, 16));
}
async function dec(method, key, data) {
  if (method === 'none') return data;
  if (method === 'rc4') return rc4(key, data);
  return aesDecrypt(key, data);
}

/* ---------------- hook pdf-lib ---------------- */
// Object stream terenkripsi harus didekripsi sebelum diurai — pasang kait sekali.
const HOOK = { mode: null, lastRef: null, fileKey: null, e: null, objStmRefs: null };
let hooked = false;
function installHooks() {
  if (hooked) return; hooked = true;
  const PP = PL.PDFParser.prototype;
  const origHdr = PP.parseIndirectObjectHeader;
  PP.parseIndirectObjectHeader = function () { const r = origHdr.call(this); HOOK.lastRef = r; return r; };
  const OSP = PL.PDFObjectStreamParser, origFor = OSP.forStream;
  OSP.forStream = function (raw, tick) {
    if (!HOOK.mode) return origFor.call(this, raw, tick);
    if (HOOK.mode === 'skip') return { parseIntoContext: async () => { } };
    const ref = HOOK.lastRef, h = { ...HOOK };
    return {
      parseIntoContext: async () => {
        try {
          const k = objKey(h.fileKey, h.e, h.e.stm, ref.objectNumber, ref.generationNumber);
          raw.contents = await dec(h.e.stm, k, raw.contents);
          const parser = origFor.call(OSP, raw, tick);
          const ctx = raw.dict.context, assign = ctx.assign;
          ctx.assign = (r, o) => { h.objStmRefs.add(r); return assign.call(ctx, r, o); };
          try { await parser.parseIntoContext(); } finally { ctx.assign = assign; }
        } catch (err) { console.warn('ObjStm', err); }
      },
    };
  };
}
let lock = Promise.resolve();
const withLock = fn => { const p = lock.then(fn, fn); lock = p.catch(() => { }); return p; };

async function decryptStrings(obj, key, method) {
  if (obj instanceof PL.PDFDict) {
    for (const [k, v] of obj.entries()) {
      if (v instanceof PL.PDFString || v instanceof PL.PDFHexString) obj.set(k, hexStr(await dec(method, key, v.asBytes())));
      else if (v instanceof PL.PDFDict || v instanceof PL.PDFArray) await decryptStrings(v, key, method);
    }
  } else if (obj instanceof PL.PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      if (v instanceof PL.PDFString || v instanceof PL.PDFHexString) obj.set(i, hexStr(await dec(method, key, v.asBytes())));
      else if (v instanceof PL.PDFDict || v instanceof PL.PDFArray) await decryptStrings(v, key, method);
    }
  }
}
const hexStr = b => PL.PDFHexString.of(Array.from(b, x => x.toString(16).padStart(2, '0')).join(''));

/**
 * Muat PDF dengan pdf-lib; bila terenkripsi, dekripsi seluruhnya.
 * @returns {Promise<{doc, decrypted:boolean}>} — melempar error bila tak bisa didekripsi.
 */
export async function loadPdfLib(bytes, password = '', opts = {}) {
  try { return { doc: await PL.PDFDocument.load(bytes, { updateMetadata: false, ...opts }), decrypted: false }; }
  catch (err) { if (!/encrypt/i.test(String(err?.message || err))) throw err; }
  if (!subtle) throw new Error('Dekripsi memerlukan koneksi aman (https atau aplikasi terpasang)');
  installHooks();
  return withLock(async () => {
    // tahap 1: ambil kamus Encrypt & ID (object stream dilewati)
    HOOK.mode = 'skip';
    let probe;
    try { probe = await PL.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, objectsPerTick: Infinity }); }
    finally { HOOK.mode = null; }
    const e = readEncrypt(probe);
    if (!e) throw new Error('Kamus enkripsi tidak terbaca');
    if (e.filter !== 'Standard') throw new Error('Jenis enkripsi tidak didukung (' + e.filter + ')');
    const fileKey = await computeFileKey(e, password || '');
    if (!fileKey) throw new Error('Kata sandi PDF tidak cocok');
    // tahap 2: muat ulang dengan object stream didekripsi
    const objStmRefs = new Set();
    Object.assign(HOOK, { mode: 'decrypt', fileKey, e, objStmRefs });
    let doc;
    try { doc = await PL.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, objectsPerTick: Infinity }); }
    finally { HOOK.mode = null; HOOK.fileKey = null; }
    const ctx = doc.context;
    const encNum = e.encRef?.objectNumber;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref.objectNumber === encNum || objStmRefs.has(ref)) continue;
      const kStr = objKey(fileKey, e, e.str, ref.objectNumber, ref.generationNumber);
      if (obj instanceof PL.PDFRawStream) {
        const type = nameOf(obj.dict.lookup(PL.PDFName.of('Type')));
        if (type === 'XRef') continue;
        const skip = type === 'Metadata' && !e.encryptMetadata;
        if (!skip) {
          const kStm = objKey(fileKey, e, e.stm, ref.objectNumber, ref.generationNumber);
          try { obj.contents = await dec(e.stm, kStm, obj.contents); } catch (er) { console.warn('stream', ref.toString(), er); }
        }
        await decryptStrings(obj.dict, kStr, e.str);
      } else if (obj instanceof PL.PDFDict || obj instanceof PL.PDFArray) {
        await decryptStrings(obj, kStr, e.str);
      } else if (obj instanceof PL.PDFString || obj instanceof PL.PDFHexString) {
        ctx.assign(ref, hexStr(await dec(e.str, kStr, obj.asBytes())));
      }
    }
    if (e.encRef) ctx.delete(e.encRef);
    ctx.trailerInfo.Encrypt = undefined;
    return { doc, decrypted: true };
  });
}

/* =====================================================================
   ENKRIPSI (AES-256, R6 — standar PDF 2.0, didukung Acrobat & semua pembaca modern)
   Panggil SETELAH doc.flush() dan simpan dengan { useObjectStreams: false }.
   ===================================================================== */
const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
async function aesEncPkcs(key, data) {
  const iv = rand(16);
  return cat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, await aesKey(key), data)));
}
async function encryptStrings(obj, key) {
  const items = obj instanceof PL.PDFDict ? obj.entries() : obj instanceof PL.PDFArray ? obj.asArray().map((v, i) => [i, v]) : [];
  for (const [k, v] of items) {
    if (v instanceof PL.PDFString || v instanceof PL.PDFHexString) obj.set(k, hexStr(await aesEncPkcs(key, v.asBytes())));
    else if (v instanceof PL.PDFDict || v instanceof PL.PDFArray) await encryptStrings(v, key);
  }
}
/** Bit izin PDF (Tabel 22): print, modify, copy, annotate */
export function permissionBits({ print = true, modify = true, copy = true, annotate = true } = {}) {
  let P = ~0xFFF | 0xC0; // bit 7–8 wajib 1, bit 13–32 = 1
  if (print) P |= 4 | 2048;
  if (modify) P |= 8 | 1024;
  if (copy) P |= 16 | 512;
  if (annotate) P |= 32 | 256;
  return P | 0;
}
export async function encryptPdfDoc(doc, { userPassword = '', ownerPassword = '', permissions } = {}) {
  if (!subtle) throw new Error('Enkripsi memerlukan koneksi aman (https atau aplikasi terpasang)');
  const ctx = doc.context;
  const fileKey = rand(32);
  const up = utf8(userPassword);
  const op = utf8(ownerPassword || userPassword || Array.from(rand(16), b => b.toString(16)).join(''));
  const empty = new Uint8Array(0), zero = new Uint8Array(16);
  const uvs = rand(8), uks = rand(8);
  const U = cat(await hash6(up, uvs, empty, 6), uvs, uks);
  const UE = await aesEncNoPad(await hash6(up, uks, empty, 6), zero, fileKey);
  const ovs = rand(8), oks = rand(8);
  const O = cat(await hash6(op, ovs, U, 6), ovs, oks);
  const OE = await aesEncNoPad(await hash6(op, oks, U, 6), zero, fileKey);
  const P = permissionBits(permissions);
  const perms = new Uint8Array(16); const pv = new DataView(perms.buffer);
  pv.setInt32(0, P, true); pv.setUint32(4, 0xFFFFFFFF); perms.set([84, 97, 100, 98], 8); perms.set(rand(4), 12);
  const Perms = await aesEncNoPad(fileKey, zero, perms);
  for (const [ref, obj] of [...ctx.enumerateIndirectObjects()]) {
    if (obj instanceof PL.PDFStream) {
      if (nameOf(obj.dict.lookup(PL.PDFName.of('Type'))) === 'XRef') continue;
      const contents = obj instanceof PL.PDFRawStream ? obj.contents : obj.getContents();
      await encryptStrings(obj.dict, fileKey);
      ctx.assign(ref, PL.PDFRawStream.of(obj.dict, await aesEncPkcs(fileKey, contents)));
    } else if (obj instanceof PL.PDFDict || obj instanceof PL.PDFArray) await encryptStrings(obj, fileKey);
    else if (obj instanceof PL.PDFString || obj instanceof PL.PDFHexString) ctx.assign(ref, hexStr(await aesEncPkcs(fileKey, obj.asBytes())));
  }
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256,
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF',
    O: hexStr(O), U: hexStr(U), OE: hexStr(OE), UE: hexStr(UE), P, Perms: hexStr(Perms), EncryptMetadata: true,
  }));
  if (!ctx.trailerInfo.ID) { const id = hexStr(rand(16)); ctx.trailerInfo.ID = ctx.obj([id, id]); }
}
