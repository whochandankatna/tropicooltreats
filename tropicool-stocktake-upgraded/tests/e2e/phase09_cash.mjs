/**
 * Phase 9 regression: the cash-count redesign — denomination calculator,
 * save/history with variance and manager approval, breakdown modal,
 * same-slot recount via the accessible reason prompt, validation (zero
 * total, missing register), manager-only history visibility, and
 * cross-staff protection on a contested register/shift/day.
 */
import { launchBrowser, makeCheck, reportAndExit, signIn as signInStore, signOutFlow, enterPin, goToCash } from './_helpers.mjs';

const check = makeCheck();
const browser = await launchBrowser();
const signIn = (page, pin) => signInStore(page, 'store_mooloolaba', pin);

async function fillDenoms(page, counts) {
  for (const [key, qty] of Object.entries(counts)) {
    await page.fill(`[data-denom="${key}"]`, String(qty));
  }
}

let nativeDialogFired = false;

// 1. Denomination calculator computes the live total correctly, no manual arithmetic
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR calc', e.message));
  await signIn(page, '2222'); // Bob, manager
  await goToCash(page);

  check('all 11 AUD denominations present', await page.locator('[data-denom]').count() === 11);
  // 2 x $50 + 3 x $20 + 4 x $2 = 100 + 60 + 8 = 168.00
  await fillDenoms(page, { d50: 2, d20: 3, d2: 4 });
  await page.waitForTimeout(150);
  check('live total computed correctly from denominations', (await page.locator('#ttCashLiveTotal').textContent()).trim() === '$168.00');

  await page.close();
}

// 2. Save a cash count (register/shift/expected/notes), appears in manager history with variance
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR save', e.message));
  await signIn(page, '2222');
  await goToCash(page);

  await page.fill('#ttCashRegister', 'Front counter');
  await page.selectOption('#ttCashShift', 'open');
  await page.fill('#ttCashExpected', '150.00');
  await fillDenoms(page, { d50: 3 }); // $150.00 counted, matches expected exactly
  await page.click('#ttSaveCash');
  await page.waitForTimeout(300);
  check('save toast confirms', /Cash count saved/i.test(await page.locator('.tt-toast.show').textContent() || ''));

  const historyPanel = page.locator('.tt-panel', { has: page.locator('.tt-panel-title', { hasText: 'History (by register' }) });
  check('history shows the counted total', /\$150\.00/.test(await historyPanel.innerText()));
  check('exact match shows no red/negative variance styling', (await historyPanel.innerText()).includes('vs expected') === false || !/(-\$?\d)/.test(await historyPanel.innerText()));

  await page.close();
}

// 3. Variance is shown (not silently absorbed) and needs-approval / approve flow works
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR variance', e.message));
  await signIn(page, '2222');
  await goToCash(page);

  await page.fill('#ttCashRegister', 'Back counter');
  await page.selectOption('#ttCashShift', 'close');
  await page.fill('#ttCashExpected', '100.00');
  await fillDenoms(page, { d50: 1, d20: 2 }); // $90 counted vs $100 expected -> -$10 variance
  await page.click('#ttSaveCash');
  await page.waitForTimeout(300);

  const historyPanel = page.locator('.tt-panel', { has: page.locator('.tt-panel-title', { hasText: 'History (by register' }) });
  check('variance vs expected is shown, not hidden', /vs expected/i.test(await historyPanel.innerText()));
  check('needs approval shown before approving', /Needs approval/i.test(await historyPanel.innerText()));

  await page.locator('[data-approve]').first().click();
  await page.waitForTimeout(300);
  check('approved toast shown', /approved/i.test(await page.locator('.tt-toast.show').textContent() || ''));
  check('history now shows approved by the manager', /Approved by Bob Ferreira/i.test(await historyPanel.innerText()));

  await page.close();
}

// 4. Breakdown modal shows exactly the denominations entered
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR breakdown', e.message));
  await signIn(page, '2222');
  await goToCash(page);

  await page.fill('#ttCashRegister', 'Kiosk');
  await page.selectOption('#ttCashShift', 'open');
  await fillDenoms(page, { d10: 5, c50: 6 }); // $50 + $3 = $53
  await page.click('#ttSaveCash');
  await page.waitForTimeout(300);

  await page.locator('[data-breakdown]').first().click();
  await page.waitForSelector('.tt-modal-overlay.show');
  const modalText = await page.locator('.tt-modal').innerText();
  check('breakdown shows $10 x 5', /\$10.*5/.test(modalText));
  check('breakdown shows 50c x 6', /50c.*6/.test(modalText));
  check('breakdown does not show a zero-quantity denomination', !/\$100/.test(modalText));

  await page.close();
}

// 5. Recount flow: same staff resaving the same register/shift/day requires a reason via accessible prompt
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR recount', e.message));
  page.on('dialog', async (d) => { nativeDialogFired = true; await d.dismiss(); });
  await signIn(page, '2222');
  await goToCash(page);

  await page.fill('#ttCashRegister', 'Drive-thru');
  await page.selectOption('#ttCashShift', 'close');
  await fillDenoms(page, { d20: 5 }); // $100
  await page.click('#ttSaveCash');
  await page.waitForTimeout(300);

  // Save again for the exact same register/shift/day -- should trigger the conflict flow
  await page.fill('#ttCashRegister', 'Drive-thru');
  await page.selectOption('#ttCashShift', 'close');
  await fillDenoms(page, { d20: 6 }); // $120, a genuine recount
  await page.click('#ttSaveCash');
  await page.waitForSelector('.tt-modal-overlay.show');
  check('conflict confirm dialog appears for same-day resave', /already.*counted/i.test(await page.locator('.tt-modal-body').textContent() || ''));
  await page.click('[data-action="confirm"]');
  await page.waitForSelector('#ttPromptInput');
  check('no native window.prompt fired for recount reason', !nativeDialogFired);
  // Try confirming with an empty reason first -- should be blocked inline
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(150);
  check('empty recount reason blocked inline', /required/i.test(await page.locator('#ttPromptError').textContent() || ''));

  await page.fill('#ttPromptInput', 'Recounted after a note was found under the till');
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(300);
  check('recount saved toast shown', /Cash count saved/i.test(await page.locator('.tt-toast.show').textContent() || ''));

  const historyPanel = page.locator('.tt-panel', { has: page.locator('.tt-panel-title', { hasText: 'History (by register' }) });
  check('history shows the new recounted total ($120.00)', /\$120\.00/.test(await historyPanel.innerText()));
  check('history flags the entry as a recount', /recount/i.test(await historyPanel.innerText()));

  await page.close();
}

// 6. Zero-total save is rejected (can't count a drawer as literally $0 of anything selected)
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR zero', e.message));
  await signIn(page, '2222');
  await goToCash(page);

  await page.fill('#ttCashRegister', 'Empty register');
  await page.selectOption('#ttCashShift', 'open');
  await page.click('#ttSaveCash');
  await page.waitForTimeout(200);
  check('zero-denomination save rejected with inline error', /can.t be zero/i.test(await page.locator('#ttCashError').textContent() || ''));

  await page.close();
}

// 7. Missing register name is rejected
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR noregister', e.message));
  await signIn(page, '2222');
  await goToCash(page);

  await page.selectOption('#ttCashShift', 'open');
  await fillDenoms(page, { d5: 1 });
  await page.click('#ttSaveCash');
  await page.waitForTimeout(200);
  check('missing register name rejected', /register/i.test(await page.locator('#ttCashError').textContent() || ''));

  await page.close();
}

// 8. Staff (non-manager) never sees cash history, even after saving a count themselves
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR staff-view', e.message));
  await signIn(page, '1111'); // Alice, staff
  await goToCash(page);

  check('staff sees the denomination form', await page.locator('[data-denom]').count() === 11);
  check('staff does NOT see cash history panel', await page.locator('.tt-panel', { has: page.locator('.tt-panel-title', { hasText: 'History (by register' }) }).count() === 0);
  check('staff sees a message that history is manager-only', /manager/i.test(await page.locator('.tt-empty').last().textContent() || ''));

  await page.fill('#ttCashRegister', 'Staff test register');
  await page.selectOption('#ttCashShift', 'open');
  await fillDenoms(page, { d10: 2 });
  await page.click('#ttSaveCash');
  await page.waitForTimeout(300);
  check('staff can still save a count despite no history access', /Cash count saved/i.test(await page.locator('.tt-toast.show').textContent() || ''));
  check('history still hidden after saving', await page.locator('.tt-panel', { has: page.locator('.tt-panel-title', { hasText: 'History (by register' }) }).count() === 0);

  await page.close();
}

// 9. Different staff member cannot recount someone else's register/shift/day directly.
//    Must happen in ONE page/tab, not two -- the mock's in-memory state is
//    per-page-load, so two separate newPage() + goto() calls would each get
//    their own fresh seed and never actually collide. Switch users via the
//    real sign-out flow instead, which keeps the same JS module state.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR cross-staff', e.message));
  await signIn(page, '1111'); // Alice, staff
  await goToCash(page);
  await page.fill('#ttCashRegister', 'Contested register');
  await page.selectOption('#ttCashShift', 'open');
  await fillDenoms(page, { d10: 1 });
  await page.click('#ttSaveCash');
  await page.waitForTimeout(300);

  await signOutFlow(page);
  await enterPin(page, '3333'); // Chloe, a different staff member, same store
  await goToCash(page);
  await page.fill('#ttCashRegister', 'Contested register');
  await page.selectOption('#ttCashShift', 'open');
  await fillDenoms(page, { d10: 2 });
  await page.click('#ttSaveCash');
  await page.waitForTimeout(300);
  check('a different staff member is blocked from overriding someone else\'s count, told to get a manager', /manager/i.test(await page.locator('#ttCashError').textContent() || ''));

  await page.close();
}

await browser.close();
reportAndExit(check, 'Phase 9: cash count redesign');
