import http from 'http';

const PORT       = parseInt(process.env.PORT ?? '3002', 10);
const IMMICH_BASE = process.env.IMMICH_BASE ?? 'http://localhost:2283/api';
const API_KEY     = process.env.IMMICH_API_KEY ?? '';
if (!API_KEY) { console.error('IMMICH_API_KEY is not set'); process.exit(1); }
const HEADERS = { 'x-api-key': API_KEY };

// ---------------------------------------------------------------------------
// Immich helpers
// ---------------------------------------------------------------------------

async function fetchRandomAssets() {
  const res = await fetch(`${IMMICH_BASE}/assets/random?count=10`, {
    headers: HEADERS,
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

async function buildRandomPayload() {
  const asset = await pickRandomImageAsset();
  const dataUri = await fetchThumbnail(asset.id);
  return { asset, dataUri };
}

// ---------------------------------------------------------------------------
// Prefetch pool — always keep one ready
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
  // GET /random
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

  sendError(res, 404, 'Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[photo-proxy] listening on http://0.0.0.0:${PORT}`);
  console.log('[photo-proxy] pre-fetching first random image...');
  startPrefetch();
});

server.on('error', err => {
  console.error('[photo-proxy] server error:', err);
});
