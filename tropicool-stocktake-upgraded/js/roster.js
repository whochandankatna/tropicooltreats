import * as db from './database.js';
import { esc } from './ui.js';

export async function renderRoster(root, storeId) {
  const shifts = await db.getRoster(storeId);
  root.innerHTML = `
    <div class="tt-panel">
      <h2 class="tt-panel-title">Roster</h2>
      ${shifts.length
        ? `<div class="tt-list-rows">${shifts.map((s) => `<div class="tt-list-row"><div class="tt-list-row-name">${esc(s.name)}</div></div>`).join('')}</div>`
        : `<div class="tt-empty">No shifts published yet. Roster data comes from an external rostering source in the original app (AUDIT.md §11.4) — that integration is unchanged in this phase.</div>`}
    </div>
  `;
}
