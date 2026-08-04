/**
 * Entry point: boots the mock data layer, handles store selection + PIN
 * lock, then mounts the 5-tab shell and routes renders to each tab module.
 */
import { initDatabase, onChange } from './database.js';
import { restoreSession, getSession, onSessionChange, renderPinLock } from './auth.js';
import { STORES } from './config.js';
import { TABS, getActiveTab, setActiveTab, onTabChange, renderBottomNav, renderSidebar, bindNav } from './nav.js';
import { esc, icon } from './ui.js';
import { renderHome } from './home.js';
import { renderCount } from './stocktake.js';
import { renderOrders } from './orders.js';
import { renderReports } from './reports.js';
import { renderMore } from './more.js';

const appRoot = document.getElementById('ttApp');
let selectedStoreId = null;

async function boot() {
  await initDatabase();
  restoreSession();
  render();
  onSessionChange(render);
  onTabChange(renderContentOnly);
  onChange(() => { if (getSession()) renderContentOnly(); });
}

function render() {
  const session = getSession();
  if (!session) return renderStorePickerOrLock();
  renderShell();
}

function renderStorePickerOrLock() {
  if (!selectedStoreId) {
    appRoot.innerHTML = `
      <main class="tt-storepicker">
        <div class="tt-splash-logo">TT</div>
        <h1 class="tt-storepicker-title">Tropicool Treats</h1>
        <div class="tt-storepicker-sub">Choose your store</div>
        <div class="tt-storepicker-list">
          ${STORES.map((s) => `<button class="tt-storepicker-btn" data-store="${s.id}">${esc(s.name)}</button>`).join('')}
        </div>
      </main>`;
    appRoot.querySelectorAll('[data-store]').forEach((btn) => btn.addEventListener('click', () => {
      selectedStoreId = btn.dataset.store;
      render();
    }));
    return;
  }
  appRoot.innerHTML = `<main id="ttPinLockRoot"></main>`;
  renderPinLock(document.getElementById('ttPinLockRoot'), selectedStoreId);
}

function renderShell() {
  const session = getSession();
  appRoot.innerHTML = `
    <a class="tt-skip-link" href="#ttContent">Skip to content</a>
    <div class="tt-app-shell">
      ${renderSidebar()}
      <div class="tt-main-col">
        <header class="tt-topbar">
          <h1 class="tt-topbar-title">${esc(tabLabel())}</h1>
          <div class="tt-topbar-right">
            <span class="tt-sync-pill live" role="status" aria-live="polite">${icon('wifi', 13)} <span id="ttSyncLabel">Live</span></span>
          </div>
        </header>
        <main class="tt-content" id="ttContent" tabindex="-1"></main>
      </div>
      ${renderBottomNav()}
    </div>
  `;
  bindNav(appRoot, () => renderShell());
  renderContentOnly();
}

function tabLabel() {
  return TABS.find((t) => t.key === getActiveTab())?.label || '';
}

async function renderContentOnly() {
  const content = document.getElementById('ttContent');
  const topbarTitle = document.querySelector('.tt-topbar-title');
  if (!content) return renderShell();
  if (topbarTitle) topbarTitle.textContent = tabLabel();
  document.querySelectorAll('[data-tab]').forEach((el) => {
    const active = el.dataset.tab === getActiveTab();
    el.classList.toggle('active', active);
    el.setAttribute('aria-current', active ? 'page' : 'false');
  });

  const session = getSession();
  const tab = getActiveTab();
  if (tab === 'home') return renderHome(content);
  if (tab === 'count') return renderCount(content);
  if (tab === 'orders') return renderOrders(content);
  if (tab === 'reports') return renderReports(content);
  if (tab === 'more') return renderMore(content);
}

boot();
