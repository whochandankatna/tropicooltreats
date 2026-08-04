/**
 * Phase 11 regression: PWA manifest/icons, service worker registration and
 * offline app-shell load, real online/offline detection driving the sync
 * pill, offline counting queued locally then synced on reconnect, Home's
 * offline/unsynced banner, Review blocking submission while offline, and
 * the full multi-staff conflict-resolution loop (an offline-queued count
 * that collides with someone else's live count on reconnect).
 */
import { BASE, launchBrowser, makeCheck, reportAndExit, signIn, signOutFlow, enterPin, goToCount, dismissAnomalyIfShown } from './_helpers.mjs';

const check = makeCheck();
const browser = await launchBrowser();

// 1. Manifest is valid, has real icons
{
  const res = await fetch(BASE.replace('index.html', 'manifest.webmanifest'));
  const manifest = await res.json();
  check('manifest has at least one icon', Array.isArray(manifest.icons) && manifest.icons.length > 0);
  check('manifest icon file is reachable', (await fetch(BASE.replace('index.html', 'icons/icon.svg'))).ok);
  check('manifest has a maskable icon purpose', manifest.icons.some((i) => i.purpose?.includes('maskable')));
}

// 2. Service worker registers and reaches "activated"
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR sw-register', e.message));
  await page.goto(BASE);
  await page.waitForTimeout(2000);
  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.state || 'no-active-worker';
  });
  check('service worker reaches activated state', state === 'activated');
  await page.close();
}

// 3. App shell actually loads offline after the service worker has cached it
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR offline-load', e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.tt-storepicker', { timeout: 10000 }).catch(() => {});
  check('store picker renders after a full reload while offline', await page.locator('.tt-storepicker').count() > 0);
  await context.setOffline(false);
  await page.close();
}

// 4. Real online/offline detection updates the sync pill
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR sync-pill', e.message));
  await signIn(page, 'store_mooloolaba', '2222');
  check('sync pill shows Live while online', (await page.locator('#ttSyncPill').textContent()).includes('Live'));

  await context.setOffline(true);
  await page.waitForTimeout(300);
  check('sync pill shows Offline once offline', (await page.locator('#ttSyncPill').textContent()).includes('Offline'));

  await context.setOffline(false);
  await page.waitForTimeout(300);
  check('sync pill shows Live again once back online', (await page.locator('#ttSyncPill').textContent()).includes('Live'));
  await page.close();
}

// 5. Counting while offline queues the count instead of saving immediately, then syncs on reconnect
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR offline-queue', e.message));
  await signIn(page, 'store_mooloolaba', '2222');
  await goToCount(page);

  await context.setOffline(true);
  await page.waitForTimeout(200);
  const oatCard = page.locator('.tt-count-card', { hasText: 'Oat Milk' });
  const input = oatCard.locator('.tt-qty-input');
  await input.fill('7');
  await input.dispatchEvent('change');
  await page.waitForTimeout(200);
  await dismissAnomalyIfShown(page); // 7 vs system stock 1 is a big jump, triggers Phase 5's anomaly confirm
  await page.waitForTimeout(200);
  check('offline commit shows Queued (offline), not Saving', /Queued \(offline\)/.test(await oatCard.locator('.tt-count-state-badge').textContent() || ''));
  check('offline toast explains the count is queued', /offline/i.test(await page.locator('.tt-toast.show').textContent() || '') && /queued/i.test(await page.locator('.tt-toast.show').textContent() || ''));

  await context.setOffline(false);
  await page.waitForTimeout(600);
  check('card flips to Counted once back online and synced', /Counted/.test(await oatCard.locator('.tt-count-state-badge').textContent() || ''));

  await page.close();
}

// 6. Home's offline/unsynced banner reflects a real queued count, then clears once synced
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR home-banner', e.message));
  await signIn(page, 'store_mooloolaba', '2222');
  await goToCount(page);
  await context.setOffline(true);
  await page.waitForTimeout(200);
  const card = page.locator('.tt-count-card', { hasText: 'Full Cream Milk' });
  const input = card.locator('.tt-qty-input');
  await input.fill('4');
  await input.dispatchEvent('change');
  await page.waitForTimeout(200);
  await dismissAnomalyIfShown(page);
  await page.waitForTimeout(200);

  await page.click('[data-tab="home"]:visible');
  await page.waitForTimeout(300);
  const bannerText = await page.locator('.tt-alert-banner').first().textContent().catch(() => '');
  check('Home shows a queued-count banner while offline', /queued/i.test(bannerText || ''));

  await context.setOffline(false);
  await page.waitForTimeout(600);
  await page.click('[data-tab="home"]:visible');
  await page.waitForTimeout(300);
  check('Home banner clears once the queued count has synced', await page.locator('.tt-alert-banner').count() === 0);

  await page.close();
}

// 7. Review screen blocks submission while offline
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR review-offline', e.message));
  await signIn(page, 'store_mooloolaba', '2222');
  await goToCount(page);
  await context.setOffline(true);
  await page.waitForTimeout(200);
  await page.waitForSelector('#ttReviewBtn2'); // the cards view has its own sticky Review & submit button
  await page.click('#ttReviewBtn2');
  await page.waitForSelector('.tt-modal-overlay.show');
  check('review modal explains being offline', /offline/i.test(await page.locator('.tt-modal').innerText()));
  check('submit button disabled while offline', await page.locator('#ttReviewSubmit').isDisabled());
  await context.setOffline(false);
  await page.close();
}

// 8. Full conflict-resolution loop: an offline-queued count that turns out
//    to conflict on sync gets a "Needs review" state and a working
//    "Review & recount" button that resolves it through the same
//    confirm+reason flow used everywhere else -- not silently dropped,
//    not auto-resolved without the user's say.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR conflict-flow', e.message));

  // Alice, offline, queues Full Cream Milk = 20
  await signIn(page, 'store_mooloolaba', '1111');
  await goToCount(page);
  await context.setOffline(true);
  await page.waitForTimeout(200);
  const milkCard = page.locator('.tt-count-card', { hasText: 'Full Cream Milk' });
  await milkCard.locator('.tt-qty-input').fill('20');
  await milkCard.locator('.tt-qty-input').dispatchEvent('change');
  await page.waitForTimeout(200);
  await dismissAnomalyIfShown(page); // 20 vs system 8 is a big jump
  await page.waitForTimeout(200);
  check('Alice\'s offline count for Full Cream Milk is queued', /Queued/.test(await milkCard.locator('.tt-count-state-badge').textContent() || ''));

  await signOutFlow(page);

  // Bob (manager), online, counts the same item for real
  await context.setOffline(false);
  await page.waitForTimeout(300);
  await enterPin(page, '2222');
  await goToCount(page);
  const milkCardBob = page.locator('.tt-count-card', { hasText: 'Full Cream Milk' });
  await milkCardBob.locator('.tt-qty-input').fill('9');
  await milkCardBob.locator('.tt-qty-input').dispatchEvent('change');
  await page.waitForTimeout(200);
  await dismissAnomalyIfShown(page);
  await page.waitForTimeout(300);
  check('Bob\'s live count for Full Cream Milk saved', /Counted/.test(await milkCardBob.locator('.tt-count-state-badge').textContent() || ''));

  await signOutFlow(page);

  // Alice signs back in offline (her queued draft is still on this device), then reconnects to trigger sync
  await context.setOffline(true);
  await page.waitForTimeout(200);
  await enterPin(page, '1111');
  await goToCount(page);
  await context.setOffline(false);
  await page.waitForTimeout(700);
  await page.click('[data-tab="home"]:visible'); // force a re-render pass
  await page.waitForTimeout(200);
  await goToCount(page);
  const milkCardConflict = page.locator('.tt-count-card', { hasText: 'Full Cream Milk' });
  check('the replayed count now shows Needs review, not silently lost or overwritten', /Needs review/.test(await milkCardConflict.locator('.tt-count-state-badge').textContent() || ''));
  check('a Review & recount button is offered', await milkCardConflict.locator('[data-resolve]').count() === 1);

  await milkCardConflict.locator('[data-resolve]').click();
  await page.waitForSelector('.tt-modal-overlay.show');
  check('conflict resolution reuses the same confirm dialog as a live conflict', /already counted/i.test(await page.locator('.tt-modal-body').textContent() || ''));
  await page.click('[data-action="confirm"]');
  await page.waitForSelector('#ttRecountReason');
  await page.fill('#ttRecountReason', 'Recounted after reconnecting, mine is correct');
  await page.click('[data-action="confirm"]');
  await page.waitForTimeout(400);
  check('resolved conflict shows Counted again', /Counted/.test(await milkCardConflict.locator('.tt-count-state-badge').textContent() || ''));

  await page.close();
}

await browser.close();
reportAndExit(check, 'Phase 11: offline queueing + PWA');
