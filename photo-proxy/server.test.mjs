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

console.log('\n/day-nav');

await test('dir=1 returns the first photo of an earlier day (or 404 at the start of the library)', async () => {
  const res = await fetch(`${BASE}/day-nav?date=${seedDate}&dir=1`);
  if (res.status === 404) return;
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.asset?.id, 'missing asset.id');
  assert.ok(data.dataUri?.startsWith('data:image/'), 'missing dataUri');
  assert.equal(data.index, 1);
  assert.ok(data.total >= 1, 'total < 1');
  assert.ok(data.date < seedDate, `day ${data.date} is not before ${seedDate}`);
  assert.equal((data.asset.localDateTime ?? data.asset.fileCreatedAt).split('T')[0], data.date);
});

await test('dir=-1 returns a later day (or 404 at the end of the library)', async () => {
  const res = await fetch(`${BASE}/day-nav?date=${seedDate}&dir=-1`);
  if (res.status === 404) return;
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.date > seedDate, `day ${data.date} is not after ${seedDate}`);
});

await test('returns 404 before the first day ever', async () => {
  const res = await fetch(`${BASE}/day-nav?date=1900-01-01&dir=1`);
  assert.equal(res.status, 404);
});

await test('returns 400 on a bad date or dir', async () => {
  assert.equal((await fetch(`${BASE}/day-nav?date=yesterday&dir=1`)).status, 400);
  assert.equal((await fetch(`${BASE}/day-nav?date=${seedDate}&dir=2`)).status, 400);
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

await test('unknown gallery returns 404', async () => {
  assert.equal((await fetch(`${BASE}/art/random?gallery=nope`)).status, 404);
});

console.log('\n/art/galleries, /art/list, /art/image');

const galleries = await (await fetch(`${BASE}/art/galleries`)).json();

await test('/art/galleries lists "all" first with counts', async () => {
  assert.ok(Array.isArray(galleries) && galleries.length > 0, 'no galleries');
  assert.equal(galleries[0].id, 'all');
  assert.equal(galleries[0].label, 'All');
  for (const g of galleries) {
    assert.ok(typeof g.label === 'string' && g.label.length > 0, `gallery ${g.id} has no label`);
    assert.ok(Number.isInteger(g.count) && g.count > 0, `gallery ${g.id} has no images`);
  }
  const subs = galleries.slice(1).reduce((n, g) => n + g.count, 0);
  assert.ok(galleries[0].count >= subs, '"all" is smaller than the sum of the moods');
});

await test('/art/list returns sorted entries with artist and title; sub-gallery files are prefixed', async () => {
  for (const g of galleries) {
    const list = await (await fetch(`${BASE}/art/list?gallery=${encodeURIComponent(g.id)}`)).json();
    assert.equal(list.length, g.count, `gallery ${g.id}: list/count mismatch`);
    for (const e of list) {
      assert.ok(typeof e.file === 'string' && e.file.length > 0, 'file missing');
      assert.ok(typeof e.title === 'string' && e.title.length > 0, 'title missing');
      assert.ok(typeof e.artist === 'string', 'artist missing');
      if (g.id !== 'all') assert.ok(e.file.startsWith(`${g.id}/`), `${e.file} not under ${g.id}/`);
    }
  }
  assert.equal((await fetch(`${BASE}/art/list?gallery=nope`)).status, 404);
});

await test('/art/image serves a listed file with the /art/random shape', async () => {
  const list = await (await fetch(`${BASE}/art/list?gallery=all`)).json();
  const res = await fetch(`${BASE}/art/image?file=${encodeURIComponent(list[0].file)}`);
  assert.equal(res.status, 200);
  const art = await res.json();
  assert.equal(art.filename, list[0].file);
  assert.equal(art.title, list[0].title);
  assert.ok(art.dataUri?.startsWith('data:image/'), 'missing dataUri');
});

await test('/art/image rejects traversal and unknown files', async () => {
  assert.equal((await fetch(`${BASE}/art/image?file=..%2Fserver.mjs`)).status, 403);
  assert.equal((await fetch(`${BASE}/art/image?file=calm%2F..%2F..%2Fserver.mjs`)).status, 403);
  assert.equal((await fetch(`${BASE}/art/image?file=a%2Fb%2Fc.jpg`)).status, 403);
  assert.equal((await fetch(`${BASE}/art/image?file=does-not-exist.jpg`)).status, 404);
  assert.equal((await fetch(`${BASE}/art/image`)).status, 403);
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

console.log('\n/radio/now-playing');

await test('/radio/now-playing returns 200 with station and nowPlaying info', async () => {
  const res = await fetch(`${BASE}/radio/now-playing?stream=${encodeURIComponent('Radio 357 (Indie Rock)')}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const data = await res.json();
  assert.equal(data.station, 'Radio 357 (Indie Rock)');
  assert.ok('nowPlaying' in data);
});

await test('/radio/now-playing with unknown stream returns null nowPlaying', async () => {
  const res = await fetch(`${BASE}/radio/now-playing?stream=unknown`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.station, 'unknown');
  assert.equal(data.nowPlaying, null);
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
