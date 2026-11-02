// Pure validation for the ingest payload (runs in Node tests and in the Worker).
// Rule of thumb: never let a worse payload overwrite better stored data.

export const SCHEMA_VERSION = 1;
export const KINDS = ['matches', 'schedule', 'transfers', 'players', 'values', 'contracts', 'heartbeat'];
export const MAX_BODY_BYTES = 512 * 1024;

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// Envelope check. Returns { ok: true } or { ok: false, status, error }.
export function validateEnvelope(body) {
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'expected an object' };
  if (body.schemaVersion !== SCHEMA_VERSION) {
    // 409 so the job fails loudly when the two sides drift apart.
    return { ok: false, status: 409, error: `schemaVersion ${body.schemaVersion} != ${SCHEMA_VERSION}` };
  }
  if (!KINDS.includes(body.kind)) return { ok: false, status: 400, error: 'unknown kind' };
  if (typeof body.runId !== 'string' || !body.runId) return { ok: false, status: 400, error: 'runId required' };
  return { ok: true };
}

// vlr.gg leaves these cells blank on some matches (China Kickoff 2026 has whole maps with only ACS
// and K/D/A). Missing is not wrong: the map result stands, the player rows just aren't complete.
const unpublished = p => ['r2', 'adr', 'kast', 'hs', 'fk', 'fd'].some(k => p[k] === null);

function playerProblem(p, rounds) {
  if (!int(p.vlrId, 1, 1e9)) return 'vlrId';
  if (!(p.side === 1 || p.side === 2)) return 'side';
  if (!p.agent || typeof p.agent !== 'string') return 'agent';
  if (!int(p.k, 0, 80) || !int(p.d, 0, 80) || !int(p.a, 0, 80)) return 'kda';
  if (!int(p.acs, 0, 1000) || !int(p.adr, 0, 500)) return 'acs/adr';
  if (!int(p.kast, 0, 100) || !int(p.hs, 0, 100)) return 'kast/hs';
  if (!num(p.r2, 0, 4)) return 'r2';
  if (!int(p.fk, 0, rounds) || !int(p.fd, 0, rounds)) return 'fk/fd';
  if (!Array.isArray(p.mk) || p.mk.length !== 4 || !p.mk.every(n => int(n, 0, 40))) return 'mk';
  if (!Array.isArray(p.cl) || p.cl.length !== 5 || !p.cl.every(n => int(n, 0, 40))) return 'cl';
  return null;
}

// Judge one map. 'ok' = score and 10 valid players; 'empty' = score only (stats
// not published yet); 'bad' = reject the whole match.
export function judgeMap(map) {
  const [s1, s2] = Array.isArray(map.score) ? map.score : [];
  if (!int(s1, 0, 30) || !int(s2, 0, 30)) return { verdict: 'bad', reason: 'map score' };
  if (Math.max(s1, s2) < 13 || Math.abs(s1 - s2) < 2) return { verdict: 'bad', reason: 'map score not a finished map' };
  const players = Array.isArray(map.players) ? map.players : [];
  if (players.length === 0) return { verdict: 'empty' };

  const rounds = s1 + s2;
  const complete = players.filter(p => !unpublished(p));
  for (const p of complete) {
    const problem = playerProblem(p, rounds);
    if (problem) return { verdict: 'bad', reason: `player ${p.vlrId ?? '?'}: ${problem}` };
  }
  if (complete.length < players.length) return { verdict: 'partial', reason: 'stats not published' };
  const ids = new Set(players.map(p => p.vlrId));
  const perSide = [1, 2].map(s => players.filter(p => p.side === s).length);
  if (players.length !== 10 || ids.size !== 10 || perSide[0] !== 5 || perSide[1] !== 5) {
    return { verdict: 'partial', reason: `${players.length} players` };
  }
  return { verdict: 'ok' };
}

// Judge a match. Returns { verdict: 'accept'|'pending'|'partial'|'reject',
// statsRank, reason?, maps: [verdict per map] }.
export function judgeMatch(match) {
  if (!int(match.matchId, 1, 1e9) || !int(match.eventId, 1, 1e9)) return { verdict: 'reject', reason: 'ids' };
  if (!['upcoming', 'live', 'final'].includes(match.status)) return { verdict: 'reject', reason: 'status' };
  if (match.status !== 'final') return { verdict: 'accept', statsRank: 0, maps: [] };

  const maps = Array.isArray(match.maps) ? match.maps : [];
  const bestOf = match.bestOf;
  if (!int(bestOf, 1, 5)) return { verdict: 'reject', reason: 'bestOf' };
  const need = Math.ceil(bestOf / 2);
  const wins = [0, 0];
  const verdicts = [];
  for (const map of maps) {
    const j = judgeMap(map);
    if (j.verdict === 'bad') return { verdict: 'reject', reason: j.reason };
    verdicts.push(j.verdict);
    wins[map.score[0] > map.score[1] ? 0 : 1] += 1;
  }
  if (maps.length < need) return { verdict: 'reject', reason: 'too few maps for a final' };
  if (Math.max(...wins) < need) return { verdict: 'reject', reason: 'no map winner reaches the series score' };
  if (bestOf === 3 && maps.length === 3 && Math.min(...wins) === 0) return { verdict: 'reject', reason: '3-0 in a Bo3' };

  const empty = verdicts.filter(v => v === 'empty').length;
  if (empty === verdicts.length) return { verdict: 'pending', statsRank: 1, maps: verdicts };
  if (verdicts.every(v => v === 'ok')) return { verdict: 'accept', statsRank: 3, maps: verdicts };
  return { verdict: 'partial', statsRank: 2, maps: verdicts };
}
