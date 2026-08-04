import * as db from './database.js';
import { getSession } from './auth.js';
import { esc, timeAgo, toast } from './ui.js';

export async function renderAnnouncements(root, storeId) {
  const sess = getSession();
  const items = await db.getAnnouncements(storeId);
  root.innerHTML = `
    <div class="tt-panel">
      <h2 class="tt-panel-title">Team board</h2>
      <div class="tt-field"><label class="tt-sr-only" for="ttAnnounceText">Post something everyone should see</label>
        <textarea class="tt-input" id="ttAnnounceText" rows="2" placeholder="Post something everyone should see..."></textarea></div>
      <div class="tt-actions-row"><button class="tt-btn" id="ttPostAnnounce">Post</button></div>
      <div class="tt-list-rows" style="margin-top:16px;">
        ${items.map((a) => `<div class="tt-list-row"><div><div class="tt-list-row-name">${esc(a.message)}</div><div class="tt-list-row-sub">${a.staffName ? esc(a.staffName) + ' · ' : ''}${timeAgo(a.createdAt)}</div></div></div>`).join('') || '<div class="tt-empty">No announcements yet.</div>'}
      </div>
    </div>
  `;
  root.querySelector('#ttPostAnnounce').addEventListener('click', async () => {
    const text = root.querySelector('#ttAnnounceText');
    const message = text.value.trim();
    if (!message) { toast('Write something first', { error: true }); return; }
    await db.postAnnouncement(message, sess.name);
    toast('Posted');
    renderAnnouncements(root, storeId);
  });
}
