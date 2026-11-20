// Hypothetical lineups (no React, so tests can import it). A slot is { handle, personId, now, manual? },
// where `now` is where Riot's data lists the person today ({ teamId, team, status, contractEnd } or
// null) and `manual` labels a hand-entered move for the team ("Reported for T1").
// Facts become warnings, never blocks: the sandbox is for "what if". Rules OpVAL has no data for
// are listed as not checked rather than guessed.

export const STARTERS = 5;
export const NOT_CHECKED = ['Import and residency limits', 'League eligibility and registration deadlines'];

const keyOf = slot => (slot.personId != null ? `id:${slot.personId}` : `h:${slot.handle.toLowerCase()}`);
const all = draft => [...draft.starters.filter(Boolean), ...draft.bench, ...draft.staff];

export function checkLineup(draft) {
  const errors = [];
  const seen = new Map();
  for (const slot of all(draft)) {
    if (seen.has(keyOf(slot))) errors.push(`${slot.handle} is in the lineup twice.`);
    seen.set(keyOf(slot), true);
  }
  const warnings = [];
  const filled = draft.starters.filter(Boolean).length;
  if (filled < STARTERS) warnings.push({ text: `${filled} of ${STARTERS} starters picked.` });
  for (const slot of all(draft)) {
    if (slot.manual) continue; // announced or reported for this team: consistent with its own lineup
    const now = slot.now;
    if (!now) warnings.push({ handle: slot.handle, text: `${slot.handle} is not on a tracked team in Riot's data now.` });
    else if (now.teamId !== draft.baseTeamId) {
      warnings.push({ handle: slot.handle, text: `${slot.handle} is listed on ${now.team}${now.contractEnd ? `, contract ending ${now.contractEnd}` : ''}.` });
    } else if (now.status && !['active', 'staff'].includes(now.status)) {
      warnings.push({ handle: slot.handle, text: `${slot.handle} is listed as ${now.status}.` });
    }
  }
  return { errors, warnings, notChecked: NOT_CHECKED };
}

// Who the draft adds to, and removes from, the lineup it started from.
export function diffFromBase(draft, base) {
  const mine = all(draft);
  const has = (list, slot) => list.some(s => keyOf(s) === keyOf(slot));
  return { added: mine.filter(s => !has(base, s)), removed: base.filter(s => !has(mine, s)) };
}

export const blankDraft = (id, name = 'New lineup') =>
  ({ id, name, baseTeamId: null, baseTeam: null, base: [], starters: Array(STARTERS).fill(null), bench: [], staff: [], updatedAt: Date.now() });
