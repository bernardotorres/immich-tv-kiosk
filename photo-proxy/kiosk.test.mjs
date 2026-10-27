import { chromium } from 'playwright';
import { strict as assert } from 'assert';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(__dirname, 'kiosk.html'), 'utf8');
const TIMEOUT = 15000;

// ── Minimal HTTP server to serve the kiosk HTML ──────────────────────────────
let httpServer, port;
await new Promise(resolve => {
  httpServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  }).listen(0, '127.0.0.1', () => {
    port = httpServer.address().port;
    resolve();
  });
});
// The page talks to a real proxy (photos need Immich); point it at one with PROXY_BASE.
const PROXY_BASE = process.env.PROXY_BASE ?? 'http://192.168.178.250:3002';
const PAGE_URL = `http://127.0.0.1:${port}/?proxy=${encodeURIComponent(PROXY_BASE)}`;
const ART_URL  = `${PAGE_URL}&mode=art`;

const hasPhoto = () => ['img-a','img-b'].some(id => document.getElementById(id)?.src?.startsWith('data:'));

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

const browser = await chromium.launch();

async function newPage() {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page._errors = errors;
  return page;
}

// ── Suite 1: initial load ─────────────────────────────────────────────────────
console.log('\nInitial load');

await test('page loads without JS errors', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  assert.deepEqual(page._errors, [], `JS errors: ${page._errors.join(', ')}`);
  await page.close();
});

await test('clock shows current time', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const text = await page.textContent('#clock');
  assert.match(text, /^\d{2}:\d{2}$/, `unexpected clock text: ${text}`);
  await page.close();
});

await test('photo appears within 10 seconds', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  // Wait until one of the img elements has a data URI src
  await page.waitForFunction(
    () => ['img-a','img-b'].some(id => document.getElementById(id)?.src?.startsWith('data:')),
    { timeout: TIMEOUT }
  );
  await page.close();
});

await test('date label appears after photo loads', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('date-label')?.textContent?.trim().length > 0,
    { timeout: TIMEOUT }
  );
  const label = await page.textContent('#date-label');
  assert.ok(label.length > 0, 'date-label is empty');
  await page.close();
});

await test('no broken-image placeholder visible on load', async () => {
  const page = await newPage();
  await page.route('**/random', () => {}); // hold /random so we inspect the pre-load state
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(100);
  // Both images should start fully transparent (computed style from CSS)
  const [opA, opB] = await page.$$eval('#img-a, #img-b',
    els => els.map(el => getComputedStyle(el).opacity)
  );
  assert.equal(opA, '0', `img-a visible at start (opacity ${opA})`);
  assert.equal(opB, '0', `img-b visible at start (opacity ${opB})`);
  await page.close();
});

// ── Suite 2: navigation ───────────────────────────────────────────────────────
console.log('\nNavigation');

const shownSrc = page => page.$$eval('#img-a,#img-b', els => [...els].find(el => el.style.opacity === '1' && el.src.startsWith('data:'))?.src);
const waitForNewPhoto = (page, prev) => page.waitForFunction(
  p => [...document.querySelectorAll('#img-a,#img-b')].some(el => el.src.startsWith('data:') && el.src !== p && el.style.opacity === '1'),
  prev, { timeout: TIMEOUT }
);
const waitForPhoto = (page, src) => page.waitForFunction(
  s => [...document.querySelectorAll('#img-a,#img-b')].some(el => el.src === s && el.style.opacity === '1'),
  src, { timeout: TIMEOUT }
);
const keyCode = (page, code) => page.evaluate(c => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: c, bubbles: true })), code);
const RED = 403, GREEN = 404, YELLOW = 405, BLUE = 406, CH_UP = 427, CH_DOWN = 428, BACK = 461;

await test('ArrowRight steps to the next photo of the same day; Back (461) returns to the previous one', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  await page.waitForFunction(() => document.getElementById('day-indicator')?.classList.contains('visible'), { timeout: TIMEOUT });
  const firstSrc = await shownSrc(page);
  const date0 = await page.textContent('#date-label');
  const total = Number((await page.textContent('#day-indicator')).match(/\/ (\d+) that day/)[1]);
  await page.keyboard.press('ArrowRight');
  if (total > 1) {
    await waitForNewPhoto(page, firstSrc);
    assert.equal(await page.textContent('#date-label'), date0, 'ArrowRight left the day');
    assert.match(await page.textContent('#day-indicator'), /\d+ \/ \d+ that day/);
    await keyCode(page, BACK);
    await waitForPhoto(page, firstSrc);
  }
  assert.deepEqual(page._errors, [], `JS errors: ${page._errors.join(', ')}`);
  await page.close();
});

await test('ArrowDown goes to an earlier day, ArrowUp back to a later one', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  const firstSrc = await shownSrc(page);
  const day = () => page.evaluate(() => {
    const el = [...document.querySelectorAll('#img-a,#img-b')].find(el => el.style.opacity === '1');
    return el ? document.getElementById('date-label').textContent : null;
  });
  const date0 = await day();
  await page.keyboard.press('ArrowDown');
  await waitForNewPhoto(page, firstSrc);
  const date1 = await day();
  assert.notEqual(date1, date0, 'ArrowDown stayed on the same day');
  assert.match(await page.textContent('#day-indicator'), /^1 \/ \d+ that day$/);
  const secondSrc = await shownSrc(page);
  await page.keyboard.press('ArrowUp');
  await waitForNewPhoto(page, secondSrc);
  assert.notEqual(await day(), date1, 'ArrowUp stayed on the same day');
  assert.deepEqual(page._errors, [], `JS errors: ${page._errors.join(', ')}`);
  await page.close();
});

await test('Red (403) again in photos mode shuffles to a new random photo', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  const firstSrc = await shownSrc(page);
  await keyCode(page, RED);
  await waitForNewPhoto(page, firstSrc);
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_mode')), 'photos');
  await page.close();
});

await test('the ring does not change the track', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  const track0 = await page.textContent('#music-track-name');
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(key);
  await page.waitForTimeout(1500);
  assert.equal(await page.textContent('#music-track-name'), track0, 'track changed on the ring');
  await page.close();
});

// ── Suite 3: art mode and music ──────────────────────────────────────────────
console.log('\nArt mode');

await test('?mode=art shows an artwork with its label and ambient background', async () => {
  const page = await newPage();
  await page.goto(ART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  assert.equal(await page.getAttribute('body', 'data-mode'), 'art');
  const title = await page.textContent('#art-title');
  assert.ok(title.trim().length > 0, 'art-title is empty');
  const bgOn = await page.$$eval('#bg-a,#bg-b', els => els.some(el => el.style.opacity === '1' && el.src.startsWith('data:')));
  assert.ok(bgOn, 'ambient background not shown in art mode');
  const dayHidden = await page.$eval('#date-label', el => getComputedStyle(el).display);
  assert.equal(dayHidden, 'none', 'photo date label visible in art mode');
  await page.close();
});

await test('photos mode keeps the ambient background off', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  const bgOn = await page.$$eval('#bg-a,#bg-b', els => els.some(el => el.style.opacity === '1'));
  assert.ok(!bgOn, 'ambient background shown in photos mode');
  await page.close();
});

await test('Green (404) switches to art, Red (403) back to photos, and the mode persists', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  const photoSrc = await shownSrc(page);

  await keyCode(page, GREEN);
  await page.waitForFunction(
    () => document.body.dataset.mode === 'art' && document.getElementById('art-title')?.textContent?.trim().length > 0,
    { timeout: TIMEOUT }
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_mode')), 'art');

  await keyCode(page, RED);
  // Switching back resumes the photo that was showing, no refetch
  await page.waitForFunction(
    (prev) => document.body.dataset.mode === 'photos' &&
      [...document.querySelectorAll('#img-a,#img-b')].some(el => el.src === prev && el.style.opacity === '1'),
    photoSrc, { timeout: TIMEOUT }
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_mode')), 'photos');
  await page.close();
});

await test('ArrowRight / ArrowLeft walk the artworks of the mood; Back returns', async () => {
  const page = await newPage();
  await page.goto(ART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  const first = await shownSrc(page);
  await page.keyboard.press('ArrowRight');
  await waitForNewPhoto(page, first);
  const second = await shownSrc(page);
  assert.ok((await page.textContent('#art-title')).trim().length > 0, 'art-title empty after ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await waitForPhoto(page, first);
  await keyCode(page, BACK);
  await waitForPhoto(page, second);
  assert.deepEqual(page._errors, [], `JS errors: ${page._errors.join(', ')}`);
  await page.close();
});

await test('ArrowDown / ArrowUp cycle the moods and persist the gallery; Green again returns to All', async () => {
  const page = await newPage();
  await page.goto(ART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  const galleries = await (await fetch(`${PROXY_BASE}/art/galleries`)).json();
  if (galleries.length < 2) { await page.close(); return; }
  const first = await shownSrc(page);
  await page.keyboard.press('ArrowDown');
  await waitForNewPhoto(page, first);
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_gallery')), galleries[1].id);
  await page.waitForFunction(label => document.getElementById('status')?.textContent?.includes(label), galleries[1].label, { timeout: TIMEOUT });
  const second = await shownSrc(page);
  await page.keyboard.press('ArrowUp');
  await waitForNewPhoto(page, second);
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_gallery')), 'all');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => localStorage.getItem('kiosk_gallery') !== 'all', { timeout: TIMEOUT });
  const third = await shownSrc(page);
  await keyCode(page, GREEN);
  await waitForNewPhoto(page, third);
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_gallery')), 'all');
  assert.deepEqual(page._errors, [], `JS errors: ${page._errors.join(', ')}`);
  await page.close();
});

await test('OK shows the art label, the mood and the track', async () => {
  const page = await newPage();
  await page.goto(ART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('art-label').classList.contains('hidden') &&
    !document.getElementById('status').classList.contains('hidden') &&
    document.getElementById('music-info').classList.contains('visible'), { timeout: TIMEOUT });
  assert.match(await page.textContent('#status'), /◆ /);
  await page.close();
});

console.log('\nMusic');

await test('tracks load and play in photos mode', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  assert.ok(await page.$eval('#music-info', el => el.classList.contains('visible')), 'music info not shown');
  await page.close();
});

await test('Yellow (405) toggles music off and on, persisted', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  await keyCode(page, YELLOW);
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent === 'off', { timeout: TIMEOUT });
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_music')), 'off');
  await keyCode(page, YELLOW);
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent !== 'off', { timeout: TIMEOUT });
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_music')), 'on');
  await page.close();
});

await test('Blue (406) and 1–5 switch radio stations, while CH ▲/▼ (427/428) step tracks', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  const initialText = await page.textContent('#music-track-name');
  // Blue switches to the next station (Polish Radio)
  await keyCode(page, BLUE);
  await page.waitForFunction(prev => document.getElementById('music-track-name')?.textContent !== prev, initialText, { timeout: TIMEOUT });
  const savedPl = await page.evaluate(() => localStorage.getItem('kiosk_playlist'));
  assert.equal(savedPl, 'polish-radio', `expected polish-radio after Blue, got ${savedPl}`);
  // CH ▲ steps forward and CH ▼ back within the station (e.g. Radio Nowy Świat -> Radio 357 -> Radio Nowy Świat).
  // The C3 sends them as PageUp/PageDown (33/34); LG's documented 427/428 are accepted too.
  const streamA = await page.textContent('#music-track-name');
  await page.keyboard.press('PageUp');
  await page.waitForFunction(prev => document.getElementById('music-track-name')?.textContent !== prev, streamA, { timeout: TIMEOUT });
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_playlist')), 'polish-radio', 'CH ▲ changed the station');
  await page.keyboard.press('PageDown');
  await page.waitForFunction(expected => document.getElementById('music-track-name')?.textContent === expected, streamA, { timeout: TIMEOUT });
  await keyCode(page, CH_UP);
  await page.waitForFunction(prev => document.getElementById('music-track-name')?.textContent !== prev, streamA, { timeout: TIMEOUT });
  await keyCode(page, CH_DOWN);
  await page.waitForFunction(expected => document.getElementById('music-track-name')?.textContent === expected, streamA, { timeout: TIMEOUT });
  // 1 jumps straight to the first station (ambient), 2 to the second
  await page.keyboard.press('1');
  await page.waitForFunction(() => localStorage.getItem('kiosk_playlist') === 'ambient', { timeout: TIMEOUT });
  await page.keyboard.press('2');
  await page.waitForFunction(() => localStorage.getItem('kiosk_playlist') === 'polish-radio', { timeout: TIMEOUT });
  await page.close();
});

// ── Teardown ──────────────────────────────────────────────────────────────────
await browser.close();
httpServer.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
