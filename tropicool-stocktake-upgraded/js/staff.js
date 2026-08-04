/**
 * Staff list. Read-only view of staff_public — no PIN field is ever
 * fetched or displayed (contrast with the original, AUDIT.md §7.1). PIN
 * reset / role change / lock require the set-staff-pin Edge Function,
 * which isn't deployed — shown honestly as unavailable rather than wired
 * to a fake local action, per working rule 7.
 */
import * as db from './database.js';
import { isManager } from './auth.js';
import { esc } from './ui.js';

export async function renderStaff(root, storeId) {
  const staff = await db.getStaffPublic(storeId);
  root.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Staff</div>
      <div class="tt-panel-sub">Who can sign in and count at this store.</div>
      <div class="tt-list-rows">
        ${staff.map((s) => `<div class="tt-list-row"><div><div class="tt-list-row-name">${esc(s.name)}</div><div class="tt-list-row-sub">${s.role === 'manager' ? 'Manager' : 'Staff'} · ${s.hasPinSet ? 'PIN set' : 'No PIN yet'}</div></div></div>`).join('')}
      </div>
      ${isManager() ? `<div class="tt-note">PIN reset, role changes, and account locking go through the verify-staff-pin/set-staff-pin Edge Functions (see AUTH_MODEL.md) — not deployed in this environment yet, so those actions aren't wired up here rather than being shown as working when they aren't.</div>` : ''}
    </div>
  `;
}
