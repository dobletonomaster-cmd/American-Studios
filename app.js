// app.js — Chipeo Presión V2 · Pitch & EQ Studio
import { encodeFlac, encodeWav } from './flac-encoder.js';
import { encodeAiff, encodeWavFloat, encodeMp3, MP3_RATES, recorderFormats, recordCompressed } from './encoders.js';

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const Q = 1.41;
const PRESETS = {
  'Plano': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Presión (SPL)': [9, 8, 5, 1, -1, -1, 0, 1, 2, 2],
  'Graves + agudos': [5, 4, 2, 0, -2, -2, 0, 2, 4, 5],
  'Vocal': [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  'Rock': [5, 4, 2, -1, -2, -1, 2, 4, 5, 5],
  'Electrónica': [6, 5, 2, 0, -2, 2, 1, 2, 5, 6],
  'Agudos': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Sin graves': [-12, -9, -6, -3, 0, 0, 0, 0, 0, 0],
};
const SPEED_PRESETS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];
const WORDS = ['Velocidad', 'Tono', 'Ecualizador', 'Lossless', 'Presión'];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const log = (...a) => console.log('[Studio]', ...a);
const dbToGain = (db) => Math.pow(10, db / 20);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const S = {
  ctx: null, buffer: null, source: null, filters: null, preGain: null, analyser: null,
  rate: 1, gains: Array(10).fill(0), pre: 0, bass: 0,
  playing: false, offset: 0, startedAt: 0, loop: false, seeking: false, fileName: '',
  curveFilters: null, rec: [],
};

function say(msg) {
  log(msg);
  const el = $('log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}
const setPct = (el) => el.style.setProperty('--pct', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);

/* ------------------------------ Audio graph ------------------------------ */
function makeFilter(ctx, i, gain = S.gains[i]) {
  const f = ctx.createBiquadFilter();
  f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
  f.frequency.value = BANDS[i];
  f.Q.value = Q;
  f.gain.value = gain;
  return f;
}

function buildGraph() {
  const ctx = S.ctx;
  S.filters = BANDS.map((_, i) => makeFilter(ctx, i));
  S.preGain = ctx.createGain();
  S.preGain.gain.value = dbToGain(S.pre);
  S.analyser = ctx.createAnalyser();
  S.analyser.fftSize = 4096;
  S.analyser.smoothingTimeConstant = 0.78;
  S.filters.reduce((a, b) => (a.connect(b), b));
  S.filters[S.filters.length - 1].connect(S.preGain);
  S.preGain.connect(S.analyser);
  S.analyser.connect(ctx.destination);
  log(`Grafo de audio listo @ ${ctx.sampleRate} Hz`);
}

async function ensureContext(sr) {
  if (S.ctx && (!sr || S.ctx.sampleRate === sr)) return;
  stopSource();
  S.playing = false;
  if (S.ctx) await S.ctx.close();
  try {
    S.ctx = new AudioContext(sr ? { sampleRate: sr, latencyHint: 'playback' } : { latencyHint: 'playback' });
  } catch (e) {
    log('sampleRate no soportado, usando el del sistema', e.message);
    S.ctx = new AudioContext();
  }
  buildGraph();
}

// Sample rate nativo de WAV/FLAC para decodificar sin remuestrear
function sniffRate(ab) {
  const u = new Uint8Array(ab, 0, Math.min(ab.byteLength, 64));
  const t = (o, n) => String.fromCharCode(...u.subarray(o, o + n));
  if (t(0, 4) === 'RIFF' && t(8, 4) === 'WAVE' && t(12, 4) === 'fmt ') return u[24] | (u[25] << 8) | (u[26] << 16) | (u[27] << 24);
  if (t(0, 4) === 'fLaC' && ab.byteLength > 21) return (u[18] << 12) | (u[19] << 4) | (u[20] >> 4);
  return 0;
}

/* -------------------------------- Playback -------------------------------- */
function position() {
  if (!S.buffer) return 0;
  if (!S.playing) return S.offset;
  let p = S.offset + (S.ctx.currentTime - S.startedAt) * S.rate;
  if (S.loop) p %= S.buffer.duration;
  return Math.min(p, S.buffer.duration);
}

function stopSource() {
  if (!S.source) return;
  S.source.onended = null;
  try { S.source.stop(); } catch (_) { /* ya detenido */ }
  S.source.disconnect();
  S.source = null;
}

function play() {
  if (!S.buffer) return;
  S.ctx.resume();
  stopSource();
  if (S.offset >= S.buffer.duration - 0.01) S.offset = 0;
  const src = S.ctx.createBufferSource();
  src.buffer = S.buffer;
  src.loop = S.loop;
  src.playbackRate.value = S.rate;
  src.connect(S.filters[0]);
  src.onended = () => { if (S.source !== src) return; S.source = null; S.playing = false; S.offset = 0; syncUI(); };
  src.start(0, S.offset);
  S.source = src;
  S.startedAt = S.ctx.currentTime;
  S.playing = true;
  syncUI();
}
function pause() { S.offset = position(); stopSource(); S.playing = false; syncUI(); }
function stop() { stopSource(); S.playing = false; S.offset = 0; syncUI(); }

function setRate(r) {
  r = Math.min(3, Math.max(0.25, r));
  if (S.playing) { S.offset = position(); S.startedAt = S.ctx.currentTime; }
  S.rate = r;
  if (S.source) S.source.playbackRate.setTargetAtTime(r, S.ctx.currentTime, 0.01);
  const sp = $('speed'); sp.value = r; setPct(sp);
  const st = 12 * Math.log2(r), out = $('speedOut');
  out.textContent = `${r.toFixed(2)}x`;
  out.classList.remove('bump'); void out.offsetWidth; out.classList.add('bump');
  $('pitchOut').textContent = `Tono: ${st >= 0 ? '+' : ''}${st.toFixed(2)} semitonos`;
  $('vinyl').style.animationDuration = `${(1.8 / r).toFixed(3)}s`;
  if (S.buffer) $('durOut').textContent = `Duración resultante: ${fmtTime(S.buffer.duration / r)}`;
  document.querySelectorAll('#speedPresets .chip').forEach((b) => b.classList.toggle('on', +b.dataset.r === +r.toFixed(2)));
}

function syncUI() {
  const has = !!S.buffer;
  $('play').disabled = !has; $('stop').disabled = !has; $('seek').disabled = !has; $('export').disabled = !has;
  $('play').textContent = S.playing ? '⏸ Pausa' : '▶ Reproducir';
  $('vinyl').classList.toggle('on', S.playing);
}

/* --------------------------------- Equalizer --------------------------------- */
function setGain(i, v) {
  S.gains[i] = v;
  $('db' + i).textContent = (v > 0 ? '+' : '') + v;
  if (S.filters) S.filters[i].gain.setTargetAtTime(v, S.ctx.currentTime, 0.01);
  if (S.curveFilters) S.curveFilters[i].gain.value = v;
  drawCurve();
}

function buildEQ() {
  const wrap = $('eq');
  BANDS.forEach((_, i) => {
    const col = document.createElement('div');
    col.className = 'band';
    col.innerHTML = `<span class="db" id="db${i}">0</span>
      <input type="range" min="-12" max="12" step="0.5" value="0" id="band${i}" aria-label="${LABELS[i]} Hz">
      <span class="hz">${LABELS[i]}</span>`;
    wrap.appendChild(col);
    const inp = col.querySelector('input');
    inp.addEventListener('input', () => setGain(i, +inp.value));
    inp.addEventListener('dblclick', () => { inp.value = 0; setGain(i, 0); });
  });
  const sel = $('preset');
  Object.keys(PRESETS).forEach((k) => sel.add(new Option(k, k)));
  sel.addEventListener('change', () => applyPreset(sel.value));
  $('eqReset').addEventListener('click', () => { sel.value = 'Plano'; applyPreset('Plano'); });
  // filtros solo para dibujar la curva (no necesitan audio)
  const oc = new OfflineAudioContext(1, 1, 44100);
  S.curveFilters = BANDS.map((_, i) => makeFilter(oc, i, 0));
}

function applyPreset(name) {
  PRESETS[name].forEach((v, i) => { $('band' + i).value = v; setGain(i, v); });
  log('Preset EQ:', name);
}

function drawCurve() {
  const cv = $('curve'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const N = 240, freqs = new Float32Array(N), mag = new Float32Array(N), ph = new Float32Array(N), tot = new Float32Array(N).fill(1);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  S.curveFilters.forEach((f) => { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < N; i++) tot[i] *= mag[i]; });
  const y = (db) => H / 2 - (db / 15) * (H / 2 - 8);
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1; g.fillStyle = 'rgba(200,180,255,.5)'; g.font = `${10 * (W / cv.clientWidth || 1)}px system-ui`;
  [-12, -6, 0, 6, 12].forEach((d) => { g.beginPath(); g.moveTo(0, y(d)); g.lineTo(W, y(d)); g.stroke(); g.fillText(`${d}`, 4, y(d) - 3); });
  const pts = Array.from(tot, (m, i) => [(i / (N - 1)) * W, y(20 * Math.log10(m))]);
  const path = () => { g.beginPath(); pts.forEach(([x, yy], i) => (i ? g.lineTo(x, yy) : g.moveTo(x, yy))); };
  path(); g.lineTo(W, H / 2); g.lineTo(0, H / 2); g.closePath();
  const fill = g.createLinearGradient(0, 0, 0, H); fill.addColorStop(0, 'rgba(217,70,239,.35)'); fill.addColorStop(.5, 'rgba(124,58,237,.05)'); fill.addColorStop(1, 'rgba(34,211,238,.3)');
  g.fillStyle = fill; g.fill();
  path(); g.lineWidth = 2.5 * (W / cv.clientWidth || 1); g.shadowColor = '#a855f7'; g.shadowBlur = 14;
  const stroke = g.createLinearGradient(0, 0, W, 0); stroke.addColorStop(0, '#22d3ee'); stroke.addColorStop(.5, '#a855f7'); stroke.addColorStop(1, '#d946ef');
  g.strokeStyle = stroke; g.stroke(); g.shadowBlur = 0;
}

/* ------------------------ Visuales reactivos al audio ------------------------ */
const hero = $('hero'), stage = $('stage'), logoWrap = $('logoWrap');
let freqData = null, tilt = { x: 0, y: 0, tx: 0, ty: 0 }, particles = [];

function sizeCanvases() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = $('radial'); r.width = r.height = Math.floor(stage.clientWidth * dpr);
  const c = $('curve'); c.width = Math.floor(c.clientWidth * dpr); c.height = Math.floor(120 * dpr);
  const p = $('particles'); p.width = innerWidth; p.height = innerHeight;
  drawCurve();
}

function initParticles() {
  const n = innerWidth < 640 ? 45 : 90;
  particles = Array.from({ length: n }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: Math.random() * 2 + .6, v: Math.random() * .6 + .2, h: Math.random() }));
}

function drawParticles(bass) {
  const cv = $('particles'), g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  for (const p of particles) {
    p.y -= p.v * (1 + bass * 7); p.x += Math.sin((p.y + p.h * 300) / 90) * .3;
    if (p.y < -10) { p.y = cv.height + 10; p.x = Math.random() * cv.width; }
    g.beginPath(); g.arc(p.x, p.y, p.r * (1 + bass * 1.2), 0, 7);
    g.fillStyle = p.h > .66 ? 'rgba(34,211,238,.7)' : p.h > .33 ? 'rgba(217,70,239,.7)' : 'rgba(168,85,247,.75)';
    g.shadowColor = g.fillStyle; g.shadowBlur = 10; g.fill();
  }
  g.shadowBlur = 0;
}

function drawRadial(t, level) {
  const cv = $('radial'), g = cv.getContext('2d'), W = cv.width, cx = W / 2, r0 = W * 0.405, maxL = W * 0.095;
  g.clearRect(0, 0, W, W);
  const N = 96, nyq = (S.ctx ? S.ctx.sampleRate : 44100) / 2;
  const cg = g.createConicGradient ? g.createConicGradient(t * 0.0004, cx, cx) : null;
  if (cg) { ['#22d3ee', '#a855f7', '#d946ef', '#7c3aed', '#22d3ee'].forEach((c, i) => cg.addColorStop(i / 4, c)); }
  g.strokeStyle = cg || '#a855f7'; g.lineCap = 'round'; g.lineWidth = W * 0.0065; g.shadowColor = '#a855f7'; g.shadowBlur = 12;
  g.beginPath();
  for (let i = 0; i < N; i++) {
    const k = i < N / 2 ? i : N - 1 - i;                       // espejo → simetría
    const f = 25 * Math.pow(640, k / (N / 2));                 // 25 Hz … 16 kHz
    const bin = Math.min(freqData ? freqData.length - 1 : 0, Math.floor((f / nyq) * (freqData ? freqData.length : 1)));
    const real = freqData && S.playing ? freqData[bin] / 255 : 0;
    const idle = 0.07 + 0.05 * Math.sin(t / 420 + i * 0.5);
    const v = Math.max(real, idle) * (S.playing ? 1 : 0.75);
    const a = (i / N) * Math.PI * 2 - Math.PI / 2, l = maxL * v;
    g.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * (r0 + l), cx + Math.sin(a) * (r0 + l));
  }
  g.stroke(); g.shadowBlur = 0;
}

function frame(t) {
  requestAnimationFrame(frame);
  if (S.buffer && !S.seeking) {
    const p = position(), sk = $('seek');
    sk.value = p; setPct(sk);
    $('time').textContent = `${fmtTime(p)} / ${fmtTime(S.buffer.duration)}`;
  }
  // nivel de graves (≈ 30–150 Hz)
  if (S.analyser) {
    if (!freqData || freqData.length !== S.analyser.frequencyBinCount) freqData = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteFrequencyData(freqData);
    const nyq = S.ctx.sampleRate / 2, a = Math.floor((30 / nyq) * freqData.length), b = Math.ceil((150 / nyq) * freqData.length);
    let s = 0; for (let i = a; i <= b; i++) s += freqData[i];
    const target = S.playing ? Math.pow(s / (b - a + 1) / 255, 1.6) : 0;
    S.bass += (target - S.bass) * (target > S.bass ? 0.55 : 0.12);
  } else S.bass *= 0.9;
  hero.style.setProperty('--bass', S.bass.toFixed(3));
  tilt.x += (tilt.tx - tilt.x) * 0.08; tilt.y += (tilt.ty - tilt.y) * 0.08;
  logoWrap.style.transform = `perspective(900px) rotateX(${tilt.x.toFixed(2)}deg) rotateY(${tilt.y.toFixed(2)}deg) scale(${(1 + S.bass * 0.09).toFixed(4)})`;
  if (!REDUCED) { drawRadial(t, S.bass); drawParticles(S.bass); }
}

function initEffects() {
  // spotlight en tarjetas
  document.querySelectorAll('.card').forEach((c) => c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`); c.style.setProperty('--my', `${e.clientY - r.top}px`);
  }));
  // inclinación 3D del logo
  hero.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    tilt.ty = ((e.clientX - r.left) / r.width - 0.5) * 22; tilt.tx = -((e.clientY - r.top) / r.height - 0.5) * 22;
  });
  hero.addEventListener('pointerleave', () => { tilt.tx = tilt.ty = 0; });
  // aparición al hacer scroll
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach((el, i) => { el.style.transitionDelay = `${(i % 3) * 70}ms`; io.observe(el); });
  // ripple en botones
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn'); if (!b || b.disabled) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height), s = document.createElement('span');
    s.className = 'ripple'; s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s); setTimeout(() => s.remove(), 650);
  });
  // palabras rotativas
  let wi = 0; const w = $('word');
  setInterval(() => { w.classList.add('out'); setTimeout(() => { wi = (wi + 1) % WORDS.length; w.textContent = WORDS[wi]; w.classList.remove('out'); }, 350); }, 2400);
  // click en el logo = golpe de graves
  logoWrap.addEventListener('click', () => { S.bass = 1; });
}

/* --------------------------------- Loading --------------------------------- */
async function loadFile(file) {
  if (!file) return;
  $('log').textContent = '';
  say(`Cargando ${file.name} (${(file.size / 1048576).toFixed(2)} MB)…`);
  try {
    const ab = await file.arrayBuffer();
    await ensureContext(sniffRate(ab));
    stop();
    S.buffer = await S.ctx.decodeAudioData(ab);
  } catch (e) {
    say('No se pudo decodificar el audio: ' + e.message);
    return;
  }
  S.fileName = file.name.replace(/\.[^.]+$/, '');
  S.offset = 0;
  const b = S.buffer;
  $('seek').max = b.duration;
  $('fileinfo').textContent = `${file.name} · ${b.numberOfChannels} canal(es) · ${b.sampleRate} Hz · ${fmtTime(b.duration)}`;
  const sr = $('sr');
  if (![...sr.options].some((o) => +o.value === b.sampleRate)) sr.add(new Option(`${b.sampleRate} Hz`, b.sampleRate));
  [...sr.options].forEach((o) => { o.textContent = `${o.value} Hz${+o.value === b.sampleRate ? ' (original)' : ''}`; });
  sr.value = b.sampleRate;
  setRate(S.rate);
  syncUI();
  say(`Listo: ${b.numberOfChannels}ch · ${b.sampleRate} Hz · ${b.duration.toFixed(2)} s`);
}

/* --------------------------------- Export --------------------------------- */
const FMT_INFO = {
  flac: 'Lossless. Cada muestra se conserva; ~50–60 % del tamaño del WAV.',
  oga: 'FLAC dentro de contenedor Ogg. Lossless.',
  wav: 'PCM sin compresión.',
  wavf: 'PCM de 32 bit flotante: máxima precisión, sin recorte de picos.',
  aiff: 'PCM sin compresión (Apple / DAWs).',
  mp3: 'Con pérdida (LAME). Máx. 48 kHz.',
};
function updateFmtUI() {
  const f = $('fmt').value, rec = f.startsWith('rec:'), pcm = ['flac', 'oga', 'wav', 'aiff'].includes(f);
  $('bpsWrap').hidden = !pcm; $('ditherWrap').hidden = !pcm;
  $('kbpsWrap').hidden = !(f === 'mp3' || rec);
  $('sr').disabled = rec;
  $('fmtNote').textContent = rec ? 'Con pérdida. Se graba en tiempo real: tarda lo que dura el audio resultante.' : FMT_INFO[f] || '';
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function exportAudio() {
  const btn = $('export'), prog = $('prog');
  const fmt = $('fmt').value, bps = +$('bps').value, kbps = +$('kbps').value;
  let sr = +$('sr').value;
  const b = S.buffer, nch = b.numberOfChannels;
  if (fmt === 'mp3' && !MP3_RATES.includes(sr)) { sr = 48000; say('MP3 admite hasta 48 kHz → se usa 48000 Hz.'); }
  if (fmt.startsWith('rec:')) sr = b.sampleRate;
  btn.disabled = true; prog.hidden = false; prog.value = 0;
  try {
    const len = Math.ceil((b.duration / S.rate) * sr);
    say(`Renderizando ${S.rate.toFixed(2)}x + EQ (${len} muestras @ ${sr} Hz)…`);
    const off = new OfflineAudioContext(nch, len, sr);
    const src = off.createBufferSource();
    src.buffer = b; src.playbackRate.value = S.rate;
    const filters = BANDS.map((_, i) => makeFilter(off, i));
    const pre = off.createGain(); pre.gain.value = dbToGain(S.pre);
    [src, ...filters, pre, off.destination].reduce((a, c) => (a.connect(c), c));
    src.start();
    const out = await off.startRendering();

    const chans = Array.from({ length: nch }, (_, c) => out.getChannelData(c));
    let peak = 0;
    for (const ch of chans) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
    let gain = 1;
    say(`Pico: ${(20 * Math.log10(peak || 1e-9)).toFixed(2)} dBFS`);
    if (peak > 1 && $('norm').checked && fmt !== 'wavf') {
      gain = 0.999 / peak;
      say(`Se superaba 0 dBFS → se aplicó ${(20 * Math.log10(gain)).toFixed(2)} dB para evitar clipping.`);
    } else if (peak > 1 && fmt !== 'wavf') say('⚠ Hay clipping (normalización desactivada).');

    const dither = $('dither').checked && bps === 16;
    const tags = { TITLE: S.fileName, COMMENT: `Velocidad ${S.rate.toFixed(2)}x · EQ ${S.gains.join('/')} dB` };
    const onProgress = (f) => (prog.value = f);
    let blob, ext;
    if (fmt === 'flac' || fmt === 'oga') {
      blob = await encodeFlac(chans, sr, bps, { ogg: fmt === 'oga', gain, dither, tags, onProgress });
      ext = fmt === 'oga' ? 'oga' : 'flac';
    } else if (fmt === 'wav') { blob = encodeWav(chans, sr, bps, { gain, dither }); ext = 'wav'; }
    else if (fmt === 'wavf') { blob = encodeWavFloat(chans, sr, { gain }); ext = 'wav'; }
    else if (fmt === 'aiff') { blob = encodeAiff(chans, sr, bps, { gain, dither }); ext = 'aiff'; }
    else if (fmt === 'mp3') { blob = await encodeMp3(chans, sr, kbps, { gain, onProgress }); ext = 'mp3'; }
    else {
      const r = S.rec.find((x) => fmt === 'rec:' + x.mime);
      say(`Grabando en tiempo real (${r.label}, ${kbps} kbps)…`);
      if (gain !== 1) chans.forEach((ch) => { for (let i = 0; i < ch.length; i++) ch[i] *= gain; });
      blob = await recordCompressed(out, r.mime, kbps, onProgress); ext = r.ext;
    }
    say(`${ext.toUpperCase()}: ${(blob.size / 1048576).toFixed(2)} MB`);
    saveBlob(blob, `${S.fileName}_${S.rate.toFixed(2)}x.${ext}`);
    say('✔ Descarga iniciada.');
  } catch (e) {
    console.error(e);
    say('Error al exportar: ' + e.message);
  } finally {
    btn.disabled = false; prog.hidden = true;
  }
}

/* ----------------------------------- Init ----------------------------------- */
function init() {
  buildEQ();
  ['44100', '48000', '88200', '96000'].forEach((v) => $('sr').add(new Option(`${v} Hz`, v)));
  $('sr').value = '48000';

  // formatos extra que soporte el navegador (Opus / AAC)
  S.rec = recorderFormats();
  S.rec.forEach((r) => $('lossy').appendChild(new Option(`${r.label} · tiempo real`, 'rec:' + r.mime)));
  log('Formatos de grabación disponibles:', S.rec.map((r) => r.label).join(', ') || 'ninguno');
  $('fmt').addEventListener('change', updateFmtUI);
  updateFmtUI();

  SPEED_PRESETS.forEach((r) => {
    const bt = document.createElement('button');
    bt.className = 'btn chip'; bt.textContent = `${r}x`; bt.dataset.r = r;
    bt.addEventListener('click', () => setRate(r));
    $('speedPresets').appendChild(bt);
  });
  setRate(1);
  [$('pre'), $('seek')].forEach(setPct);

  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const dz = document.querySelector('.dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  $('play').addEventListener('click', () => (S.playing ? pause() : play()));
  $('stop').addEventListener('click', stop);
  $('loop').addEventListener('change', (e) => { S.loop = e.target.checked; if (S.source) S.source.loop = S.loop; });
  $('speed').addEventListener('input', (e) => setRate(+e.target.value));
  $('pre').addEventListener('input', (e) => {
    S.pre = +e.target.value; setPct(e.target);
    $('preOut').textContent = `${S.pre} dB`;
    if (S.preGain) S.preGain.gain.setTargetAtTime(dbToGain(S.pre), S.ctx.currentTime, 0.01);
  });
  const seek = $('seek');
  seek.addEventListener('pointerdown', () => (S.seeking = true));
  seek.addEventListener('input', () => { setPct(seek); $('time').textContent = `${fmtTime(+seek.value)} / ${fmtTime(S.buffer.duration)}`; });
  seek.addEventListener('change', () => { S.offset = +seek.value; S.seeking = false; if (S.playing) play(); });
  $('export').addEventListener('click', exportAudio);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && S.buffer && !/INPUT|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); S.playing ? pause() : play(); }
  });

  addEventListener('resize', () => { sizeCanvases(); initParticles(); });
  sizeCanvases(); initParticles(); initEffects(); syncUI();
  requestAnimationFrame(frame);
  log('Chipeo Presión V2 · Pitch & EQ Studio iniciado');
}

init();
