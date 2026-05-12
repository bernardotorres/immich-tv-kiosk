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

console.log('\n/other');

await test('unknown path returns 404', async () => {
  const res = await fetch(`${BASE}/nonexistent`);
  assert.equal(res.status, 404);
});

console.log('');
