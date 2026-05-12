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
const PAGE_URL = `http://127.0.0.1:${port}/`;

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
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
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

await test('ArrowRight enters same-day mode and shows counter', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => ['img-a','img-b'].some(id => document.getElementById(id)?.src?.startsWith('data:')),
    { timeout: TIMEOUT }
  );
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    () => document.getElementById('day-indicator')?.classList.contains('visible'),
    { timeout: TIMEOUT }
  );
  const indicator = await page.textContent('#day-indicator');
  assert.match(indicator, /\d+ \/ \d+ that day/);
  await page.close();
});

await test('ArrowLeft after ArrowRight changes photo', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => ['img-a','img-b'].some(id => document.getElementById(id)?.src?.startsWith('data:')),
    { timeout: TIMEOUT }
  );
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    () => document.getElementById('day-indicator')?.classList.contains('visible'),
    { timeout: TIMEOUT }
  );
  const afterRight = await page.$$eval(
    '#img-a,#img-b',
    els => [...els].find(el => el.style.opacity === '1')?.src
  );
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(
    (prev) => {
      const visible = [...document.querySelectorAll('#img-a,#img-b')]
        .find(el => el.style.opacity === '1');
      return visible && visible.src !== prev && visible.src.startsWith('data:');
    },
    afterRight,
    { timeout: TIMEOUT }
  );
  await page.close();
});

await test('ArrowDown from same-day mode updates indicator to new day', async () => {
  const page = await newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => ['img-a','img-b'].some(id => document.getElementById(id)?.src?.startsWith('data:')),
    { timeout: TIMEOUT }
  );
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    () => document.getElementById('day-indicator')?.classList.contains('visible'),
    { timeout: TIMEOUT }
  );
  const prevIndicator = await page.textContent('#day-indicator');
  await page.keyboard.press('ArrowDown');
  // New photo loads and indicator updates
  await page.waitForFunction(
    (prev) => {
      const el = document.getElementById('day-indicator');
      return el?.classList.contains('visible') && el.textContent !== prev;
    },
    prevIndicator,
    { timeout: TIMEOUT }
  );
  await page.close();
});

// ── Teardown ──────────────────────────────────────────────────────────────────
await browser.close();
httpServer.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
