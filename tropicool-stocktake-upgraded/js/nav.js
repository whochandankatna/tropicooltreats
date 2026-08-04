/**
 * Five-tab information architecture (Priority 3): Home, Count, Orders,
 * Reports, More. Sticky bottom bar on mobile, sidebar on desktop — same
 * tab list drives both, so there's one source of truth for what's in the
 * app rather than the original's separate desktop/mobile tab markup.
 */
import { icon } from './ui.js';

export const TABS = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'count', label: 'Count', icon: 'count' },
  { key: 'orders', label: 'Orders', icon: 'orders' },
  { key: 'reports', label: 'Reports', icon: 'reports' },
  { key: 'more', label: 'More', icon: 'more' },
];

let activeTab = 'home';
let listeners = [];

export function getActiveTab() { return activeTab; }
export function setActiveTab(tab) {
  activeTab = tab;
  listeners.forEach((fn) => fn(activeTab));
}
export function onTabChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; }

export function renderBottomNav() {
  return `<nav class="tt-bottomnav" aria-label="Primary">
    ${TABS.map((t) => `
      <button class="tt-bottomnav-btn ${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}" aria-current="${t.key === activeTab ? 'page' : 'false'}">
        ${icon(t.icon, 22)}
        <span>${t.label}</span>
      </button>`).join('')}
  </nav>`;
}

export function renderSidebar() {
  return `<nav class="tt-sidebar" aria-label="Primary">
    <div class="tt-sidebar-logo">TT</div>
    ${TABS.map((t) => `
      <button class="tt-sidebar-btn ${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}" aria-current="${t.key === activeTab ? 'page' : 'false'}">
        ${icon(t.icon, 19)}
        <span>${t.label}</span>
      </button>`).join('')}
  </nav>`;
}

export function bindNav(root, onNavigate) {
  root.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { setActiveTab(btn.dataset.tab); onNavigate?.(btn.dataset.tab); });
  });
}
