import { strict as assert } from 'assert';

const BASE = process.env.PROXY_BASE ?? 'http://192.168.178.250:3002';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\n/random');

await test('returns 200', async () => {
  const res = await fetch(`${BASE}/random`);
  assert.equal(res.status, 200);
});

await test('returns asset with id', async () => {
  const { asset } = await (await fetch(`${BASE}/random`)).json();
  assert.ok(asset?.id, 'asset.id missing');
});

await test('returns dataUri as base64 JPEG', async () => {
  const { dataUri } = await (await fetch(`${BASE}/random`)).json();
  assert.ok(dataUri?.startsWith('data:image/'), `unexpected dataUri prefix: ${dataUri?.slice(0, 40)}`);
  assert.ok(dataUri.includes('base64,'), 'not base64');
});

await test('asset type is IMAGE', async () => {
  const { asset } = await (await fetch(`${BASE}/random`)).json();
  assert.equal(asset.type, 'IMAGE');
});

await test('has localDateTime or fileCreatedAt', async () => {
  const { asset } = await (await fetch(`${BASE}/random`)).json();
  assert.ok(asset.localDateTime || asset.fileCreatedAt, 'no date field');
});

console.log('\n/same-day');

// Get a real asset to use for same-day tests
const { asset: seedAsset } = await (await fetch(`${BASE}/random`)).json();
const seedDate = (seedAsset.localDateTime ?? seedAsset.fileCreatedAt).split('T')[0];

await test('returns 200 with valid params', async () => {
  const res = await fetch(`${BASE}/same-day?date=${seedDate}&id=${seedAsset.id}&dir=1`);
  assert.equal(res.status, 200);
});

await test('returns asset + dataUri + index + total', async () => {
  const data = await (await fetch(`${BASE}/same-day?date=${seedDate}&id=${seedAsset.id}&dir=1`)).json();
  assert.ok(data.asset?.id, 'missing asset.id');
  assert.ok(data.dataUri?.startsWith('data:image/'), 'missing dataUri');
  assert.ok(typeof data.index === 'number', 'missing index');
  assert.ok(typeof data.total === 'number', 'missing total');
});

await test('dir=-1 and dir=1 return different assets (if >1 photo that day)', async () => {
  const [r1, r2] = await Promise.all([
    fetch(`${BASE}/same-day?date=${seedDate}&id=${seedAsset.id}&dir=1`).then(r => r.json()),
    fetch(`${BASE}/same-day?date=${seedDate}&id=${seedAsset.id}&dir=-1`).then(r => r.json()),
  ]);
  // Only assert different if there are multiple photos
  if (r1.total > 1) {
    assert.notEqual(r1.asset.id, r2.asset.id, 'dir=1 and dir=-1 returned same asset');
  }
});

await test('returns 400 on missing params', async () => {
  const res = await fetch(`${BASE}/same-day?date=${seedDate}`);
  assert.equal(res.status, 400);
});

await test('returns CORS header', async () => {
  const res = await fetch(`${BASE}/random`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

console.log('\n/art/random');

await test('returns 200 with artist, title and dataUri', async () => {
  const res = await fetch(`${BASE}/art/random`);
  assert.equal(res.status, 200);
  const art = await res.json();
  assert.ok(typeof art.title === 'string' && art.title.length > 0, 'title missing');
  assert.ok(typeof art.artist === 'string', 'artist missing');
  assert.ok(art.dataUri?.startsWith('data:image/'), 'missing dataUri');
});

await test('two calls return different artworks (if >1 in ART_DIR)', async () => {
  const a = await (await fetch(`${BASE}/art/random`)).json();
  const b = await (await fetch(`${BASE}/art/random`)).json();
  if (a.filename === b.filename) {
    const c = await (await fetch(`${BASE}/art/random`)).json();
    assert.equal(c.filename, a.filename, 'ART_DIR has >1 image but /art/random repeated itself');
  }
});

console.log('\n/tracks');

const tracks = await (await fetch(`${BASE}/tracks`)).json();

await test('returns a sorted array of audio filenames', async () => {
  assert.ok(Array.isArray(tracks), 'not an array');
  assert.deepEqual(tracks, [...tracks].sort(), 'not sorted');
  for (const t of tracks) assert.match(t, /\.(mp3|ogg|m4a|wav|flac)$/i);
});

await test('/track/:name streams audio with range support', async () => {
  if (!tracks.length) return;
  const url = `${BASE}/track/${encodeURIComponent(tracks[0])}`;
  const head = await fetch(url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(head.status, 206);
  assert.match(head.headers.get('content-type'), /^audio\//);
  assert.equal(head.headers.get('content-length'), '100');
  assert.match(head.headers.get('content-range'), /^bytes 0-99\/\d+$/);
  assert.equal((await head.arrayBuffer()).byteLength, 100);
});

await test('/track/ rejects path traversal', async () => {
  const res = await fetch(`${BASE}/track/..%2F..%2Fserver.mjs`);
  assert.ok(res.status === 403 || res.status === 404, `status ${res.status}`);
  assert.doesNotMatch(res.headers.get('content-type') ?? '', /javascript/);
});

await test('/track/ unknown file returns 404', async () => {
  const res = await fetch(`${BASE}/track/does-not-exist.mp3`);
  assert.equal(res.status, 404);
});

console.log('\n/playlists');

const playlists = await (await fetch(`${BASE}/playlists`)).json();

await test('returns a non-empty array of playlists with tracks', async () => {
  assert.ok(Array.isArray(playlists) && playlists.length > 0, 'no playlists returned');
  for (const pl of playlists) {
    assert.ok(typeof pl.id === 'string' && pl.id.length > 0, 'playlist id missing');
    assert.ok(typeof pl.label === 'string' && pl.label.length > 0, 'playlist label missing');
    assert.ok(typeof pl.shuffle === 'boolean', 'playlist shuffle missing');
    assert.ok(Array.isArray(pl.tracks) && pl.tracks.length > 0, `playlist ${pl.id} has no tracks`);
  }
});

await test('/track/:playlist/:name streams audio from each playlist (files + live radio)', async () => {
  for (const pl of playlists) {
    const url = `${BASE}/track/${encodeURIComponent(pl.id)}/${encodeURIComponent(pl.tracks[0])}`;
    if (pl.live) {
      const ac = new AbortController();
      const res = await fetch(url, { signal: ac.signal });
      assert.equal(res.status, 200, `failed on live station ${pl.id}`);
      assert.match(res.headers.get('content-type'), /^audio\//);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      assert.ok(value && value.byteLength > 0, `no bytes from live station ${pl.id}`);
      ac.abort();
    } else {
      const head = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      assert.equal(head.status, 206, `failed on playlist ${pl.id}`);
      assert.match(head.headers.get('content-type'), /^audio\//);
      assert.equal((await head.arrayBuffer()).byteLength, 100);
    }
  }
});

console.log('\n/other');

await test('/ serves the kiosk page', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<title>Kiosk<\/title>/);
});

await test('unknown path returns 404', async () => {
  const res = await fetch(`${BASE}/nonexistent`);
  assert.equal(res.status, 404);
});

console.log('');
