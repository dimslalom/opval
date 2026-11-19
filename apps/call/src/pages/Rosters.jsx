import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Crest } from '../components/Face';
import RosterSource from '../components/RosterSource';
import PersonPhoto from '../components/PersonPhoto';
import { colorsFor, tagForName } from '../lib/orgs';
import { splitLeague } from '../lib/partners';
import { personPath, teamPath, title, useRoster, windowText } from '../lib/roster';

const LEAGUES = [
  { id: 'AMERICAS', label: 'Americas' },
  { id: 'EMEA', label: 'EMEA' },
  { id: 'PACIFIC', label: 'Pacific' },
  { id: 'CN', label: 'China' },
];

// Public home: every team the roster model currently lists, by league.
export default function Rosters() {
  const [params, setParams] = useSearchParams();
  const { data, error } = useRoster('/api/roster/v2/teams');
  const { data: recent } = useRoster('/api/roster/v2/changes');
  const [query, setQuery] = useState('');
  // The four VCT leagues, plus any other league a source lists (e.g. local demo data).
  const leagues = useMemo(() => [...LEAGUES, ...[...new Set((data?.teams ?? []).map(t => t.league))]
    .filter(id => !LEAGUES.some(l => l.id === id)).map(id => ({ id, label: title(id) }))], [data]);
  const league = leagues.some(l => l.id === params.get('league')) ? params.get('league') : 'AMERICAS';

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? (data?.teams ?? []).filter(t => `${t.name} ${t.tag ?? ''}`.toLowerCase().includes(q)) : []), [data, q]);
  const { partners, others } = useMemo(() => splitLeague(league, (data?.teams ?? []).filter(t => t.league === league)), [data, league]);

  return <section className="roster-page">
    <h1>Rosters</h1>
    {error && <p className="error" role="alert">{error}</p>}
    {!data && !error && <p className="loading">Loading rosters</p>}
    {data && <>
      <RosterSource sources={data.sources} now={data.generatedAt} />
      {data.teams.length === 0 ? <p className="note">No teams yet. Rosters appear after the first complete read of Riot's contract database.</p> : <>
        <input className="roster-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Team or tag" aria-label="Search teams" />
        {!q && <div className="tier-switch roster-leagues" role="group" aria-label="League" style={{ '--n': leagues.length }}>
          {leagues.map(l => <button key={l.id} type="button" className={league === l.id ? 'primary' : undefined} aria-pressed={league === l.id}
            onClick={() => setParams(l.id === 'AMERICAS' ? {} : { league: l.id }, { replace: true })}>{l.label}</button>)}
        </div>}
        {q ? <>
          <div className="team-grid">{matches.map(t => <TeamTile key={t.id} team={t} />)}</div>
          {matches.length === 0 && <p className="note">No teams match.</p>}
        </> : <>
          {partners.length > 0 && <div className="team-grid">
            {partners.map(p => <TeamTile key={p.name} name={p.name} team={p.team} />)}
          </div>}
          {others.length > 0 && <section className="roster-block">
            <h2 className="sum"><b>{others.length}</b><span>{partners.length ? 'other teams in the contract database' : 'teams'}</span></h2>
            <ul className="team-chips">
              {others.map(t => <li key={t.id}><Link className="team-chip" to={teamPath(t)}>
                <Crest name={t.name} size={20} /><span>{t.name}</span>{t.players > 0 && <b>{t.players}</b>}
              </Link></li>)}
            </ul>
          </section>}
        </>}
      </>}
      {recent?.changes?.length > 0 && <section className="roster-block">
        <h2 className="sum"><b>{recent.changes.length}</b><span>recent changes between reads</span></h2>
        <ul className="change-list">
          {recent.changes.slice(0, 12).map(c => <li key={`${c.id}-${c.type}`}>
            <span className="change-verb" data-verb={c.type === 'joined' ? 'Joined' : 'Left'}>{c.type === 'joined' ? 'Joined' : 'Left'}</span>
            <Link className="change-who" to={personPath(c)}><PersonPhoto handle={c.handle} team={c.team} size="chip" />{c.handle}</Link>
            <Link className="change-team" to={teamPath(c)}>{c.team}</Link>
            <span className="change-when">{windowText(c.window)}</span>
          </li>)}
        </ul>
      </section>}
    </>}
  </section>;
}

// A partner tile: its roster counts when a source lists the team, otherwise a muted placeholder.
function TeamTile({ name, team }) {
  const label = name ?? team.name;
  const style = { '--team': colorsFor(tagForName(label) ?? team?.tag)[0] };
  const head = <span className="team-tile-name"><Crest name={label} size={30} /><b>{label}</b></span>;
  if (!team) return <div className="team-tile public-team is-unread" style={style}>
    {head}<span className="public-team-counts">Not in the contract database yet</span>
  </div>;
  return <Link className="team-tile public-team" to={teamPath(team)} style={style}>
    {head}
    {team.players || team.staff
      ? <span className="public-team-counts">
        <span><b>{team.players}</b> {team.players === 1 ? 'player' : 'players'}</span>
        {team.staff > 0 && <span><b>{team.staff}</b> staff</span>}
      </span>
      : <span className="public-team-counts">Nobody listed in the latest read</span>}
  </Link>;
}
