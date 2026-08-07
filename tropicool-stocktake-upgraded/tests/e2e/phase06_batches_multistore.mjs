/**
 * Phase 6 regression: full item_master/store_inventory field split on the
 * add/edit forms, batch-level expiry (add/deplete/waste with an
 * accessible reason prompt, no native window.prompt), and multi-store
 * isolation (Noosa's smaller catalogue vs Mooloolaba's).
 */
import { launchBrowser, makeCheck, reportAndExit, signIn, goToItems } from './_helpers.mjs';

const check = makeCheck();
const browser = await launchBrowser();

// 1. New item-form fields save and round-trip through edit drawer
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR add-item', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222'); // Bob, manager
  await goToItems(page);
  await page.click('#ttAddItemBtn');
  await page.waitForSelector('.tt-modal-overlay.show');
  await page.fill('#ttNewName', 'Test Ripple Sauce');
  await page.fill('#ttNewUnit', 'bottles');
  await page.fill('#ttNewStock', '5');
  await page.fill('#ttNewReorder', '2');
  await page.fill('#ttNewTarget', '6');
  await page.fill('#ttNewSupplierName', 'Sweet Supplies Co');
  await page.fill('#ttNewSupplierUrl', 'https://sweetsupplies.example/order');
  await page.fill('#ttNewSupplierCode', 'SSC-RIP-1');
  await page.fill('#ttNewSupplierPackUnit', 'carton of 6');
  await page.fill('#ttNewPackConversion', '6');
  await page.fill('#ttNewUnitCost', '4.5');
  await page.fill('#ttNewLeadTime', '2');
  await page.fill('#ttNewSafetyStock', '1');
  await page.fill('#ttNewOrderPackSize', '1');
  await page.click('#ttNewCritical');
  await page.click('#ttAddConfirm');
  await page.waitForTimeout(250);
  check('new item toast confirms add', await page.locator('.tt-toast.show').textContent().then((t) => /added/i.test(t || '')));

  await page.fill('#ttItemSearch', 'Ripple');
  await page.waitForTimeout(150);
  const cardText = await page.locator('.tt-item-card').first().innerText();
  check('critical badge shown on new item card', /CRITICAL/.test(cardText));
  check('supplier name shown on new item card', /Sweet Supplies Co/.test(cardText));

  await page.click('.tt-item-card [data-edit]');
  await page.waitForSelector('.tt-modal-overlay.show');
  check('unit cost round-tripped', await page.inputValue('#ttEditUnitCost') === '4.5');
  check('lead time round-tripped', await page.inputValue('#ttEditLeadTime') === '2');
  check('supplier pack unit round-tripped', await page.inputValue('#ttEditSupplierPackUnit') === 'carton of 6');
  check('critical checkbox round-tripped as checked', await page.isChecked('#ttEditCritical'));
  await page.click('#ttEditCancel');

  await page.close();
}

// 2. Batch management: add, mark used up, mark wasted with reason (no native prompt)
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR batches', e.message));
  let nativeDialogFired = false;
  page.on('dialog', async (d) => { nativeDialogFired = true; await d.dismiss(); });
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await goToItems(page);
  await page.fill('#ttItemSearch', 'Oat Milk');
  await page.waitForTimeout(150);
  await page.click('.tt-item-card [data-batches]');
  await page.waitForSelector('#ttBatchesBody');

  const beforeRows = await page.locator('#ttBatchesBody .tt-list-row').count();

  await page.fill('#ttBatchQty', '10');
  await page.fill('#ttBatchUseBy', '2026-09-01');
  await page.fill('#ttBatchRef', 'DEL-TEST-1');
  await page.click('#ttBatchAdd');
  await page.waitForTimeout(250);
  const afterAddRows = await page.locator('#ttBatchesBody .tt-list-row').count();
  check('batch count increased after add', afterAddRows === beforeRows + 1);
  check('new batch shows delivery reference', /DEL-TEST-1/.test(await page.locator('#ttBatchesBody').innerText()));

  const usedUpBtn = page.locator('#ttBatchesBody .tt-list-row', { hasText: 'DEL-TEST-1' }).locator('[data-deplete]');
  await usedUpBtn.click();
  await page.waitForTimeout(250);
  const afterDepleteRows = await page.locator('#ttBatchesBody .tt-list-row').count();
  check('batch count decreased after marking used up', afterDepleteRows === afterAddRows - 1);

  await page.fill('#ttBatchQty', '3');
  await page.fill('#ttBatchRef', 'DEL-TEST-2');
  await page.click('#ttBatchAdd');
  await page.waitForTimeout(250);
  const wasteBtn = page.locator('#ttBatchesBody .tt-list-row', { hasText: 'DEL-TEST-2' }).locator('[data-waste]');
  await wasteBtn.click();
  await page.waitForSelector('#ttPromptInput');
  check('no native window.prompt fired for waste reason', !nativeDialogFired);

  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(150);
  check('empty waste reason blocked with inline error', /required/i.test(await page.locator('#ttPromptError').textContent() || ''));

  await page.fill('#ttPromptInput', 'Spoiled - left out overnight');
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(300);
  check('batches modal reopened after waste reason submitted', await page.locator('#ttBatchesBody').isVisible());
  check('wasted batch removed from open batches list', !/DEL-TEST-2/.test(await page.locator('#ttBatchesBody').innerText()));

  await page.close();
}

// 3. Multi-store isolation: Sunnybank manager sees only Sunnybank's 4 seeded items
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR sunnybank', e.message));
  // Sunnybank's real stores.id (config.js's STORES is the single source of
  // truth for both mock and real-backend mode, see Phase 13) -- Deepak Rao,
  // Sunnybank manager.
  await signIn(page, 'b27792bd-9d5e-4aba-8561-a830d3e6589e', '4444');
  await goToItems(page);
  await page.waitForTimeout(200);
  check('Sunnybank shows exactly its 4 seeded items', await page.locator('.tt-item-card').count() === 4);
  const allText = await page.locator('.tt-item-cards').innerText();
  check('Sunnybank item list does not include Mooloolaba-only item (Crushed Nuts)', !/Crushed Nuts/.test(allText));
  check('Sunnybank item list includes its own seeded item (Waffle Cones)', /Waffle Cones/.test(allText));

  await page.fill('#ttItemSearch', 'Ripple');
  await page.waitForTimeout(150);
  check('Mooloolaba-only new item not visible at Sunnybank', /No items match/.test(await page.locator('.tt-item-cards').innerText()));

  await page.close();
}

await browser.close();
reportAndExit(check, 'Phase 6: inventory model split + batch expiry');
