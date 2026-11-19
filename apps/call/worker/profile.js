import { totalScore, callRecord } from '../../../src/engine/collect/game.js';
import { guessesOf } from './transferBets.js';

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'public, max-age=60' } });
const now = () => Math.floor(Date.now() / 1000);

// Public, shareable profile: cards owned, match calls once their match has started (so nobody copies
// an open call), and every roster guess. Nothing private: no credits, no session, no recovery state.
export async function publicProfile(env, username, t = now()) {
  const user = await env.DB.prepare('SELECT id,username,created_at FROM users WHERE username=?').bind(String(username).toLowerCase()).first();
  if (!user) return reply({ error: 'No player has this username.' }, 404);
  const save = await env.DB.prepare('SELECT state FROM saves WHERE user_id=?').bind(user.id).first();
  const state = save ? JSON.parse(save.state) : { collection: [], tracked: [], calls: {}, history: [] };
  const ids = Object.keys(state.calls ?? {}).map(Number).filter(Number.isSafeInteger);
  const matches = ids.length ? (await env.DB.prepare(`SELECT match_id,starts_at,status,team1_tag,team2_tag,team1_name,team2_name,score1,score2,winner
    FROM feed_matches WHERE match_id IN (SELECT value FROM json_each(?)) AND starts_at<=?`).bind(JSON.stringify(ids), t).all()).results : [];
  const scored = new Map((state.history ?? []).filter(h => h.matchId != null).map(h => [h.matchId, h]));
  const calls = matches.sort((a, b) => b.starts_at - a.starts_at).map(m => ({
    matchId: m.match_id, startsAt: m.starts_at, status: m.status,
    teams: [{ tag: m.team1_tag, name: m.team1_name, score: m.score1 }, { tag: m.team2_tag, name: m.team2_name, score: m.score2 }],
    winner: m.winner, call: state.calls[m.match_id],
    points: scored.get(m.match_id) ? scored.get(m.match_id).callPoints : null, right: scored.get(m.match_id)?.right ?? null,
  }));
  return reply({
    username: user.username, joinedAt: user.created_at,
    score: totalScore({ history: state.history ?? [] }), record: callRecord({ history: state.history ?? [] }),
    collection: state.collection ?? [], tracked: state.tracked ?? [],
    calls, guesses: await guessesOf(env.DB, user.id, t),
  });
}
