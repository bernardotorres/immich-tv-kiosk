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

await test('ArrowDown loads new random photo and shows day indicator', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => ['img-a','img-b'].some(id => document.getElementById(id)?.src?.startsWith('data:')),
    { timeout: TIMEOUT }
  );
  const firstSrc = await page.$$eval(
    '#img-a,#img-b',
    els => [...els].find(el => el.src.startsWith('data:'))?.src
  );
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    (prev) => ['img-a','img-b'].some(id => {
      const el = document.getElementById(id);
      return el?.src?.startsWith('data:') && el.src !== prev && el.style.opacity === '1';
    }),
    firstSrc,
    { timeout: TIMEOUT }
  );
  await page.waitForFunction(
    () => document.getElementById('day-indicator')?.classList.contains('visible'),
    { timeout: TIMEOUT }
  );
  const indicator = await page.textContent('#day-indicator');
  assert.match(indicator, /\d+ \/ \d+ that day/);
  await page.close();
});

await test('ArrowUp goes back to previous photo', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => ['img-a','img-b'].some(id => document.getElementById(id)?.src?.startsWith('data:')),
    { timeout: TIMEOUT }
  );
  const firstSrc = await page.$$eval('#img-a,#img-b', els => [...els].find(el => el.src.startsWith('data:'))?.src);
  // Go forward
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    (prev) => [...document.querySelectorAll('#img-a,#img-b')].some(el => el.src.startsWith('data:') && el.src !== prev && el.style.opacity === '1'),
    firstSrc, { timeout: TIMEOUT }
  );
  // Go back
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(
    (orig) => [...document.querySelectorAll('#img-a,#img-b')].some(el => el.src === orig && el.style.opacity === '1'),
    firstSrc, { timeout: TIMEOUT }
  );
  await page.close();
});

await test('ArrowRight and ArrowLeft in photos mode change track, not the photo', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  const beforePhoto = await page.$$eval('#img-a,#img-b', els => [...els].find(el => el.style.opacity === '1')?.src);
  const track0 = await page.textContent('#music-track-name');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(prev => document.getElementById('music-track-name')?.textContent !== prev, track0, { timeout: TIMEOUT });
  const track1 = await page.textContent('#music-track-name');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(expected => document.getElementById('music-track-name')?.textContent === expected, track0, { timeout: TIMEOUT });
  const afterPhoto = await page.$$eval('#img-a,#img-b', els => [...els].find(el => el.style.opacity === '1')?.src);
  assert.notEqual(track1, track0, 'track did not change on ArrowRight');
  assert.equal(afterPhoto, beforePhoto, 'photo changed on ArrowRight/ArrowLeft');
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

await test('2 switches to art, 1 back to photos, and the mode persists', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  const photoSrc = await page.$$eval('#img-a,#img-b', els => [...els].find(el => el.style.opacity === '1')?.src);

  await page.keyboard.press('2');
  await page.waitForFunction(
    () => document.body.dataset.mode === 'art' && document.getElementById('art-title')?.textContent?.trim().length > 0,
    { timeout: TIMEOUT }
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_mode')), 'art');

  await page.keyboard.press('1');
  // Switching back resumes the photo that was showing, no refetch
  await page.waitForFunction(
    (prev) => document.body.dataset.mode === 'photos' &&
      [...document.querySelectorAll('#img-a,#img-b')].some(el => el.src === prev && el.style.opacity === '1'),
    photoSrc, { timeout: TIMEOUT }
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_mode')), 'photos');
  await page.close();
});

await test('ArrowRight in art mode changes track, not the artwork', async () => {
  const page = await newPage();
  await page.goto(ART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  const before = await page.$$eval('#img-a,#img-b', els => [...els].find(el => el.style.opacity === '1')?.src);
  const track0 = await page.textContent('#music-track-name');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((prev) => document.getElementById('music-track-name')?.textContent !== prev, track0, { timeout: TIMEOUT });
  const after = await page.$$eval('#img-a,#img-b', els => [...els].find(el => el.style.opacity === '1')?.src);
  assert.equal(after, before, 'artwork changed on ArrowRight');
  await page.close();
});

await test('colour buttons: green (404) switches to art, red (403) back to photos', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(hasPhoto, { timeout: TIMEOUT });
  const colour = code => page.evaluate(c => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: c, bubbles: true })), code);
  await colour(404);
  await page.waitForFunction(() => document.body.dataset.mode === 'art', { timeout: TIMEOUT });
  await colour(403);
  await page.waitForFunction(() => document.body.dataset.mode === 'photos', { timeout: TIMEOUT });
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

await test('3 toggles music off and on, persisted', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  await page.keyboard.press('3');
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent === 'off', { timeout: TIMEOUT });
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_music')), 'off');
  await page.keyboard.press('3');
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent !== 'off', { timeout: TIMEOUT });
  assert.equal(await page.evaluate(() => localStorage.getItem('kiosk_music')), 'on');
  await page.close();
});

await test('CH ▲/▼ (427/428), Blue (406), and 4 switch radio stations, while ←/→ steps tracks', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('music-track-name')?.textContent?.length > 0, { timeout: TIMEOUT });
  const initialText = await page.textContent('#music-track-name');
  // Press CH_UP (427) to switch to the next station (Polish Radio)
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 427, bubbles: true })));
  await page.waitForFunction(prev => document.getElementById('music-track-name')?.textContent !== prev, initialText, { timeout: TIMEOUT });
  const savedPl = await page.evaluate(() => localStorage.getItem('kiosk_playlist'));
  assert.equal(savedPl, 'polish-radio', `expected polish-radio after CH_UP, got ${savedPl}`);
  // ArrowRight steps forward and ArrowLeft steps back within the station (e.g. Radio Nowy Świat -> Radio 357 -> Radio Nowy Świat)
  const streamA = await page.textContent('#music-track-name');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(prev => document.getElementById('music-track-name')?.textContent !== prev, streamA, { timeout: TIMEOUT });
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(expected => document.getElementById('music-track-name')?.textContent === expected, streamA, { timeout: TIMEOUT });
  // CH_DOWN (428) switches back to the previous station (ambient)
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 428, bubbles: true })));
  await page.waitForFunction(() => localStorage.getItem('kiosk_playlist') === 'ambient', { timeout: TIMEOUT });
  await page.close();
});

// ── Teardown ──────────────────────────────────────────────────────────────────
await browser.close();
httpServer.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
