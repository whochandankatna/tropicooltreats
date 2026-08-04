/**
 * More tab — everything that isn't a top-5 daily action lives here
 * (Priority 3): Items, Staff, Roster, Cash, Announcements, plus sign out.
 */
import { getSession, signOut } from './auth.js';
import { renderItems } from './items.js';
import { renderStaff } from './staff.js';
import { renderRoster } from './roster.js';
import { renderCash } from './cash.js';
import { renderAnnouncements } from './announcements.js';
import { icon, esc, confirmDialog } from './ui.js';

const PAGES = [
  { key: 'items', label: 'Items & thresholds', icon: 'orders' },
  { key: 'staff', label: 'Staff', icon: 'more' },
  { key: 'roster', label: 'Roster', icon: 'reports' },
  { key: 'cash', label: 'Cash', icon: 'count' },
  { key: 'announcements', label: 'Announcements', icon: 'home' },
];

let subPage = null;

export async function renderMore(root) {
  const sess = getSession();
  if (!subPage) {
    root.innerHTML = `
      <div class="tt-panel">
        <div class="tt-panel-title">${esc(sess.name)}</div>
        <div class="tt-panel-sub">${sess.role === 'manager' ? 'Manager' : 'Staff'}</div>
      </div>
      <div class="tt-more-menu">
        ${PAGES.map((p) => `<button class="tt-more-item" data-page="${p.key}">${icon(p.icon, 18)} <span>${esc(p.label)}</span> ${icon('chevronRight', 14)}</button>`).join('')}
      </div>
      <button class="tt-btn ghost tt-signout-btn" id="ttSignOutBtn">Sign out</button>
    `;
    root.querySelectorAll('[data-page]').forEach((btn) => btn.addEventListener('click', () => { subPage = btn.dataset.page; renderMore(root); }));
    root.querySelector('#ttSignOutBtn').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Sign out?', body: 'You can sign back in with your PIN any time.', confirmLabel: 'Sign out' });
      if (ok) signOut();
    });
    return;
  }

  root.innerHTML = `<button class="tt-back" id="ttMoreBack">${icon('chevronLeft', 14)} More</button><div id="ttMoreContent"></div>`;
  root.querySelector('#ttMoreBack').addEventListener('click', () => { subPage = null; renderMore(root); });
  const content = root.querySelector('#ttMoreContent');
  if (subPage === 'items') return renderItems(content, sess.storeId);
  if (subPage === 'staff') return renderStaff(content, sess.storeId);
  if (subPage === 'roster') return renderRoster(content, sess.storeId);
  if (subPage === 'cash') return renderCash(content);
  if (subPage === 'announcements') return renderAnnouncements(content, sess.storeId);
}
