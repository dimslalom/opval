// Per-viewer memory kept in this browser only: what you last saw of each team, and which
// suggestions you dismissed. Storage can be blocked (private windows), so every call is guarded
// and the pages work without it.

const read = key => {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: nothing is remembered */ }
};

// { read, at }: the latest roster read you were shown for this team, and when you saw it.
export const lastVisit = teamId => read(`opval-visit-${teamId}`);
export const markVisit = (teamId, latestRead) => write(`opval-visit-${teamId}`, { read: latestRead, at: Math.floor(Date.now() / 1000) });

export const suggestionsOff = () => read('opval-suggestions-off') === true;
export const setSuggestionsOff = off => write('opval-suggestions-off', off);
export const isDismissed = key => (read('opval-dismissed') ?? []).includes(key);
export const dismiss = key => write('opval-dismissed', [...(read('opval-dismissed') ?? []), key].slice(-200));
