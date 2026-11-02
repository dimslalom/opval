import { hashSeed, mulberry32 } from '../../../shared/src/engine/perfectRun.js';

// One bit-identical RNG app-wide, but no stream state to store: every decision
// seeds its own generator from (seed, day, manager, phase), so saves are
// order-independent and AI plans are reproducible.
export { hashSeed, mulberry32 };

export const rngFor = (seed, ...parts) => mulberry32(hashSeed([seed, ...parts].join(':')));

export function pickWeighted(rng, items, weightOf) {
  const weights = items.map(weightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function shuffle(rng, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
