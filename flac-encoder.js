// flac-encoder.js
// Encoder FLAC / Ogg FLAC / WAV en JavaScript puro (sin dependencias). 100% lossless.
// - Predictores fijos (orden 0-4) + Rice con particiones
// - Decorrelación estéreo adaptativa (L/R, L/S, S/R, M/S)
// - Subframes constantes (silencio) y verbatim como respaldo

const log = (...a) => console.log('[FLAC]', ...a);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------ CRC ------------------------------ */
const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();
const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();
const OGGCRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crc8(b, len) { let c = 0; for (let i = 0; i < len; i++) c = CRC8[c ^ b[i]]; return c; }
function crc16(b, len) { let c = 0; for (let i = 0; i < len; i++) c = ((c << 8) & 0xffff) ^ CRC16[((c >> 8) ^ b[i]) & 0xff]; return c; }
function oggCrc(b) { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ OGGCRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0; return c; }

/* ---------------------------- BitWriter ---------------------------- */
class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.n = 0; }
  _put(v, n) {
    if (this.pos + 4 > this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.acc = (this.acc << n) | v;
    this.n += n;
    while (this.n >= 8) { this.n -= 8; this.buf[this.pos++] = (this.acc >>> this.n) & 0xff; }
    this.acc &= (1 << this.n) - 1;
  }
  write(v, n) {
    if (n > 16) { const lo = v % 65536; this.write((v - lo) / 65536, n - 16); this._put(lo, 16); }
    else if (n > 0) this._put(v, n);
  }
  writeSigned(v, n) { this.write(v < 0 ? v + 2 ** n : v, n); }
  unary(q) { while (q >= 16) { this._put(0, 16); q -= 16; } this._put(1, q + 1); }
  align() { if (this.n) this._put(0, 8 - this.n); }
  bytes() { return this.buf.subarray(0, this.pos); }
}

function writeUtf8(w, v) {
  if (v < 0x80) return w.write(v, 8);
  const nb = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  w.write(((0xff00 >> nb) & 0xff) | Math.floor(v / 2 ** (6 * (nb - 1))), 8);
  for (let i = nb - 2; i >= 0; i--) w.write(0x80 | (Math.floor(v / 2 ** (6 * i)) & 0x3f), 8);
}

/* ------------------------- Float -> entero ------------------------- */
export function toInt(ch, bps, gain, dither) {
  const scale = 2 ** (bps - 1), max = scale - 1, min = -scale;
  const out = new Int32Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    let v = ch[i] * gain * scale;
    if (dither) v += Math.random() - Math.random(); // TPDF
    v = Math.round(v);
    out[i] = v > max ? max : v < min ? min : v;
  }
  return out;
}

/* --------------------------- Subframes ---------------------------- */
const makeScratch = (bs) => ({
  r: [0, 1, 2, 3, 4].map(() => new Int32Array(bs)),
  mid: new Int32Array(bs),
  side: new Int32Array(bs),
});

function pickOrder(x, n, scr) {
  const r = scr.r;
  r[0].set(x);
  for (let o = 1; o <= 4; o++) { const a = r[o - 1], b = r[o]; for (let i = o; i < n; i++) b[i] = a[i] - a[i - 1]; }
  if (n < 5) { let s = 0; for (let i = 0; i < n; i++) s += Math.abs(r[0][i]); return { order: 0, cost: s }; }
  let best = 0, bc = Infinity;
  for (let o = 0; o <= 4; o++) {
    let s = 0; const a = r[o];
    for (let i = 4; i < n; i++) s += a[i] < 0 ? -a[i] : a[i];
    if (s < bc) { bc = s; best = o; }
  }
  return { order: best, cost: bc };
}

const fold = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
const riceBits = (sum, cnt, k) => cnt * (k + 1) + Math.floor(sum / 2 ** k);
function riceK(sum, cnt) {
  if (cnt <= 0 || sum <= 0) return 0;
  const mean = sum / cnt;
  const k = mean < 1 ? 0 : Math.min(30, Math.floor(Math.log2(mean)));
  let bk = k, bb = Infinity;
  for (let c = Math.max(0, k - 1); c <= Math.min(30, k + 1); c++) {
    const b = riceBits(sum, cnt, c);
    if (b < bb) { bb = b; bk = c; }
  }
  return bk;
}

function encodeSubframe(w, x, n, bps, scr) {
  // Constante (silencio)
  const f = x[0]; let isConst = true;
  for (let i = 1; i < n; i++) if (x[i] !== f) { isConst = false; break; }
  if (isConst) { w.write(0, 1); w.write(0, 6); w.write(0, 1); w.writeSigned(f, bps); return; }

  const { order } = pickOrder(x, n, scr);
  const res = scr.r[order];

  let maxPo = 0;
  for (let po = 6; po >= 0; po--) if (n % (1 << po) === 0 && (n >> po) > order) { maxPo = po; break; }
  const parts = 1 << maxPo, size = n >> maxPo;
  let cs = new Float64Array(parts), cc = new Float64Array(parts);
  for (let j = 0; j < parts; j++) {
    const b = j * size + (j === 0 ? order : 0), e = (j + 1) * size; let s = 0;
    for (let i = b; i < e; i++) s += fold(res[i]);
    cs[j] = s; cc[j] = e - b;
  }
  let bestPo = maxPo, bestBits = Infinity;
  for (let po = maxPo; po >= 0; po--) {
    let bits = 0;
    for (let j = 0; j < cs.length; j++) bits += 5 + riceBits(cs[j], cc[j], riceK(cs[j], cc[j]));
    if (bits < bestBits) { bestBits = bits; bestPo = po; }
    if (po > 0) {
      const ns = new Float64Array(cs.length / 2), nc = new Float64Array(cs.length / 2);
      for (let j = 0; j < ns.length; j++) { ns[j] = cs[2 * j] + cs[2 * j + 1]; nc[j] = cc[2 * j] + cc[2 * j + 1]; }
      cs = ns; cc = nc;
    }
  }

  if (order * bps + 6 + bestBits >= n * bps) { // verbatim
    w.write(0, 1); w.write(1, 6); w.write(0, 1);
    for (let i = 0; i < n; i++) w.writeSigned(x[i], bps);
    return;
  }

  w.write(0, 1); w.write(8 + order, 6); w.write(0, 1);
  for (let i = 0; i < order; i++) w.writeSigned(x[i], bps);
  w.write(1, 2); w.write(bestPo, 4); // Rice con parámetro de 5 bits
  const P = 1 << bestPo, sz = n >> bestPo;
  for (let j = 0; j < P; j++) {
    const b = j * sz + (j === 0 ? order : 0), e = (j + 1) * sz; let s = 0;
    for (let i = b; i < e; i++) s += fold(res[i]);
    const k = riceK(s, e - b), pk = 2 ** k;
    w.write(k, 5);
    for (let i = b; i < e; i++) {
      const u = fold(res[i]), q = Math.floor(u / pk);
      w.unary(q);
      if (k) w.write(u - q * pk, k);
    }
  }
}

const BS_CODE = { 192: 1, 256: 8, 512: 9, 1024: 10, 2048: 11, 4096: 12, 8192: 13 };
const BPS_CODE = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 };

function encodeFrame(ints, start, n, frameNum, bps, scr) {
  const nch = ints.length;
  const blocks = ints.map((c) => c.subarray(start, start + n));
  let assign = nch - 1, subs = blocks, bpss = blocks.map(() => bps);

  if (nch === 2) {
    const L = blocks[0], R = blocks[1], M = scr.mid.subarray(0, n), S = scr.side.subarray(0, n);
    for (let i = 0; i < n; i++) { M[i] = (L[i] + R[i]) >> 1; S[i] = L[i] - R[i]; }
    const cL = pickOrder(L, n, scr).cost, cR = pickOrder(R, n, scr).cost;
    const cM = pickOrder(M, n, scr).cost, cS = pickOrder(S, n, scr).cost;
    const opts = [[cL + cR, 1], [cL + cS, 8], [cS + cR, 9], [cM + cS, 10]];
    opts.sort((a, b) => a[0] - b[0]);
    assign = opts[0][1];
    if (assign === 1) { subs = [L, R]; bpss = [bps, bps]; }
    else if (assign === 8) { subs = [L, S]; bpss = [bps, bps + 1]; }
    else if (assign === 9) { subs = [S, R]; bpss = [bps + 1, bps]; }
    else { subs = [M, S]; bpss = [bps, bps + 1]; }
  }

  const w = new BitWriter(n * nch * 4 + 1024);
  const bsc = BS_CODE[n] || 7;
  w.write(0x3ffe, 14); w.write(0, 1); w.write(0, 1);
  w.write(bsc, 4); w.write(0, 4); w.write(assign, 4); w.write(BPS_CODE[bps], 3); w.write(0, 1);
  writeUtf8(w, frameNum);
  if (bsc === 7) w.write(n - 1, 16);
  w.write(crc8(w.buf, w.pos), 8);

  for (let c = 0; c < subs.length; c++) encodeSubframe(w, subs[c], n, bpss[c], scr);
  w.align();
  w.write(crc16(w.buf, w.pos), 16);
  return w.bytes().slice();
}

/* ----------------------------- Metadata ---------------------------- */
function streamInfo(bs, minF, maxF, sr, nch, bps, total) {
  const b = new Uint8Array(34), dv = new DataView(b.buffer);
  dv.setUint16(0, bs); dv.setUint16(2, bs);
  b[4] = (minF >> 16) & 255; b[5] = (minF >> 8) & 255; b[6] = minF & 255;
  b[7] = (maxF >> 16) & 255; b[8] = (maxF >> 8) & 255; b[9] = maxF & 255;
  b[10] = sr >> 12; b[11] = (sr >> 4) & 255;
  b[12] = ((sr & 15) << 4) | ((nch - 1) << 1) | ((bps - 1) >> 4);
  b[13] = (((bps - 1) & 15) << 4) | (Math.floor(total / 2 ** 32) & 15);
  dv.setUint32(14, total % 2 ** 32);
  return b; // MD5 = 0 (no establecido)
}
function vorbisComment(vendor, tags) {
  const enc = new TextEncoder(), v = enc.encode(vendor);
  const items = Object.entries(tags).map(([k, val]) => enc.encode(`${k}=${val}`));
  const out = new Uint8Array(8 + v.length + items.reduce((a, b) => a + 4 + b.length, 0));
  const dv = new DataView(out.buffer); let p = 0;
  dv.setUint32(p, v.length, true); p += 4; out.set(v, p); p += v.length;
  dv.setUint32(p, items.length, true); p += 4;
  for (const it of items) { dv.setUint32(p, it.length, true); p += 4; out.set(it, p); p += it.length; }
  return out;
}
const blockHeader = (type, last, len) => new Uint8Array([(last ? 0x80 : 0) | type, (len >> 16) & 255, (len >> 8) & 255, len & 255]);
const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

function oggPage(packet, type, granule, serial, seq) {
  const segs = []; let rem = packet.length;
  while (rem >= 255) { segs.push(255); rem -= 255; }
  segs.push(rem);
  if (segs.length > 255) throw new Error('Paquete Ogg demasiado grande');
  const page = new Uint8Array(27 + segs.length + packet.length), dv = new DataView(page.buffer);
  page.set(ascii('OggS'), 0); page[4] = 0; page[5] = type;
  dv.setUint32(6, granule % 2 ** 32, true); dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  dv.setUint32(14, serial, true); dv.setUint32(18, seq, true);
  page[26] = segs.length; page.set(segs, 27); page.set(packet, 27 + segs.length);
  dv.setUint32(22, oggCrc(page), true);
  return page;
}
const concat = (arrs) => { const o = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0)); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };

/* ------------------------------ API ------------------------------- */
/**
 * @param {Float32Array[]} channels  datos por canal (-1..1)
 * @param {number} sampleRate
 * @param {16|24} bps
 * @param {{ogg?:boolean, gain?:number, dither?:boolean, onProgress?:(f:number)=>void, tags?:object}} opts
 * @returns {Promise<Blob>}
 */
export async function encodeFlac(channels, sampleRate, bps = 24, opts = {}) {
  const { ogg = false, gain = 1, dither = bps === 16, onProgress, tags = {} } = opts;
  const nch = channels.length, total = channels[0].length;
  const bs = opts.blockSize || (nch > 2 ? 2048 : 4096);
  const t0 = performance.now();
  log(`Codificando ${ogg ? 'Ogg FLAC' : 'FLAC'}: ${nch}ch, ${sampleRate} Hz, ${bps} bit, ${total} muestras, bloque ${bs}`);

  const ints = channels.map((c) => toInt(c, bps, gain, dither));
  const scr = makeScratch(bs);
  const frames = []; let minF = Infinity, maxF = 0, fn = 0;
  for (let pos = 0; pos < total; pos += bs, fn++) {
    const n = Math.min(bs, total - pos);
    const data = encodeFrame(ints, pos, n, fn, bps, scr);
    frames.push({ data, end: pos + n });
    if (data.length < minF) minF = data.length;
    if (data.length > maxF) maxF = data.length;
    if (fn % 32 === 0) { onProgress && onProgress(pos / total); await tick(); }
  }
  if (!frames.length) minF = 0;
  onProgress && onProgress(1);

  const si = streamInfo(Math.min(bs, total) || bs, minF, maxF, sampleRate, nch, bps, total);
  const comment = vorbisComment('Pitch & EQ Studio (FLAC JS)', { ENCODER: 'Pitch & EQ Studio', ...tags });
  const cHead = blockHeader(4, true, comment.length);
  let blob;
  if (!ogg) {
    blob = new Blob([ascii('fLaC'), blockHeader(0, false, 34), si, cHead, comment, ...frames.map((f) => f.data)], { type: 'audio/flac' });
  } else {
    const serial = (Math.random() * 2 ** 32) >>> 0; let seq = 0;
    const first = concat([new Uint8Array([0x7f]), ascii('FLAC'), new Uint8Array([1, 0, 0, 1]), ascii('fLaC'), blockHeader(0, false, 34), si]);
    const pages = [oggPage(first, 0x02, 0, serial, seq++), oggPage(concat([cHead, comment]), 0x00, 0, serial, seq++)];
    frames.forEach((f, i) => pages.push(oggPage(f.data, i === frames.length - 1 ? 0x04 : 0x00, f.end, serial, seq++)));
    blob = new Blob(pages, { type: 'audio/ogg' });
  }
  log(`Listo en ${((performance.now() - t0) / 1000).toFixed(2)} s → ${(blob.size / 1048576).toFixed(2)} MB`);
  return blob;
}

/** WAV PCM (16 o 24 bit) sin compresión. */
export function encodeWav(channels, sampleRate, bps = 24, opts = {}) {
  const { gain = 1, dither = bps === 16 } = opts;
  const nch = channels.length, n = channels[0].length, bytes = bps / 8;
  const ints = channels.map((c) => toInt(c, bps, gain, dither));
  const dataLen = n * nch * bytes, buf = new ArrayBuffer(44 + dataLen), dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nch * bytes, true);
  dv.setUint16(32, nch * bytes, true); dv.setUint16(34, bps, true); str(36, 'data'); dv.setUint32(40, dataLen, true);
  let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    const v = ints[c][i];
    if (bps === 16) { dv.setInt16(p, v, true); p += 2; }
    else { dv.setUint8(p, v & 255); dv.setUint8(p + 1, (v >> 8) & 255); dv.setUint8(p + 2, (v >> 16) & 255); p += 3; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
