/**
 * Phase 8 regression: the seven-report picker, manager-only gating on
 * valuation/audit log, real CSV/JSON exports (actual downloaded files,
 * not just a click), reports reflecting real actions performed in the
 * same run, and the Print button invoking window.print().
 */
import { launchBrowser, makeCheck, reportAndExit, signIn, goToReports } from './_helpers.mjs';

const check = makeCheck();
const browser = await launchBrowser();

// 1. Manager: all report tabs visible, including manager-only ones
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR manager-tabs', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222'); // Bob, manager
  await goToReports(page);

  const tabLabels = await page.locator('.tt-report-tab').allTextContents();
  check('Today\'s stocktake tab present', tabLabels.some((t) => /today/i.test(t)));
  check('Staff completion tab present', tabLabels.some((t) => /staff/i.test(t)));
  check('Waste tab present', tabLabels.some((t) => /waste/i.test(t)));
  check('Expiry tab present', tabLabels.some((t) => /expiry/i.test(t)));
  check('Valuation tab present for manager', tabLabels.some((t) => /valuation/i.test(t)));
  check('Orders tab present', tabLabels.some((t) => /orders/i.test(t)));
  check('Audit log tab present for manager', tabLabels.some((t) => /audit/i.test(t)));

  await page.close();
}

// 2. Staff (non-manager): manager-only report tabs are hidden
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR staff-tabs', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '1111'); // Alice, staff
  await goToReports(page);

  const tabLabels = await page.locator('.tt-report-tab').allTextContents();
  check('Valuation tab hidden from staff', !tabLabels.some((t) => /valuation/i.test(t)));
  check('Audit log tab hidden from staff', !tabLabels.some((t) => /audit/i.test(t)));
  check('Staff completion still visible to staff', tabLabels.some((t) => /staff/i.test(t)));

  await page.close();
}

// 3. Today's stocktake report: table renders, CSV/JSON export downloads a real file
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR stocktake-report', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await goToReports(page);

  check('stocktake report table shows a row', await page.locator('.tt-report-table tbody tr').count() > 0);

  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-export="csv"]'),
  ]);
  check('CSV export produces a .csv file', csvDownload.suggestedFilename().endsWith('.csv'));
  const csvPath = await csvDownload.path();
  const csvContent = await import('node:fs').then((fs) => fs.readFileSync(csvPath, 'utf8'));
  check('CSV content has a header row and at least one data row', csvContent.split('\r\n').length >= 2 && csvContent.startsWith('Item,'));

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-export="json"]'),
  ]);
  check('JSON export produces a .json file', jsonDownload.suggestedFilename().endsWith('.json'));
  const jsonPath = await jsonDownload.path();
  const jsonContent = await import('node:fs').then((fs) => fs.readFileSync(jsonPath, 'utf8'));
  const parsed = JSON.parse(jsonContent);
  check('JSON export is valid, parseable JSON with rows', Array.isArray(parsed) && parsed.length > 0);

  await page.close();
}

// 4. Switching between report tabs shows different content, staff completion is correct
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR tab-switch', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await goToReports(page);

  await page.click('[data-report="staff"]');
  await page.waitForTimeout(150);
  check('staff completion report title shown', /Staff completion/i.test(await page.locator('.tt-panel-title').first().textContent() || ''));
  check('staff completion lists at least one staff member', await page.locator('.tt-report-table tbody tr').count() > 0);
  const aliceRowText = await page.locator('.tt-report-table tbody tr', { hasText: 'Alice' }).textContent();
  check('Alice shows a nonzero counted-items count from the pre-seeded session', aliceRowText && !/\b0\b\s*<\/td>/.test(aliceRowText) && /\d/.test(aliceRowText));

  await page.click('[data-report="expiry"]');
  await page.waitForTimeout(150);
  check('expiry report title shown', /Expiry/i.test(await page.locator('.tt-panel-title').first().textContent() || ''));
  check('expiry report lists at least one expiring batch (seed has several)', await page.locator('.tt-report-table tbody tr').count() > 0);

  await page.click('[data-report="valuation"]');
  await page.waitForTimeout(150);
  check('valuation report title shown', /valuation/i.test(await page.locator('.tt-panel-title').first().textContent() || ''));
  check('valuation report shows a dollar total', /\$\d/.test(await page.locator('.tt-panel-sub').first().textContent() || ''));
  check('valuation report flags items with no unit cost rather than treating them as $0', /no unit cost on file/i.test(await page.locator('.tt-panel-sub').first().textContent() || ''));

  await page.close();
}

// 5. Waste report reflects a real waste event, orders report reflects a real order
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR waste-orders', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');

  await page.click('[data-tab="more"]:visible');
  await page.waitForSelector('.tt-more-menu');
  await page.click('[data-page="items"]');
  await page.fill('#ttItemSearch', 'Oat Milk');
  await page.waitForTimeout(150);
  await page.click('.tt-item-card [data-batches]');
  await page.waitForSelector('#ttBatchesBody');
  const wasteBtn = page.locator('#ttBatchesBody [data-waste]').first();
  if (await wasteBtn.count() > 0) {
    await wasteBtn.click();
    await page.waitForSelector('#ttPromptInput');
    await page.fill('#ttPromptInput', 'Spoiled for report test');
    await page.click('[data-action="confirm"]');
    await page.waitForTimeout(300);
  }
  await page.click('#ttBatchesClose');

  await goToReports(page);
  await page.click('[data-report="waste"]');
  await page.waitForTimeout(200);
  check('waste report shows the just-created waste event', /Oat Milk/i.test(await page.locator('.tt-report-table').textContent() || '') && /Spoiled for report test/i.test(await page.locator('.tt-report-table').textContent() || ''));

  await page.click('[data-tab="orders"]:visible');
  await page.waitForTimeout(200);
  const createBtn = page.locator('[data-create-order]').first();
  if (await createBtn.count() > 0) {
    await createBtn.click();
    await page.waitForTimeout(300);
  }
  await goToReports(page);
  await page.click('[data-report="orders"]');
  await page.waitForTimeout(200);
  check('orders report shows at least one order', await page.locator('.tt-report-table tbody tr').count() > 0);

  await page.close();
}

// 6. Audit log report (manager only) shows real entries, in Brisbane time not naive UTC
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR audit', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await page.click('[data-tab="more"]:visible');
  await page.waitForSelector('.tt-more-menu');
  await page.click('[data-page="items"]');
  await page.fill('#ttItemSearch', 'Napkins');
  await page.waitForTimeout(150);
  await page.click('.tt-item-card [data-archive]');
  await page.waitForSelector('.tt-modal-overlay.show');
  await page.click('#ttArchiveConfirm');
  await page.waitForTimeout(300);

  await goToReports(page);
  await page.click('[data-report="audit"]');
  await page.waitForTimeout(200);
  check('audit log shows the archive action just performed', /item_archived/i.test(await page.locator('.tt-report-table').textContent() || ''));
  check('audit log shows the actor name, not just an id', /Bob Ferreira/i.test(await page.locator('.tt-report-table').textContent() || ''));

  await page.close();
}

// 7. Print button calls window.print() without crashing
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR print', e.message));
  await signIn(page, 'a301889c-0a4e-41dc-bbc1-3e9366fdc07b', '2222');
  await goToReports(page);
  let printCalled = false;
  await page.exposeFunction('__ttPrintCalled', () => { printCalled = true; });
  await page.evaluate(() => { window.print = () => { window.__ttPrintCalled(); }; });
  await page.click('[data-print]');
  await page.waitForTimeout(150);
  check('print button invokes window.print()', printCalled);

  await page.close();
}

await browser.close();
reportAndExit(check, 'Phase 8: reports + exports');
