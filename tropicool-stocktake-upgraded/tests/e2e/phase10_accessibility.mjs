/**
 * Phase 10 regression: a real axe-core scan (WCAG 2.0/2.1 A/AA +
 * best-practice rules) across every screen and several modals, plus a
 * couple of hand-written checks axe can't express: exactly one <h1> on
 * Home, and that the skip link is the first tab stop and actually moves
 * focus to #ttContent when activated.
 *
 * This does not assert zero violations by itself (run it and read the
 * output) -- see README.md "Running tests" for the current baseline.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { BASE, launchBrowser } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const AXE_SRC = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

async function runAxe(label) {
  await page.addScriptTag({ content: AXE_SRC });
  const results = await page.evaluate(async () => {
    return await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    });
  });
  console.log(`\n=== ${label} === violations: ${results.violations.length}`);
  for (const v of results.violations) {
    console.log(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
    for (const n of v.nodes.slice(0, 3)) console.log(`     - ${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[0] || ''}`);
  }
  return results.violations;
}

async function signIn(storeId, pin) {
  await page.goto(BASE);
  await page.click(`[data-store="${storeId}"]`);
  await page.waitForSelector('.tt-pin-keypad');
  for (const d of pin.split('')) await page.click(`[data-num="${d}"]`);
  await page.waitForSelector('.tt-app-shell');
}

let allViolations = [];

await page.goto(BASE);
await page.waitForSelector('.tt-storepicker-btn');
allViolations.push(...await runAxe('Store picker'));

await page.click('[data-store="store_mooloolaba"]');
await page.waitForSelector('.tt-pin-keypad');
allViolations.push(...await runAxe('PIN lock'));

await signIn('store_mooloolaba', '2222'); // Bob, manager -- broadest UI visibility
await page.waitForTimeout(300);
allViolations.push(...await runAxe('Home'));

const h1Count = await page.locator('h1').count();
console.log(`h1 count on Home (should be exactly 1): ${h1Count}`);
if (h1Count !== 1) allViolations.push({ id: 'custom-h1-count', impact: 'serious', help: 'not exactly one h1', nodes: [] });

const skipLink = page.locator('.tt-skip-link');
console.log('skip link present:', await skipLink.count() === 1);
await page.keyboard.press('Tab');
const skipLinkFocused = await page.evaluate(() => document.activeElement?.classList.contains('tt-skip-link'));
console.log('skip link is the first tab stop:', skipLinkFocused);
if (skipLinkFocused) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const focusedId = await page.evaluate(() => document.activeElement?.id);
  console.log('after activating skip link, focus moved to:', focusedId);
}

await page.click('[data-tab="count"]:visible');
await page.waitForSelector('.tt-section-grid');
allViolations.push(...await runAxe('Count - sections'));
await page.click('[data-main="fridge"]');
await page.waitForSelector('.tt-section-grid');
allViolations.push(...await runAxe('Count - categories'));
await page.click('[data-cat="milk"]');
await page.waitForSelector('.tt-count-cards');
allViolations.push(...await runAxe('Count - cards'));

await page.click('[data-tab="orders"]:visible');
await page.waitForTimeout(300);
allViolations.push(...await runAxe('Orders'));

await page.click('[data-tab="reports"]:visible');
await page.waitForTimeout(300);
allViolations.push(...await runAxe('Reports - stocktake'));
for (const rep of ['staff', 'waste', 'expiry', 'valuation', 'orders', 'audit']) {
  await page.click(`[data-report="${rep}"]`);
  await page.waitForTimeout(200);
  allViolations.push(...await runAxe(`Reports - ${rep}`));
}

await page.click('[data-tab="more"]:visible');
await page.waitForSelector('.tt-more-menu');
allViolations.push(...await runAxe('More - menu'));
for (const sub of ['items', 'staff', 'roster', 'cash', 'announcements']) {
  await page.click(`[data-page="${sub}"]`);
  await page.waitForTimeout(300);
  allViolations.push(...await runAxe(`More - ${sub}`));
  await page.click('#ttMoreBack');
  await page.waitForSelector('.tt-more-menu');
}

// A couple of open modals
await page.click('[data-page="items"]');
await page.waitForSelector('#ttAddItemBtn');
await page.click('#ttAddItemBtn');
await page.waitForSelector('.tt-modal-overlay.show');
allViolations.push(...await runAxe('Modal - add item'));
await page.click('#ttAddCancel');
await page.click('#ttMoreBack');
await page.waitForSelector('.tt-more-menu');

await browser.close();

const seen = new Set();
const unique = allViolations.filter((v) => { if (seen.has(v.id)) return false; seen.add(v.id); return true; });
console.log(`\n\nTOTAL unique violation types across all screens: ${unique.length}`);
console.log(unique.map((v) => `${v.impact}: ${v.id}`).join('\n'));
process.exit(unique.length === 0 ? 0 : 1);
