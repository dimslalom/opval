import { ECONOMY, PACK_ODDS } from './rules.js';
import { pickWeighted, rngFor } from '../shared/rng.js';

// Packs draw from a pool of { pid, tier } the player can actually receive (feed
// players that have a card). Deterministic from (seed, pack number). Never gives
// a card you already own: if the pool runs dry you get credits instead.

const tierOf = entry => (entry.tier === 'icon' ? 'gold' : entry.tier);

export function openPack(seed, packNumber, pool, owned) {
  const rng = rngFor(seed, 'pack', packNumber);
  const have = new Set(owned);
  const cards = [];
  let refund = 0;
  for (let i = 0; i < ECONOMY.packSize; i += 1) {
    const free = pool.filter(e => !have.has(e.pid) && !cards.includes(e.pid));
    if (free.length === 0) { refund += ECONOMY.duplicateRefund; continue; }
    const tier = pickWeighted(rng, Object.keys(PACK_ODDS), t => (free.some(e => tierOf(e) === t) ? PACK_ODDS[t] : 0));
    const options = free.filter(e => tierOf(e) === tier);
    cards.push(options[Math.floor(rng() * options.length)].pid);
  }
  return { cards, refund };
}
