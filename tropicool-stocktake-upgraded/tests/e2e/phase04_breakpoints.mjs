/**
 * Phase 4 regression: information architecture + mobile counting UI at
 * every required breakpoint (320/390/430/768/1024/1440). Walks store
 * picker -> PIN lock -> Home -> Count (sections -> categories -> cards,
 * stepper, typed anomaly) -> Orders -> Reports -> More/Items, watching for
 * console/page errors at each width. Screenshots are written to
 * tests/e2e/screenshots/ (gitignored) for visual spot-checking, not
 * asserted on automatically.
 */
import fs from 'node:fs';
import { BASE, launchBrowser, makeCheck, reportAndExit } from './_helpers.mjs';

const OUT = new URL('./screenshots', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const breakpoints = [
  { name: '320', width: 320, height: 700 },
  { name: '390', width: 390, height: 844 },
  { name: '430', width: 430, height: 932 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1440-desktop', width: 1440, height: 900 },
];

// Known sandbox artifact, not a real app bug: Google Fonts is unreachable
// in network-restricted environments (see README "Why isn't this
// deployed" / Phase 4 notes) but the stylesheet already degrades
// gracefully via its onerror handler.
const KNOWN_BENIGN = /fonts\.googleapis\.com|net::ERR_CONNECTION_RESET/;

const check = makeCheck();
const browser = await launchBrowser();
const allErrors = [];

for (const bp of breakpoints) {
  const context = await browser.newContext({ viewport: { width: bp.width, height: bp.height } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && !KNOWN_BENIGN.test(msg.text())) errors.push(`[${bp.name}] ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`[${bp.name}] PAGEERROR: ${err.message}`));

  await page.goto(BASE);
  await page.waitForSelector('.tt-storepicker-btn');
  await page.screenshot({ path: `${OUT}/${bp.name}-01-storepicker.png` });

  await page.click('[data-store="store_mooloolaba"]');
  await page.waitForSelector('.tt-pin-keypad');
  await page.screenshot({ path: `${OUT}/${bp.name}-02-pinlock.png` });

  for (const d of ['1', '1', '1', '1']) await page.click(`[data-num="${d}"]`);
  await page.waitForSelector('.tt-app-shell', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${bp.name}-03-home.png`, fullPage: true });

  await page.click('[data-tab="count"]:visible');
  await page.waitForSelector('.tt-section-grid');
  await page.screenshot({ path: `${OUT}/${bp.name}-04-count-sections.png` });

  await page.click('[data-main="fridge"]');
  await page.waitForSelector('.tt-section-grid');
  await page.screenshot({ path: `${OUT}/${bp.name}-05-count-categories.png` });

  await page.click('[data-cat="milk"]');
  await page.waitForSelector('.tt-count-cards');
  await page.screenshot({ path: `${OUT}/${bp.name}-06-count-cards.png`, fullPage: true });

  const plusBtn = page.locator('.tt-count-card').first().locator('[data-step="1"]');
  await plusBtn.click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${bp.name}-07-count-after-stepper.png` });

  // Oat Milk, system qty 1 -> entering 3 is a big change, triggers Phase 5's
  // anomaly-confirmation modal.
  const secondInput = page.locator('.tt-count-card').nth(1).locator('.tt-qty-input');
  await secondInput.fill('3');
  await secondInput.dispatchEvent('change');
  const anomalyModal = page.locator('.tt-modal-overlay.show');
  if (await anomalyModal.count()) await page.click('[data-action="confirm"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${bp.name}-08-count-typed.png` });

  await page.click('[data-tab="orders"]:visible');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${bp.name}-09-orders.png`, fullPage: true });

  await page.click('[data-tab="reports"]:visible');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${bp.name}-10-reports.png`, fullPage: true });

  await page.click('[data-tab="more"]:visible');
  await page.waitForSelector('.tt-more-menu');
  await page.screenshot({ path: `${OUT}/${bp.name}-11-more.png` });
  await page.click('[data-page="items"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${bp.name}-12-items.png`, fullPage: true });

  check(`no console/page errors at ${bp.name}px`, errors.length === 0);
  allErrors.push(...errors);
  await context.close();
}

if (allErrors.length) console.log(allErrors.join('\n'));
await browser.close();
reportAndExit(check, 'Phase 4: information architecture + mobile counting UI');
