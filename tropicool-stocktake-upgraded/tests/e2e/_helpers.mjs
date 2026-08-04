/**
 * Shared helpers for the Playwright end-to-end suite (Phases 4-11). These
 * scripts are real browser verification, not unit tests — see README.md
 * "Running tests" for why they need a live static server and Playwright
 * installed, unlike tests/date.test.js and tests/hash_and_jwt.test.mjs.
 *
 * BASE is overridable via TT_BASE_URL so the suite can run against any
 * port/host the static server happens to be on.
 */
import { chromium } from 'playwright';

export const BASE = process.env.TT_BASE_URL || 'http://127.0.0.1:8891/index.html';

export function makeCheck() {
  let failures = 0;
  const check = (name, cond) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
    if (!cond) failures++;
  };
  check.failures = () => failures;
  return check;
}

export async function launchBrowser() {
  return chromium.launch();
}

export async function signIn(page, storeId, pin) {
  await page.goto(BASE);
  await page.click(`[data-store="${storeId}"]`);
  await page.waitForSelector('.tt-pin-keypad');
  for (const d of pin.split('')) await page.click(`[data-num="${d}"]`);
  await page.waitForSelector('.tt-app-shell');
}

export async function signOutFlow(page) {
  await page.click('#ttMoreBack').catch(() => {});
  await page.click('[data-tab="more"]:visible');
  await page.waitForSelector('.tt-more-menu');
  await page.click('#ttSignOutBtn');
  await page.waitForSelector('.tt-modal-overlay.show');
  await page.click('[data-action="confirm"]');
  await page.waitForSelector('.tt-pin-keypad');
}

export async function enterPin(page, pin) {
  for (const d of pin.split('')) await page.click(`[data-num="${d}"]`);
  await page.waitForSelector('.tt-app-shell');
}

export async function goToCount(page) {
  await page.click('[data-tab="count"]:visible');
  await page.waitForTimeout(150);
  // stocktake.js's mainKey/categoryKey are module state that persists
  // across sign-outs on the same page, so Count may already be showing
  // the milk cards (or the fridge sub-categories) from earlier in a test
  // — drill down only as far as still needed rather than assuming a
  // fresh section-grid every time.
  if (await page.locator('.tt-count-cards').count() > 0) return;
  if (await page.locator('[data-cat="milk"]').count() > 0) {
    await page.click('[data-cat="milk"]');
    await page.waitForSelector('.tt-count-cards');
    return;
  }
  await page.waitForSelector('.tt-section-grid');
  await page.click('[data-main="fridge"]');
  await page.waitForSelector('.tt-section-grid');
  await page.click('[data-cat="milk"]');
  await page.waitForSelector('.tt-count-cards');
}

export async function goToOrders(page) {
  await page.click('[data-tab="orders"]:visible');
  await page.waitForTimeout(200);
}

export async function goToReports(page) {
  await page.click('[data-tab="reports"]:visible');
  await page.waitForTimeout(200);
}

export async function goToCash(page) {
  await page.click('[data-tab="more"]:visible');
  await page.waitForSelector('.tt-more-menu');
  await page.click('[data-page="cash"]');
  await page.waitForTimeout(200);
}

export async function goToItems(page) {
  await page.click('[data-tab="more"]:visible');
  await page.waitForSelector('.tt-more-menu');
  await page.click('[data-page="items"]');
  await page.waitForSelector('#ttAddItemBtn');
}

/** Phase 5's anomaly-confirmation modal blocks commit() until dismissed. */
export async function dismissAnomalyIfShown(page) {
  const modal = page.locator('.tt-modal-overlay.show');
  if (await modal.count() > 0) await page.click('[data-action="confirm"]');
}

export function reportAndExit(check, label) {
  const failures = check.failures();
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}${label ? ' — ' + label : ''}`);
  process.exit(failures === 0 ? 0 : 1);
}
