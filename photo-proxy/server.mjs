import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT        = parseInt(process.env.PORT ?? '3002', 10);
const IMMICH_BASE = process.env.IMMICH_BASE ?? 'http://localhost:2283/api';
const API_KEY     = process.env.IMMICH_API_KEY ?? '';
const ART_DIR      = process.env.ART_DIR      ?? path.join(__dirname, 'art');
const TRACKS_DIR   = process.env.TRACKS_DIR   ?? path.join(__dirname, 'tracks');
const PIMSLEUR_DIR = process.env.PIMSLEUR_DIR ?? '/home/bernardo/Library/books/Polski/Pimsleur/Pimsleur - Polish I';
const CALLAS_DIR   = process.env.CALLAS_DIR   ?? '/home/bernardo/Library/musik/callas';
const SETS_DIR     = process.env.SETS_DIR     ?? '/home/bernardo/Library/musik/sets';
if (!API_KEY) { console.error('IMMICH_API_KEY is not set'); process.exit(1); }
const HEADERS = { 'x-api-key': API_KEY };

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.flac']);
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.flac': 'audio/flac' };

// ---------------------------------------------------------------------------
// Immich helpers (photos mode)
// ---------------------------------------------------------------------------

async function fetchRandomAssets() {
  const res = await fetch(`${IMMICH_BASE}/search/random`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'IMAGE' }),
  });
  if (!res.ok) throw new Error(`random assets ${res.status}`);
  return res.json();
}

async function fetchThumbnail(id) {
  const res = await fetch(`${IMMICH_BASE}/assets/${id}/thumbnail?size=preview`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`thumbnail ${id} ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function pickRandomImageAsset() {
  const assets = await fetchRandomAssets();
  const img = assets.find(a => a.type === 'IMAGE');
  if (!img) throw new Error('No IMAGE asset in random batch');
  return img;
}

// Immich can list an asset whose preview file is gone from disk (thumbnail 404);
// move on to another photo instead of failing the request.
const RANDOM_TRIES = 5;

async function buildRandomPayload() {
  let lastErr;
  for (let i = 0; i < RANDOM_TRIES; i++) {
    const asset = await pickRandomImageAsset();
    try {
      const dataUri = await fetchThumbnail(asset.id);
      return { asset, dataUri };
    } catch (err) {
      if (!/ 404$/.test(err.message)) throw err;
      console.warn(`[random] ${err.message}, trying another asset`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Prefetch pool — always keep one photo ready
// ---------------------------------------------------------------------------

let prefetchPromise = null; // resolves to { asset, dataUri }

function startPrefetch() {
  prefetchPromise = buildRandomPayload().catch(err => {
    console.error('[prefetch] error:', err.message);
    prefetchPromise = null;
    return null;
  });
}

async function getRandomFromPool() {
  if (prefetchPromise) {
    const result = await prefetchPromise;
    prefetchPromise = null;
    startPrefetch(); // immediately start fetching the next one
    if (result) return result;
  }
  // On-demand fallback (first call or after prefetch error)
  const result = await buildRandomPayload();
  startPrefetch();
  return result;
}

// ---------------------------------------------------------------------------
// Same-day cache
// ---------------------------------------------------------------------------

// Map of dateStr (YYYY-MM-DD) -> { assets: [...], fetchedAt: timestamp }
const dayCache = new Map();
const DAY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getDayAssets(dateStr) {
  const cached = dayCache.get(dateStr);
  if (cached && Date.now() - cached.fetchedAt < DAY_CACHE_TTL_MS) {
    return cached.assets;
  }

  // takenAfter = start of day, takenBefore = end of day (ISO 8601 UTC)
  const takenAfter = `${dateStr}T00:00:00.000Z`;
  const takenBefore = `${dateStr}T23:59:59.999Z`;

  const res = await fetch(`${IMMICH_BASE}/search/metadata`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ takenAfter, takenBefore, type: 'IMAGE', size: 500 }),
  });
  if (!res.ok) throw new Error(`day search ${res.status}`);
  const data = await res.json();

  // Immich search/metadata returns { assets: { items: [...] } }
  const assets = data?.assets?.items ?? [];

  // Sort by capture time ascending
  assets.sort((a, b) => {
    const ta = a.localDateTime ?? a.fileCreatedAt ?? '';
    const tb = b.localDateTime ?? b.fileCreatedAt ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  dayCache.set(dateStr, { assets, fetchedAt: Date.now() });
  return assets;
}

// ---------------------------------------------------------------------------
// Local files: artwork (art mode) and audio tracks (both modes)
// ---------------------------------------------------------------------------

function listFiles(dir, exts) {
  try {
    return fs.readdirSync(dir).filter(f => {
      if (f.startsWith('.') || !exts.has(path.extname(f).toLowerCase())) return false;
      try {
        const st = fs.statSync(path.join(dir, f));
        return st.isFile() && st.size > 0;
      } catch { return false; }
    });
  } catch { return []; }
}

const POLISH_RADIO_STREAMS = [
  { name: 'Radio Nowy Świat',      url: 'https://stream.rcs.revma.com/ypqt40u0x1zuv',                 mode: 'direct' },
  { name: 'Radio 357',             url: 'https://stream.radio357.pl/',                                mode: 'direct' },
  { name: 'Polskie Radio Trójka',  url: 'https://stream13.polskieradio.pl/pr3/pr3.sdp/playlist.m3u8', mode: 'ffmpeg' },
  { name: 'Polskie Radio Dwójka',  url: 'https://stream12.polskieradio.pl/pr2/pr2.sdp/playlist.m3u8', mode: 'ffmpeg' },
  { name: 'Polskie Radio Jedynka', url: 'https://stream11.polskieradio.pl/pr1/pr1.sdp/playlist.m3u8', mode: 'ffmpeg' },
  { name: 'Polskie Radio 24',      url: 'http://stream3.polskieradio.pl:8080/;',                      mode: 'ffmpeg' },
  { name: 'TOK FM',                url: 'https://radiostream.pl/tuba10-1.mp3',                        mode: 'direct' },
  { name: 'RMF Classic',           url: 'http://195.150.20.242:8000/rmf_classic',                     mode: 'direct' },
  { name: 'RMF FM',                url: 'http://195.150.20.242:8000/rmf_fm',                          mode: 'direct' },
  { name: 'Radio ZET',             url: 'https://zt01.cdn.eurozet.pl/zet-net.mp3',                    mode: 'direct' },
];

const PLAYLIST_DEFS = [
  { id: 'ambient',      label: 'Ambient & Classical', dir: TRACKS_DIR,   shuffle: true,  live: false },
  { id: 'polish-radio', label: 'Polish Radio',        streams: POLISH_RADIO_STREAMS, shuffle: false, live: true  },
  { id: 'pimsleur',     label: 'Polish Learning',     dir: PIMSLEUR_DIR, shuffle: false, live: false },
  { id: 'callas',       label: 'Maria Callas',        dir: CALLAS_DIR,   shuffle: true,  live: false },
  { id: 'sets',         label: 'DJ Sets',             dir: SETS_DIR,     shuffle: true,  live: false },
];

function getPlaylists() {
  const out = [];
  for (const def of PLAYLIST_DEFS) {
    if (def.streams) {
      out.push({
        id: def.id,
        label: def.label,
        shuffle: def.shuffle,
        live: true,
        tracks: def.streams.map(s => s.name),
      });
      continue;
    }
    const tracks = listFiles(def.dir, AUDIO_EXTS).sort();
    if (tracks.length > 0) {
      out.push({ id: def.id, label: def.label, shuffle: def.shuffle, live: false, dir: def.dir, tracks });
    }
  }
  return out;
}

async function streamLiveRadio(req, res, streamDef) {
  if (streamDef.mode === 'direct') {
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      const upstream = await fetch(streamDef.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (KioskRadioProxy)' },
        signal: ac.signal,
      });
      if (!upstream.ok || !upstream.body) {
        sendError(res, 502, `Radio upstream ${upstream.status}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*',
      });
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', () => { try { res.end(); } catch {} });
      nodeStream.pipe(res);
    } catch (err) {
      if (err.name !== 'AbortError' && !res.headersSent) {
        sendError(res, 502, err.message);
      }
    }
    return;
  }

  // ffmpeg mode for HLS (.m3u8) and Shoutcast (ICY 200 OK) streams
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Access-Control-Allow-Origin': '*',
  });
  const ff = spawn('ffmpeg', [
    '-nostdin',
    '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', streamDef.url,
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', '192k',
    '-f', 'mp3',
    '-',
  ]);
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => console.warn(`[radio:${streamDef.name}]`, d.toString().trim()));
  ff.on('error', () => { try { res.end(); } catch {} });
  const cleanup = () => { try { ff.kill('SIGTERM'); } catch {} };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

// "Caspar David Friedrich - Der Mönch am Meer.jpg" → { artist, title }
// "De sterrennacht.jpg"                            → { artist: '', title }
function parseArtName(filename) {
  const base = path.basename(filename, path.extname(filename));
  const sep  = base.indexOf(' - ');
  return sep !== -1
    ? { artist: base.slice(0, sep).trim(), title: base.slice(sep + 3).trim() }
    : { artist: '',                         title: base.trim() };
}

let lastArtFile = null;

function buildArtPayload() {
  const files = listFiles(ART_DIR, IMAGE_EXTS);
  if (!files.length) throw new Error(`No images in ART_DIR (${ART_DIR})`);
  let candidates = files;
  if (files.length > 1 && lastArtFile) candidates = files.filter(f => f !== lastArtFile);
  const filename = candidates[Math.floor(Math.random() * candidates.length)];
  lastArtFile = filename;
  const ext     = path.extname(filename).toLowerCase();
  const mime    = IMAGE_MIME[ext] ?? 'image/jpeg';
  const buf     = fs.readFileSync(path.join(ART_DIR, filename));
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  return { filename, ...parseArtName(filename), dataUri };
}

function streamTrack(req, res, dir, filename) {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename === '..') {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const root = path.resolve(dir);
  const safePath = path.resolve(root, path.basename(filename));
  if (!safePath.startsWith(root + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const ext  = path.extname(filename).toLowerCase();
  const mime = AUDIO_MIME[ext] ?? 'audio/mpeg';
  let stat;
  try { stat = fs.statSync(safePath); }
  catch { sendError(res, 404, 'Not found'); return; }

  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end   = range[2] ? parseInt(range[2], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type':   mime,
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(safePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type':   mime,
      'Content-Length': stat.size,
      'Accept-Ranges':  'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(safePath).pipe(res);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendError(res, status, msg) {
  sendJson(res, status, { error: msg });
}

const server = http.createServer(async (req, res) => {
  console.log(`[req] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ------------------------------------------------------------------
  // GET /  — the kiosk page itself, for testing in a desktop browser
  // ------------------------------------------------------------------
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'kiosk.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch {
      sendError(res, 404, 'kiosk.html not deployed next to server.mjs');
    }
    return;
  }

  // ------------------------------------------------------------------
  // GET /random  — random Immich photo
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/random') {
    try {
      const payload = await getRandomFromPool();
      sendJson(res, 200, payload);
    } catch (err) {
      console.error('[/random]', err.message);
      sendError(res, 500, err.message);
    }
    return;
  }

  // ------------------------------------------------------------------
  // GET /same-day?date=YYYY-MM-DD&id=CURRENT_ID&dir=1
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/same-day') {
    const dateStr = url.searchParams.get('date');
    const currentId = url.searchParams.get('id');
    const dir = parseInt(url.searchParams.get('dir') ?? '1', 10);

    if (!dateStr || !currentId || isNaN(dir)) {
      sendError(res, 400, 'Missing or invalid query params: date, id, dir');
      return;
    }

    try {
      const assets = await getDayAssets(dateStr);
      if (assets.length === 0) {
        sendError(res, 404, `No images found for ${dateStr}`);
        return;
      }

      // Find current index; fall back to 0 if not found
      let idx = assets.findIndex(a => a.id === currentId);
      if (idx === -1) idx = 0;

      // Advance with wrap-around
      idx = ((idx + dir) % assets.length + assets.length) % assets.length;

      const asset = assets[idx];
      const dataUri = await fetchThumbnail(asset.id);

      sendJson(res, 200, { asset, dataUri, index: idx + 1, total: assets.length });
    } catch (err) {
      console.error('[/same-day]', err.message);
      sendError(res, 500, err.message);
    }
    return;
  }

  // ------------------------------------------------------------------
  // GET /asset?id=ASSET_ID  — fetch a specific asset by ID (for history back)
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/asset') {
    const id = url.searchParams.get('id');
    if (!id) { sendError(res, 400, 'Missing param: id'); return; }
    try {
      const [assetRes, dataUri] = await Promise.all([
        fetch(`${IMMICH_BASE}/assets/${id}`, { headers: HEADERS }).then(r => r.json()),
        fetchThumbnail(id),
      ]);
      sendJson(res, 200, { asset: assetRes, dataUri });
    } catch (err) {
      console.error('[/asset]', err.message);
      sendError(res, 500, err.message);
    }
    return;
  }

  // ------------------------------------------------------------------
  // GET /day-info?date=YYYY-MM-DD&id=CURRENT_ID  — index + total, no image
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/day-info') {
    const dateStr = url.searchParams.get('date');
    const currentId = url.searchParams.get('id');
    if (!dateStr || !currentId) {
      sendError(res, 400, 'Missing params: date, id');
      return;
    }
    try {
      const assets = await getDayAssets(dateStr);
      const idx = assets.findIndex(a => a.id === currentId);
      sendJson(res, 200, { index: idx === -1 ? 1 : idx + 1, total: assets.length });
    } catch (err) {
      console.error('[/day-info]', err.message);
      sendError(res, 500, err.message);
    }
    return;
  }

  // ------------------------------------------------------------------
  // GET /art/random  — random artwork from ART_DIR: { filename, artist, title, dataUri }
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/art/random') {
    try {
      sendJson(res, 200, buildArtPayload());
    } catch (err) {
      console.error('[/art/random]', err.message);
      sendError(res, 500, err.message);
    }
    return;
  }

  // ------------------------------------------------------------------
  // GET /playlists  — available radio stations [{ id, label, shuffle, live, tracks }]
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/playlists') {
    const playlists = getPlaylists().map(({ id, label, shuffle, live, tracks }) => ({ id, label, shuffle, live: !!live, tracks }));
    sendJson(res, 200, playlists);
    return;
  }

  // ------------------------------------------------------------------
  // GET /tracks  — sorted audio filenames in TRACKS_DIR
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/tracks') {
    sendJson(res, 200, listFiles(TRACKS_DIR, AUDIO_EXTS).sort());
    return;
  }

  // ------------------------------------------------------------------
  // GET /track/:playlist/:filename  — stream audio or live radio from a station
  // ------------------------------------------------------------------
  const playlistTrack = url.pathname.match(/^\/track\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && playlistTrack) {
    let playlistId, filename;
    try {
      playlistId = decodeURIComponent(playlistTrack[1]);
      filename   = decodeURIComponent(playlistTrack[2]);
    } catch { sendError(res, 400, 'Bad track path'); return; }
    const pl = PLAYLIST_DEFS.find(p => p.id === playlistId);
    if (!pl) { sendError(res, 404, 'Unknown playlist'); return; }
    if (pl.streams) {
      const streamDef = pl.streams.find(s => s.name === filename);
      if (!streamDef) { sendError(res, 404, 'Unknown radio stream'); return; }
      await streamLiveRadio(req, res, streamDef);
      return;
    }
    streamTrack(req, res, pl.dir, filename);
    return;
  }

  // ------------------------------------------------------------------
  // GET /track/:filename  — stream audio from TRACKS_DIR, range requests supported
  // ------------------------------------------------------------------
  const track = url.pathname.match(/^\/track\/([^/]+)$/);
  if (req.method === 'GET' && track) {
    let filename;
    try { filename = decodeURIComponent(track[1]); }
    catch { sendError(res, 400, 'Bad track name'); return; }
    streamTrack(req, res, TRACKS_DIR, filename);
    return;
  }

  sendError(res, 404, 'Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[photo-proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[photo-proxy] ART_DIR=${ART_DIR} (${listFiles(ART_DIR, IMAGE_EXTS).length} images)`);
  for (const pl of getPlaylists()) {
    console.log(`[photo-proxy] station "${pl.id}" (${pl.label}): ${pl.tracks.length} ${pl.live ? 'live streams' : `tracks in ${pl.dir}`}`);
  }
  console.log('[photo-proxy] pre-fetching first random image...');
  startPrefetch();
});

server.on('error', err => {
  console.error('[photo-proxy] server error:', err);
});
