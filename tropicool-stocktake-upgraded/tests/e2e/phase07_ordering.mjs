/**
 * Phase 7 regression: needs-ordering list grouped by supplier with a
 * suggested quantity, the full draft -> sent -> received order lifecycle
 * (receiving bumps stock and can open a batch), draft-order line editing,
 * cancellation via an accessible reason prompt, and read-only access for
 * non-managers.
 */
import { launchBrowser, makeCheck, reportAndExit, signIn, goToOrders } from './_helpers.mjs';

const check = makeCheck();
const browser = await launchBrowser();
let dialogFired = false;

// 1. Manager: needs-ordering list shows suggested qty, checkboxes, and a create-order flow
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR order-create', e.message));
  page.on('dialog', async (d) => { dialogFired = true; await d.dismiss(); });
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222'); // Bob, manager
  await goToOrders(page);

  check('needs-ordering panel is visible', await page.locator('.tt-order-header').isVisible());
  check('at least one supplier group shown', await page.locator('.tt-order-group-title').count() > 0);

  const line = page.locator('.tt-order-line-row', { hasText: 'Chocolate Sauce' });
  check('Chocolate Sauce appears in needs-ordering', await line.count() > 0);
  const qtyInput = line.locator('[data-qty]');
  check('a suggested quantity is prefilled and greater than zero', Number(await qtyInput.inputValue()) > 0);

  const groupTitle = await line.locator('xpath=ancestor::div[contains(@class,"tt-panel")][1]').locator('.tt-order-group-title span').first().textContent();
  const createBtn = page.locator('.tt-panel', { has: page.locator('.tt-order-group-title', { hasText: groupTitle }) }).locator('[data-create-order]');
  await createBtn.click();
  await page.waitForTimeout(300);
  check('draft order created toast shown', /Draft order created/i.test(await page.locator('.tt-toast.show').textContent() || ''));

  const historyRow = page.locator('.tt-order-history-row').first();
  check('order history shows the new draft', /draft/i.test(await historyRow.locator('.tt-status-badge').textContent() || ''));

  await page.close();
}

// 2. Full order lifecycle: open draft, edit qty, mark sent, receive with a use-by date, confirm stock bumped
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR order-lifecycle', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await goToOrders(page);

  const beforeLine = page.locator('.tt-order-line-row', { hasText: 'Frozen Blueberries' });
  check('Frozen Blueberries is in needs-ordering before the order', await beforeLine.count() > 0);
  await beforeLine.locator('[data-qty]').fill('5');
  const groupTitle2 = await beforeLine.locator('xpath=ancestor::div[contains(@class,"tt-panel")][1]').locator('.tt-order-group-title span').first().textContent();
  await page.locator('.tt-panel', { has: page.locator('.tt-order-group-title', { hasText: groupTitle2 }) }).locator('[data-create-order]').click();
  await page.waitForTimeout(300);

  await page.locator('.tt-order-history-row').first().click();
  await page.waitForSelector('#tt-order-title');
  check('order detail modal shows draft status', /draft/i.test(await page.locator('.tt-status-badge').first().textContent() || ''));

  await page.click('[data-action="send-order"]');
  await page.waitForSelector('.tt-modal-overlay.show');
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(300);
  check('no native browser dialog used for send confirmation', !dialogFired);

  await page.locator('.tt-order-history-row').first().click();
  await page.waitForSelector('#tt-order-title');
  check('order detail modal shows sent status after marking sent', /sent/i.test(await page.locator('.tt-status-badge').first().textContent() || ''));
  await page.click('[data-action="receive-order"]');
  await page.waitForSelector('#tt-receive-title');
  const blueberryRow = page.locator('.tt-receive-row', { hasText: 'Frozen Blueberries' });
  check('receive modal defaults quantity to what was ordered', await blueberryRow.locator('[data-receive-qty]').inputValue() === '5');
  await blueberryRow.locator('[data-receive-useby]').fill('2026-09-15');
  await page.click('#ttReceiveConfirm');
  await page.waitForTimeout(300);
  check('received toast confirms stock updated', /received, stock updated/i.test(await page.locator('.tt-toast.show').textContent() || ''));
  check('order history shows received status', /received/i.test(await page.locator('.tt-order-history-row').first().locator('.tt-status-badge').textContent() || ''));

  await page.click('[data-tab="more"]:visible');
  await page.waitForSelector('.tt-more-menu');
  await page.click('[data-page="items"]');
  await page.fill('#ttItemSearch', 'Frozen Blueberries');
  await page.waitForTimeout(150);
  const cardText = await page.locator('.tt-item-card').first().innerText();
  check('on-hand stock reflects the received delivery (6.2 kg)', /6\.2\s*kg/i.test(cardText));

  await page.click('.tt-item-card [data-batches]');
  await page.waitForSelector('#ttBatchesBody');
  check('receiving with a use-by date created a batch', /Received/i.test(await page.locator('#ttBatchesBody').innerText()));

  await page.close();
}

// 3. Draft order editing: remove a line, and cannot remove the last line
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR order-edit', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await goToOrders(page);

  const cupsLine = page.locator('.tt-order-line-row', { hasText: 'Cups (Regular)' });
  const oatLine = page.locator('.tt-order-line-row', { hasText: 'Oat Milk' });
  check('Cups (Regular) is in needs-ordering', await cupsLine.count() > 0);
  check('Oat Milk is in needs-ordering', await oatLine.count() > 0);

  const cupsGroup = await cupsLine.locator('xpath=ancestor::div[contains(@class,"tt-panel")][1]').locator('.tt-order-group-title span').first().textContent();
  const oatGroup = await oatLine.locator('xpath=ancestor::div[contains(@class,"tt-panel")][1]').locator('.tt-order-group-title span').first().textContent();

  if (cupsGroup === oatGroup) {
    await page.locator('.tt-panel', { has: page.locator('.tt-order-group-title', { hasText: cupsGroup }) }).locator('[data-create-order]').click();
    await page.waitForTimeout(300);
    await page.locator('.tt-order-history-row').first().click();
    await page.waitForSelector('#tt-order-title');
    const lineCountBefore = await page.locator('#ttOrderLines .tt-order-line-row').count();
    check('draft order has at least 2 lines to test removal', lineCountBefore >= 2);
    await page.locator('#ttOrderLines [data-line-remove]').first().click();
    await page.waitForTimeout(300);
    const lineCountAfter = await page.locator('#ttOrderLines .tt-order-line-row').count();
    check('removing a line decreases the count by one', lineCountAfter === lineCountBefore - 1);

    while ((await page.locator('#ttOrderLines .tt-order-line-row').count()) > 1) {
      await page.locator('#ttOrderLines [data-line-remove]').first().click();
      await page.waitForTimeout(250);
    }
    await page.locator('#ttOrderLines [data-line-remove]').first().click();
    await page.waitForTimeout(200);
    check('cannot remove the last remaining line', /cancel the order/i.test(await page.locator('#ttOrderError').textContent() || ''));
  } else {
    console.log('SKIP - Cups (Regular) and Oat Milk landed in different supplier groups this seed, skipping multi-line removal test');
  }

  await page.close();
}

// 4. Cancel a draft order with a reason via the accessible prompt (not window.prompt)
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR order-cancel', e.message));
  let nativeDialogFired = false;
  page.on('dialog', async (d) => { nativeDialogFired = true; await d.dismiss(); });
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await goToOrders(page);

  const napkinsLine = page.locator('.tt-order-line-row', { hasText: 'Cups (Large)' });
  let targetLine = napkinsLine;
  if (await napkinsLine.count() === 0) targetLine = page.locator('.tt-order-line-row').first();
  const groupTitle = await targetLine.locator('xpath=ancestor::div[contains(@class,"tt-panel")][1]').locator('.tt-order-group-title span').first().textContent();
  await page.locator('.tt-panel', { has: page.locator('.tt-order-group-title', { hasText: groupTitle }) }).locator('[data-create-order]').click();
  await page.waitForTimeout(300);
  await page.locator('.tt-order-history-row').first().click();
  await page.waitForSelector('#tt-order-title');
  await page.click('[data-action="cancel-order"]');
  await page.waitForSelector('#ttPromptInput');
  check('no native window.prompt fired for cancel reason', !nativeDialogFired);
  await page.fill('#ttPromptInput', 'Ordered by mistake');
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(300);
  check('cancelled toast shown', /Order cancelled/i.test(await page.locator('.tt-toast.show').textContent() || ''));
  check('order history shows cancelled status', /cancelled/i.test(await page.locator('.tt-order-history-row').first().locator('.tt-status-badge').textContent() || ''));

  await page.close();
}

// 5. Staff (non-manager) sees read-only needs-ordering, no create/edit controls
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR staff-view', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '1111'); // Alice, staff
  await goToOrders(page);

  check('staff sees no create-order buttons', await page.locator('[data-create-order]').count() === 0);
  check('staff sees no order line checkboxes', await page.locator('[data-select]').count() === 0);
  if (await page.locator('.tt-order-history-row').count() > 0) {
    await page.locator('.tt-order-history-row').first().click();
    await page.waitForSelector('#tt-order-title');
    check('staff sees no send/cancel/receive action buttons in order detail', await page.locator('[data-action]').count() === 0);
  }

  await page.close();
}

await browser.close();
reportAndExit(check, 'Phase 7: ordering workflow');
