import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Crest } from '../components/Face';
import PersonPhoto from '../components/PersonPhoto';
import { endOf, isoDay, personPath, teamPath, title, useRoster, validIso } from '../lib/roster';

// Two rosters side by side: two teams on one date, or one team on two dates. People are matched
// by identity, never by handle text. All state lives in the URL: ?a=&ad=&b=&bd=
const listed = m => m.presence === 'present' || m.presence === 'possible';

function Side({ name, label, side: { id, on, shown, error }, params, setParams, teams, today }) {
  const [query, setQuery] = useState('');
  const set = patch => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };
  const q = query.trim().toLowerCase();
  const matches = q ? teams.filter(t => `${t.name} ${t.tag ?? ''}`.toLowerCase().includes(q)).slice(0, 6) : [];
  return <div className="compare-side">
    <h2 className="compare-label">{label}</h2>
    {shown && <p className="compare-team"><Crest name={shown.team.name} size={30} /><Link to={teamPath(shown.team)}>{shown.team.name}</Link></p>}
    <input className="roster-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={shown ? 'Change team' : 'Find a team'} aria-label={`${label} team`} />
    {matches.length > 0 && <div className="compare-picks">
      {matches.map(t => <button key={t.id} type="button" className="secondary" onClick={() => { set({ [name]: String(t.id) }); setQuery(''); }}>{t.name}</button>)}
    </div>}
    <div className="team-date">
      <label htmlFor={`on-${name}`}>On</label>
      <input id={`on-${name}`} type="date" value={on} max={today} onChange={e => e.target.value && set({ [`${name}d`]: e.target.value === today ? null : e.target.value })} />
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {id && !shown && !error && <p className="loading">Loading</p>}
    {shown && endOf(on) < Math.min(...shown.sources.map(s => s.trackedSince ?? Infinity)) && <p className="note">Before tracking began: not known.</p>}
  </div>;
}

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const today = isoDay(new Date());
  const { data: teamList } = useRoster('/api/roster/v2/teams');
  const teams = teamList?.teams ?? [];
  const a = useCompareSide('a', params, today);
  const b = useCompareSide('b', params, today);
  const people = new Map();
  for (const [side, d] of [['a', a.shown], ['b', b.shown]]) {
    for (const m of (d?.memberships ?? []).filter(listed)) {
      const entry = people.get(m.personId) ?? { m, a: null, b: null };
      entry[side] = m;
      people.set(m.personId, entry);
    }
  }
  const groups = [
    ['Only on the left', [...people.values()].filter(x => x.a && !x.b)],
    ['On both', [...people.values()].filter(x => x.a && x.b)],
    ['Only on the right', [...people.values()].filter(x => !x.a && x.b)],
  ];
  const ready = a.shown && b.shown;

  return <section className="roster-page">
    <h1>Compare</h1>
    <p className="note">Pick two teams, or the same team on two dates.</p>
    <div className="compare-grid">
      <Side name="a" label="Left" side={a} params={params} setParams={setParams} teams={teams} today={today} />
      <Side name="b" label="Right" side={b} params={params} setParams={setParams} teams={teams} today={today} />
    </div>
    {ready && <div className="compare-diff">
      {groups.map(([heading, list]) => <section key={heading} className="roster-block">
        <h2 className="sum"><b>{list.length}</b><span>{heading}</span></h2>
        {list.length === 0 ? <p className="note">Nobody.</p> : <ul className="team-list compare-list">
          {list.map(({ m, a: left, b: right }) => <li key={m.personId}>
            <Link className="change-who" to={personPath(m)}><PersonPhoto handle={m.handle} team={(left ?? right).team} size="chip" />{m.handle}</Link>
            <span className="change-role">{m.kind === 'player' ? '' : title((left ?? right).role)}</span>
            {left && right && left.role !== right.role && <span className="team-cell"><small>Role on the right</small>{title(right.role)}</span>}
            {left && right && left.status !== right.status && <span className="team-cell"><small>Status</small>{title(left.status)} to {title(right.status)}</span>}
            {left && right && left.contractEnd !== right.contractEnd && <span className="team-cell"><small>Contract ends</small>{left.contractEnd ?? 'Not listed'} to {right.contractEnd ?? 'Not listed'}</span>}
            {[left, right].some(x => x?.presence === 'possible') && <span className="team-uncertain">Changed around one of these dates</span>}
          </li>)}
        </ul>}
      </section>)}
    </div>}
  </section>;
}

function useCompareSide(name, params, today) {
  const id = params.get(name);
  const on = validIso(params.get(`${name}d`)) ?? today;
  const { data, error } = useRoster(id ? `/api/roster/v2/teams/${encodeURIComponent(id)}${on === today ? '' : `?at=${endOf(on)}`}` : null);
  return { id, on, error, shown: data && String(data.team.id) === id ? data : null };
}
