import { useEffect, useMemo, useState } from 'react';
import Sheet from '../components/Sheet';
import Receipt from '../components/Receipt';
import { Crest, Face } from '../components/Face';
import { GuessStrip, TeamSheet } from '../components/TransferBets';
import { useGame } from '../lib/gameContext';
import { colorsFor, tagForName } from '../lib/orgs';
import { cardFor } from '../lib/rosterCards';
import { weekBounds, weekKey } from '../lib/weeklyBingo';

const LEAGUES = [
  { id: 'AMERICAS', label: 'Americas' },
  { id: 'EMEA', label: 'EMEA' },
  { id: 'PACIFIC', label: 'Pacific' },
  { id: 'CN', label: 'China' },
];
const MOVES_SHOWN = 5;
const nowS = () => Math.floor(Date.now() / 1000);
const dayOf = s => new Date(s * 1000).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
const dayKeyOf = key => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function ago(s) {
  const d = Math.max(0, nowS() - s);
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`;
}
const Arrow = () => <span className="move-arrow" aria-hidden="true" />;

// One VLR transfer row: the player, then each move as crest, arrow, crest.
function MoveRow({ t }) {
  return <li>
    <a href={t.sourceUrl} target="_blank" rel="noreferrer" className="roster-who"><b>{t.handle}</b></a>
    {t.moves.map((m, n) => <span key={n} className="roster-move" data-type={m.type}>
      {m.type === 'joined'
        ? <>{m.from ? <Crest name={m.from} /> : <span className="crest crest-none" aria-hidden="true" />}<Arrow /><Crest name={m.team} /><small>{m.team}</small></>
        : <><Crest name={m.team} /><Arrow /><span className="crest crest-none" aria-hidden="true" /><small>{m.team}</small></>}
      <span className="sr">{m.type === 'joined' ? `joined ${m.team}${m.from ? ` from ${m.from}` : ''}` : `left ${m.team}`}</span>
    </span>)}
  </li>;
}

export default function Roster() {
  const { account } = useGame();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [league, setLeague] = useState('AMERICAS');
  const [guessData, setGuessing] = useState(null);
  const [team, setTeam] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [movesOpen, setMovesOpen] = useState(false);
  const [unmatchedOpen, setUnmatchedOpen] = useState(false);
  const guessing = account.user ? guessData : null;

  useEffect(() => {
    Promise.all(['transfers', 'contracts', 'events', 'status', 'unresolved'].map(x => fetch(`/api/roster/${x}`).then(r => {
      if (!r.ok) throw new Error('Roster data is unavailable right now. Try again in a minute.');
      return r.json();
    }))).then(parts => setData(Object.assign({}, ...parts))).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (!account.user) return;
    fetch('/api/transfer-bets', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(setGuessing).catch(() => {});
  }, [account.user]);

  const q = query.trim().toLowerCase();
  const [from, to] = weekBounds(weekKey(nowS()));
  const confirmed = useMemo(() => (data?.events ?? []).filter(e => e.firstSeenAt >= from && e.firstSeenAt < to).length, [data, from, to]);
  const contracts = data?.contracts ?? [];
  // Teams in the league (or matching the search), each with its three best cards up front.
  const teams = useMemo(() => {
    const grouped = contracts.filter(c => (q ? `${c.team} ${c.player}`.toLowerCase().includes(q) : c.league === league))
      .reduce((out, c) => ((out[c.team] ??= []).push(c), out), {});
    return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([name, players]) => ({
      name,
      faces: contracts.filter(c => c.team === name).map(c => ({ ...c, card: cardFor(c.player, name) })).filter(c => c.card)
        .sort((a, b) => (b.card?.rating ?? 0) - (a.card?.rating ?? 0)).slice(0, 3),
      hit: q ? players.map(p => p.player) : [],
    }));
  }, [contracts, league, q]);
  const moves = data?.transfers ?? [];
  const guesses = guessing?.bets ?? [];

  return <section className="roster-page">
    <header className="roster-head">
      <h1>Rosters</h1>
      {data && <div className="roster-sources">
        <a href={data.riot.sourceUrl} target="_blank" rel="noreferrer" data-ok={!data.riot.stale && !data.riot.lastError}>
          <i aria-hidden="true" />Riot GCD<small>{data.riot.lastReadAt ? ago(data.riot.lastReadAt) : 'never'}</small>
        </a>
        <a href={data.vlr.sourceUrl} target="_blank" rel="noreferrer" data-ok={!data.vlr.lastError}>
          <i aria-hidden="true" />VLR<small>{data.vlr.lastReadAt ? ago(data.vlr.lastReadAt) : 'never'}</small>
        </a>
        {data.unresolved?.length > 0 && <button type="button" className="roster-unmatched" onClick={() => setUnmatchedOpen(true)}>
          <b>{data.unresolved.length}</b> unmatched
        </button>}
      </div>}
    </header>

    {error && <p className="error" role="alert">{error}</p>}
    {!data && !error && <p className="note">Loading rosters</p>}

    {data && <>
      <input className="roster-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="aspas, Sentinels, EMEA" aria-label="Search players and teams" />
      {!q && <div className="tier-switch roster-leagues" role="group" aria-label="League" style={{ '--n': LEAGUES.length }}>
        {LEAGUES.map(l => <button key={l.id} type="button" className={league === l.id ? 'primary' : undefined} aria-pressed={league === l.id} onClick={() => setLeague(l.id)}>{l.label}</button>)}
      </div>}

      <div className="team-grid">
        {teams.map(t => <button key={t.name} type="button" className="team-tile" style={{ '--team': colorsFor(tagForName(t.name))[0] }} onClick={() => setTeam(t.name)}>
          <span className="team-tile-fan" aria-hidden="true">
            {t.faces.length ? t.faces.map(p => <Face key={p.player} player={p.player} card={p.card} team={t.name} scale={0.15} />) : <Crest name={t.name} size={72} />}
          </span>
          <span className="team-tile-name"><Crest name={t.name} size={30} /><b>{t.name}</b></span>
          {t.hit.length > 0 && <small className="team-tile-hit">{t.hit.join(', ')}</small>}
        </button>)}
      </div>
      {teams.length === 0 && <p className="note">No teams match.</p>}

      {guesses.length > 0 && <section className="roster-block">
        <h2 className="sum"><b>{guesses.length}</b><span>{guesses.length === 1 ? 'guess' : 'guesses'}</span></h2>
        <GuessStrip guesses={guesses} onOpen={setReceipt} />
      </section>}

      {!q && <section className="roster-block">
        <h2 className="sum"><b>{confirmed}</b><span>confirmed by Riot this week</span></h2>
        <ul className="roster-moves">{moves.slice(0, MOVES_SHOWN).map(t => <MoveRow key={`${t.vlrId}-${t.day}`} t={t} />)}</ul>
        {moves.length > MOVES_SHOWN && <button type="button" className="secondary roster-more" onClick={() => setMovesOpen(true)}>All {moves.length} moves</button>}
      </section>}
    </>}

    {team && <TeamSheet key={team} team={team} contracts={contracts} guessing={guessing} signedIn={Boolean(account.user)} username={account.user?.username}
      onClose={() => setTeam(null)}
      onPlaced={({ bet }) => setGuessing(g => ({ ...g, bets: [bet, ...(g?.bets ?? [])] }))} />}

    <Sheet open={Boolean(receipt)} onClose={() => setReceipt(null)} title="Receipt">
      {receipt && <Receipt guess={receipt} username={account.user?.username} />}
    </Sheet>

    <Sheet open={movesOpen} onClose={() => setMovesOpen(false)} title="Moves on VLR">
      {Object.entries(moves.reduce((out, t) => ((out[t.day] ??= []).push(t), out), {})).map(([day, list]) => <div key={day} className="roster-day">
        <h3>{dayKeyOf(day)}</h3>
        <ul className="roster-moves">{list.map(t => <MoveRow key={`${t.vlrId}-${t.day}`} t={t} />)}</ul>
      </div>)}
    </Sheet>

    <Sheet open={unmatchedOpen} onClose={() => setUnmatchedOpen(false)} title="Unmatched identities">
      <ul className="roster-unmatched-list">
        {(data?.unresolved ?? []).map((u, i) => <li key={i}><b>{u.identityKey}</b><small>{u.reason}</small><small>{dayOf(u.observedAt)}</small></li>)}
      </ul>
    </Sheet>
  </section>;
}
