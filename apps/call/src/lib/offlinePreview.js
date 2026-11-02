import cards from '../../../../shared/src/data/cards.json';
import { buyPack, createCollection, setCall, swapTracked } from '../../../../src/engine/collect/game';
import { weekBounds, weekKey, weeklyCatalog } from './weeklyBingo';

// Loaded only by the development entry when ?offline=1 is explicitly requested.
export function installOfflinePreview() {
  const original = window.fetch.bind(window);
  const now = Math.floor(Date.now() / 1000);
  const unique = [...new Map(cards.map(card => [`${card.org}:${card.player}`, card])).values()];
  const players = unique.map((card, index) => ({ vlrId: index + 1, handle: card.player, teamTag: card.org, lastPlayedAt: now }));
  const pool = unique.map((card, index) => ({ pid: index + 1, tier: card.palette }));
  let state = { ...createCollection({ seed: 424242 }), credits: 350, freePacks: 3, collection: players.slice(0, 15).map(p => p.vlrId), tracked: players.slice(0, 10).map(p => p.vlrId) };
  state.trackedLog = [{ t: 0, tracked: state.tracked }];
  let version = 1;
  let signedIn = true;
  const bingoCards = new Map();
  const teams = ['FNC', 'PRX', 'GEN', 'SEN', 'G2', 'DRX'];
  const matches = [2, 5, 8].map((hours, i) => ({ matchId: 990001 + i, startsAt: now + hours * 3600, status: 'upcoming', bestOf: 3, round: 'Playoffs · Upper bracket', teams: teams.slice(i * 2, i * 2 + 2).map(tag => ({ tag, name: tag })), eventId: 2766 }));
  sessionStorage.setItem('opval-played', '1');
  sessionStorage.setItem('opval-offline-preview', '1');
  localStorage.setItem('opval-rules-seen', '1');
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return original(input, options);
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const body = options.body ? JSON.parse(options.body) : {};
    const path = url.pathname;
    const reply = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
    const user = { username: 'OfflineTester' };
    if (path === '/api/auth/me') return reply({ user: signedIn ? user : null });
    if (path === '/api/auth/logout') { signedIn = false; return reply({ ok: true }); }
    if (path.startsWith('/api/auth/')) { signedIn = true; return reply({ user }); }
    if (path === '/api/save') {
      if (options.method === 'PUT') { state = body.state; version++; }
      return reply({ state, version });
    }
    if (path === '/api/feed/players') return reply({ players });
    if (path === '/api/feed/schedule') return reply({ matches: url.searchParams.get('event') === '2766' ? matches : [] });
    if (path.startsWith('/api/feed/matches/')) return reply(matches.find(m => String(m.matchId) === path.split('/').at(-1)) ?? {}, 200);
    if (path === '/api/game/action') {
      try {
        let result;
        if (body.op === 'pack') { result = buyPack(state, pool); state = result.state; }
        else if (body.op === 'call') state = setCall(state, body.matchId, body.call);
        else if (body.op === 'swap') state = swapTracked(state, body.outPid, body.inPid, pid => unique[pid - 1]?.palette ?? 'bronze');
        else return reply({ error: 'This action is not available in the offline preview.' }, 400);
        version++;
        return reply({ ...result, state, version });
      } catch (error) { return reply({ error: error.message }, 400); }
    }
    if (path.includes('leaderboard')) return reply({ entries: ['pixelpeek', 'clutchqueen', 'OfflineTester', 'midround', 'plantdefault'].map((username, i) => ({ username, rank: i + 1, points: [1840, 1620, 1280, 1150, 980][i] })), me: { rank: 3, points: 1280 } });
    const week = url.searchParams.get('week') ?? body.week ?? weekKey(now);
    if (path === '/api/weekly-bingo/calibration') return reply({ settledWeeks: 2 });
    if (path === '/api/weekly-bingo/score') return reply({ cards: [], rosterComplete: false });
    if (path === '/api/weekly-bingo') {
      const [startsAt, endsAt] = weekBounds(week);
      const slate = matches.map(m => ({ ...m, team1Tag: m.teams[0].tag, team2Tag: m.teams[1].tag }));
      if (options.method === 'PUT') bingoCards.set(week, [{ slot: body.slot, cells: body.cells, version: 1, locked_at: now, updated_at: now }]);
      return reply({ week, startsAt, endsAt, ended: now >= endsAt, settled: false, cards: bingoCards.get(week) ?? [], matches: slate, catalog: weeklyCatalog(slate), rules: { paidEnabled: false, maxCards: 1, cardCost: 100 }, balance: state.credits });
    }
    return reply({ error: 'This screen is not included in the offline preview.' }, 503);
  };
}
