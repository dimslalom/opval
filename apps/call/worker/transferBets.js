import { TRANSFER, nextLock, identityOf, legsFor, scoreLegs, payoutOf, pointsOf } from '../src/lib/transferBets.js';
import { postWallet } from './wallet.js';

const now = () => Math.floor(Date.now() / 1000);
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ');

export async function eventsBetween(db, from, to) {
  return (await db.prepare(`SELECT identity_key AS identityKey,change_type AS changeType,player,team,first_seen_at AS firstSeenAt
    FROM roster_events WHERE first_seen_at>=? AND first_seen_at<? ORDER BY first_seen_at`).bind(from, to).all()).results;
}
const shape = r => ({ id: r.id, team: r.team, legs: JSON.parse(r.legs), stake: r.stake,
  placedAt: r.placed_at, deadline: r.deadline, hits: r.hits, payout: r.payout, points: r.points, settledAt: r.settled_at });

// A user's guesses with each leg marked hit or not so far. Shared by the owner's list and the public profile.
export async function guessesOf(db, userId, t = now()) {
  const guesses = (await db.prepare('SELECT * FROM transfer_bets WHERE user_id=? ORDER BY placed_at DESC LIMIT 50').bind(userId).all()).results.map(shape);
  const events = guesses.length ? await eventsBetween(db, Math.min(...guesses.map(g => g.placedAt)), t + 1) : [];
  return guesses.map(g => ({ ...g, legs: scoreLegs(g, events) }));
}

async function list(db, user, t) {
  return reply({ lock: nextLock(t), rules: TRANSFER, bets: await guessesOf(db, user.id, t) });
}

async function place(db, user, body, t) {
  const deadline = nextLock(t);
  if (!deadline) return reply({ error: 'Guesses open once the next roster lock date is set.' }, 409);
  const raw = Array.isArray(body?.moves) ? body.moves : [];
  if (!raw.length || raw.length > TRANSFER.maxMoves) return reply({ error: `Guess 1 to ${TRANSFER.maxMoves} moves.` }, 400);
  if (new Set(raw.map(m => m?.out)).size !== raw.length) return reply({ error: 'Each player can have only one move.' }, 400);

  const contracts = (await db.prepare('SELECT identity_key AS key,player,team,league FROM roster_contracts').all()).results;
  const byKey = new Map(contracts.map(c => [c.key, c]));
  const leagueOf = new Map(contracts.map(c => [c.team, c.league]));
  const moves = [];
  for (const m of raw) {
    const out = byKey.get(m?.out);
    if (!out) return reply({ error: 'Pick players who are on this team now.' }, 400);
    const incoming = m.in != null ? norm(m.in) : null, to = m.to != null ? norm(m.to) : null;
    if (Boolean(incoming) === Boolean(to)) return reply({ error: 'Each move needs a replacement or a new team.' }, 400);
    if (incoming) {
      if (incoming.length > 40) return reply({ error: 'That player name is too long.' }, 400);
      if (byKey.get(identityOf(incoming, out.league))?.team === out.team) return reply({ error: `${incoming} is already on ${out.team}.` }, 400);
      moves.push({ out, in: incoming });
    } else {
      if (!leagueOf.has(to) || to === out.team) return reply({ error: "Pick a team listed in Riot's contract database." }, 400);
      moves.push({ out, to: { team: to, league: leagueOf.get(to) } });
    }
  }
  const legs = legsFor(moves);

  // Points only: nothing is staked, so placing a guess touches no wallet.
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO transfer_bets(id,user_id,team,legs,stake,placed_at,deadline) VALUES(?,?,?,?,NULL,?,?)')
    .bind(id, user.id, moves[0].out.team, JSON.stringify(legs), t, deadline).run();
  const bet = shape(await db.prepare('SELECT * FROM transfer_bets WHERE id=?').bind(id).first());
  return reply({ ok: true, bet: { ...bet, legs: scoreLegs(bet, []) } });
}

export function handleTransferBets(user, env, method, body, t = now()) {
  return method === 'POST' ? place(env.DB, user, body, t) : list(env.DB, user, t);
}

// Settle guesses whose lock has passed once Riot GCD was read twice after it, so any change first seen
// before the lock has had its confirming second pass (worker/feed/roster.js needs two).
export async function settleTransferBets(env, t = now()) {
  const db = env.DB;
  const due = (await db.prepare('SELECT * FROM transfer_bets WHERE settled_at IS NULL AND deadline<=?').bind(t).all()).results.map(r => ({ ...shape(r), userId: r.user_id }));
  let count = 0;
  for (const g of due) {
    const checks = (await db.prepare('SELECT COUNT(*) AS n FROM roster_source_checks WHERE observed_at>=?').bind(g.deadline).first()).n;
    if (checks < 2) continue;
    const hits = scoreLegs(g, await eventsBetween(db, g.placedAt, g.deadline)).filter(l => l.hit).length;
    if (g.stake == null) {
      await db.prepare('UPDATE transfer_bets SET hits=?,points=?,settled_at=? WHERE id=? AND settled_at IS NULL').bind(hits, pointsOf(hits), t, g.id).run();
      count++;
      continue;
    }
    // A guess staked before points-only settles in credits, as placed.
    const payout = payoutOf(g.stake, g.legs.length, hits);
    if (payout > 0 && !(await postWallet(db, g.userId, `transfer-pay:${g.id}`, payout, t))) continue;
    await db.prepare('UPDATE transfer_bets SET hits=?,payout=?,settled_at=? WHERE id=? AND settled_at IS NULL').bind(hits, payout, t, g.id).run();
    count++;
  }
  return count;
}
