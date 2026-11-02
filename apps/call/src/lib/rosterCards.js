import cards from '../../../../shared/src/data/cards.json';
import { makeCardLookup } from '../../../../src/engine/shared/cardLookup';
import { tagForName } from './orgs';

// Riot GCD names players and teams in its own words; these join them to the designed cards and kits.
const lookup = makeCardLookup(cards);
const lower = s => String(s ?? '').toLowerCase();
const best = new Map();
for (const c of cards) if (c.league !== 'icon' && (!best.has(lower(c.player)) || best.get(lower(c.player)).rating < c.rating)) best.set(lower(c.player), c);

export const cardFor = (player, teamName) => lookup(player, tagForName(teamName) ?? '') ?? best.get(lower(player)) ?? null;
const REGION = { AMERICAS: 'Americas', EMEA: 'EMEA', PACIFIC: 'Pacific', CN: 'China' };

// Before anyone types: the best cards from the team's region who are not on it already.
export function suggestCards(league, teamName, limit = 8) {
  const region = REGION[String(league).toUpperCase()], tag = tagForName(teamName);
  return [...best.values()].filter(c => c.region === region && c.org !== tag).sort((a, b) => b.rating - a.rating).slice(0, limit);
}

// Players whose name starts with the query first, then any that contain it; best rated first within each.
export function searchCards(query, limit = 12) {
  const q = lower(query).trim();
  if (!q) return [];
  const all = [...best.values()].filter(c => lower(c.player).includes(q));
  return all.sort((a, b) => (lower(b.player).startsWith(q) - lower(a.player).startsWith(q)) || b.rating - a.rating).slice(0, limit);
}
