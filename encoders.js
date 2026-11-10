// encoders.js — formatos extra: AIFF, WAV float32, MP3 (lamejs) y Opus/AAC vía MediaRecorder
import { toInt } from './flac-encoder.js';
const log = (...a) => console.log('[ENC]', ...a);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------- AIFF ------------------------------- */
function ext80(v) { // Float 80-bit IEEE extendido (big endian) para enteros
  const e = Math.floor(Math.log2(v)), mant = BigInt(v) << BigInt(63 - e), out = new Uint8Array(10), dv = new DataView(out.buffer);
  dv.setUint16(0, 16383 + e); dv.setUint32(2, Number(mant >> 32n)); dv.setUint32(6, Number(mant & 0xffffffffn));
  return out;
}
export function encodeAiff(channels, sr, bps = 24, { gain = 1, dither = bps === 16 } = {}) {
  const nch = channels.length, n = channels[0].length, bytes = bps / 8;
  const ints = channels.map((c) => toInt(c, bps, gain, dither));
  const dataLen = n * nch * bytes, pad = dataLen & 1;
  const buf = new ArrayBuffer(12 + 26 + 16 + dataLen + pad), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, s) => [...s].forEach((c, i) => (u8[o + i] = c.charCodeAt(0)));
  str(0, 'FORM'); dv.setUint32(4, buf.byteLength - 8); str(8, 'AIFF');
  str(12, 'COMM'); dv.setUint32(16, 18); dv.setUint16(20, nch); dv.setUint32(22, n); dv.setUint16(26, bps); u8.set(ext80(sr), 28);
  str(38, 'SSND'); dv.setUint32(42, 8 + dataLen); dv.setUint32(46, 0); dv.setUint32(50, 0);
  let p = 54;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    const v = ints[c][i];
    if (bps === 16) { dv.setInt16(p, v); p += 2; } else { u8[p++] = (v >> 16) & 255; u8[p++] = (v >> 8) & 255; u8[p++] = v & 255; }
  }
  return new Blob([buf], { type: 'audio/aiff' });
}

/* --------------------------- WAV float 32 bit --------------------------- */
export function encodeWavFloat(channels, sr, { gain = 1 } = {}) {
  const nch = channels.length, n = channels[0].length, dataLen = n * nch * 4;
  const buf = new ArrayBuffer(44 + dataLen), dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nch * 4, true); dv.setUint16(32, nch * 4, true); dv.setUint16(34, 32, true);
  str(36, 'data'); dv.setUint32(40, dataLen, true);
  let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { dv.setFloat32(p, channels[c][i] * gain, true); p += 4; }
  return new Blob([buf], { type: 'audio/wav' });
}

/* --------------------------------- MP3 --------------------------------- */
function loadLame() {
  if (globalThis.lamejs && globalThis.lamejs.Mp3Encoder) return Promise.resolve(globalThis.lamejs);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/lame.min.js', import.meta.url).href;
    s.onload = () => res(globalThis.lamejs); s.onerror = () => rej(new Error('No se pudo cargar lame.min.js'));
    document.head.appendChild(s);
  });
}
export const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export async function encodeMp3(channels, sr, kbps = 320, { gain = 1, onProgress } = {}) {
  const lame = await loadLame();
  const nch = Math.min(2, channels.length);
  const pcm = channels.slice(0, nch).map((c) => toInt(c, 16, gain, true)).map((i) => Int16Array.from(i));
  const enc = new lame.Mp3Encoder(nch, sr, kbps), out = [], step = 1152 * 16, n = pcm[0].length;
  log(`MP3 ${nch}ch ${sr} Hz ${kbps} kbps`);
  for (let i = 0; i < n; i += step) {
    const b = enc.encodeBuffer(pcm[0].subarray(i, i + step), nch === 2 ? pcm[1].subarray(i, i + step) : undefined);
    if (b.length) out.push(new Uint8Array(b));
    if ((i / step) % 24 === 0) { onProgress && onProgress(i / n); await tick(); }
  }
  const f = enc.flush(); if (f.length) out.push(new Uint8Array(f));
  onProgress && onProgress(1);
  return new Blob(out, { type: 'audio/mpeg' });
}

/* ------------------- Opus / AAC con MediaRecorder (tiempo real) ------------------- */
const REC = [
  ['audio/webm;codecs=opus', 'Opus (.webm)', 'webm'],
  ['audio/ogg;codecs=opus', 'Opus (.ogg)', 'ogg'],
  ['audio/mp4;codecs=mp4a.40.2', 'AAC (.m4a)', 'm4a'],
];
export function recorderFormats() {
  if (typeof MediaRecorder === 'undefined') return [];
  return REC.filter(([m]) => MediaRecorder.isTypeSupported(m)).map(([mime, label, ext]) => ({ mime, label, ext }));
}
export function recordCompressed(buffer, mime, kbps, onProgress) {
  return new Promise((resolve, reject) => {
    let ctx;
    try { ctx = new AudioContext({ sampleRate: buffer.sampleRate }); } catch (_) { ctx = new AudioContext(); }
    const dest = ctx.createMediaStreamDestination(), src = ctx.createBufferSource();
    src.buffer = buffer; src.connect(dest);
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: kbps * 1000 }), chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => { clearInterval(t); ctx.close(); resolve(new Blob(chunks, { type: mime.split(';')[0] })); };
    rec.onerror = (e) => { clearInterval(t); reject(e.error || new Error('MediaRecorder falló')); };
    src.onended = () => setTimeout(() => rec.stop(), 300);
    const t0 = ctx.currentTime; let t;
    rec.start(250); src.start();
    t = setInterval(() => onProgress && onProgress(Math.min(1, (ctx.currentTime - t0) / buffer.duration)), 200);
  });
}
