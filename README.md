# Chipeo Presión V2 · Pitch & EQ Studio

Sitio estático (sin build) para Vercel.

- Velocidad + tono acoplados (más rápido = más agudo), 0.25x–3x
- EQ de 10 bandas (31 Hz – 16 kHz, ±12 dB) con curva en vivo, preamp y presets
- Export sin pérdida: FLAC, Ogg FLAC, WAV 16/24, WAV float32, AIFF
- Export con pérdida: MP3 (LAME) y Opus / AAC (según el navegador, en tiempo real)
- Logo en PNG, WebP, AVIF, GIF, SVG, ICO + iconos PWA / Apple / OG (carpeta `assets/`)

## Deploy en Vercel
1. Descomprime el zip.
2. `npx vercel --prod` dentro de la carpeta, o sube la carpeta en vercel.com/new
   (Framework preset: **Other**, sin build command ni output directory).

## Local
`npx serve .` → http://localhost:3000  (los módulos ES requieren http, no file://)
