/**
 * Phase 5 regression: validation (duplicate names, missing units, unsafe
 * URLs, max/reorder ordering) plus anomaly confirmation, the in-modal
 * recount-conflict flow, incomplete-section acknowledgment, and
 * undo-after-archive.
 */
import { BASE, launchBrowser, makeCheck, reportAndExit, signIn as signInStore, goToItems, goToCount } from './_helpers.mjs';

const check = makeCheck();
const browser = await launchBrowser();
const signIn = (page, pin) => signInStore(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', pin);

// 1. Duplicate item name rejected
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await signIn(page, '2222'); // Bob, manager
  await goToItems(page);
  await page.click('#ttAddItemBtn');
  await page.waitForSelector('.tt-modal-overlay.show');
  await page.fill('#ttNewName', 'Full Cream Milk'); // already exists in seed
  await page.fill('#ttNewUnit', 'litres');
  await page.click('#ttAddConfirm');
  await page.waitForTimeout(200);
  const err = await page.locator('#ttAddError').textContent();
  check('duplicate name rejected with message', /already an item/i.test(err || ''));

  await page.fill('#ttNewName', 'Brand New Thing');
  await page.fill('#ttNewUnit', '');
  await page.click('#ttAddConfirm');
  await page.waitForTimeout(200);
  const err2 = await page.locator('#ttAddError').textContent();
  check('missing unit rejected', /unit/i.test(err2 || ''));

  await page.fill('#ttNewUnit', 'boxes');
  await page.fill('#ttNewSupplierUrl', 'javascript:alert(1)');
  await page.click('#ttAddConfirm');
  await page.waitForTimeout(200);
  const err3 = await page.locator('#ttAddError').textContent();
  check('javascript: URL rejected', /http/i.test(err3 || ''));

  await page.fill('#ttNewSupplierUrl', 'https://example.com/supplier');
  await page.fill('#ttNewSupplierName', '');
  await page.click('#ttAddConfirm');
  await page.waitForTimeout(200);
  const err4 = await page.locator('#ttAddError').textContent();
  check('supplier URL without name rejected', /supplier name/i.test(err4 || ''));

  await page.fill('#ttNewSupplierName', 'Acme Co');
  await page.click('#ttAddConfirm');
  await page.waitForTimeout(300);
  check('valid item add succeeds (modal closes)', await page.locator('.tt-modal-overlay.show').count() === 0);

  await page.click('#ttAddItemBtn');
  await page.waitForSelector('.tt-modal-overlay.show');
  await page.fill('#ttNewName', 'Another Item');
  await page.fill('#ttNewUnit', 'kg');
  await page.fill('#ttNewReorder', '10');
  await page.fill('#ttNewMax', '5');
  await page.click('#ttAddConfirm');
  await page.waitForTimeout(200);
  const err5 = await page.locator('#ttAddError').textContent();
  check('max <= reorder rejected', /max level/i.test(err5 || ''));

  await page.close();
}

// 2. Anomaly confirmation on large variance
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('dialog', (d) => d.dismiss());
  await signIn(page, '1111'); // Alice
  await goToCount(page);

  // Full Cream Milk system qty = 8. Enter 50 -> anomaly modal should appear
  const input = page.locator('.tt-count-card').first().locator('.tt-qty-input');
  await input.fill('50');
  await input.dispatchEvent('change');
  await page.waitForSelector('.tt-modal-overlay.show', { timeout: 3000 });
  const modalText = await page.locator('.tt-modal').textContent();
  check('anomaly modal appears for large variance', /Double check|higher than the system/i.test(modalText));
  await page.click('[data-action="cancel"]');
  await page.waitForTimeout(200);
  check('anomaly modal closes on cancel, no save happens', await page.locator('.tt-modal-overlay.show').count() === 0);
  const badgeText = await page.locator('.tt-count-card').first().locator('.tt-count-state-badge').textContent();
  check('card still shows not counted after cancelling anomaly', /NOT COUNTED/i.test(badgeText));

  await input.fill('50');
  await input.dispatchEvent('change');
  await page.waitForSelector('.tt-modal-overlay.show', { timeout: 3000 });
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(300);
  const badgeText2 = await page.locator('.tt-count-card').first().locator('.tt-count-state-badge').textContent();
  check('card shows counted after confirming anomaly', /Counted/i.test(badgeText2));

  await page.close();
}

// 3. Recount conflict uses in-modal reason field (not window.prompt)
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let nativeDialogFired = false;
  page.on('dialog', (d) => { nativeDialogFired = true; d.dismiss(); });
  await signIn(page, '2222'); // Bob (manager) - recounts an item Alice already has current from seed data
  await page.click('[data-tab="count"]:visible');
  await page.waitForSelector('.tt-section-grid');
  await page.click('[data-main="fridge"]');
  await page.waitForSelector('.tt-section-grid');
  await page.click('[data-cat="premix"]');
  await page.waitForSelector('.tt-count-cards');
  // Vanilla Gelato Base was pre-counted by Alice in the seed (idx 0)
  const input = page.locator('.tt-count-card').first().locator('.tt-qty-input');
  await input.fill('5');
  await input.dispatchEvent('change');
  await page.waitForSelector('.tt-modal-overlay.show', { timeout: 3000 });
  const conflictText = await page.locator('.tt-modal').textContent();
  check('conflict modal appears for different-staff recount', /already counted/i.test(conflictText));
  await page.click('[data-action="confirm"]'); // "Recount anyway"
  await page.waitForSelector('#ttRecountReason', { timeout: 3000 });
  check('in-modal recount reason field appears (not window.prompt)', true);
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(150);
  const recountErr = await page.locator('#ttRecountError').textContent();
  check('empty recount reason rejected in-modal', /reason is required/i.test(recountErr || ''));
  await page.fill('#ttRecountReason', 'Manager spot-check recount');
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(300);
  check('no native browser dialog was used for the recount reason', !nativeDialogFired);
  const badge = await page.locator('.tt-count-card').first().locator('.tt-count-state-badge').textContent();
  check('recount saved successfully', /Counted/i.test(badge));
  await page.close();
}

// 4. Incomplete-section acknowledgment required before submit
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await signIn(page, '1111');
  await page.click('[data-tab="count"]:visible');
  await page.waitForSelector('.tt-section-grid');
  await page.click('#ttReviewBtn');
  await page.waitForSelector('.tt-modal-overlay.show');
  check('submit disabled with uncounted items and no ack', await page.locator('#ttReviewSubmit').isDisabled());
  await page.click('#ttAckIncomplete');
  await page.waitForTimeout(100);
  check('submit enabled after acknowledging incomplete items', await page.locator('#ttReviewSubmit').isEnabled());
  await page.close();
}

// 5. Undo after archive
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await signIn(page, '2222');
  await goToItems(page);
  await page.waitForSelector('[data-archive]');
  const firstName = await page.locator('[data-archive]').first().getAttribute('data-name');
  await page.locator('[data-archive]').first().click();
  await page.waitForSelector('.tt-modal-overlay.show');
  const title = await page.locator('.tt-modal-title').textContent();
  check('archive dialog shows item name', title.includes(firstName));
  await page.click('#ttArchiveConfirm');
  await page.waitForSelector('.tt-toast.show', { timeout: 3000 });
  const toastText = await page.locator('.tt-toast').textContent();
  check('toast offers Undo action', /Undo/i.test(toastText));
  await page.click('.tt-toast-action');
  await page.waitForTimeout(300);
  check('item restored via Undo', await page.locator(`[data-name="${firstName}"]`).count() > 0);
  await page.close();
}

await browser.close();
reportAndExit(check, 'Phase 5: error prevention + anomaly confirmation');
