// Sandbox drafts kept in this browser until sign-in and cloud saves arrive. Storage can be blocked,
// so reads fall back to none and writes are best effort.
const KEY = 'opval-sandbox-drafts';

export function loadDrafts() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
export function saveDrafts(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50))); } catch { /* storage blocked: drafts last this visit */ }
}
export const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
