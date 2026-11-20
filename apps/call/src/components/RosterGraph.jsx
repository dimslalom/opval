import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Crest } from './Face';
import { personPath, teamPath } from '../lib/roster';

const year = t => new Date(t * 1000).getFullYear();
const span = l => (year(l.first) === year(l.last) ? `${year(l.first)}` : `${year(l.first)} to ${l.open ? 'now' : year(l.last)}`);
const MAX_PEOPLE = 40;
const MAX_TEAMS = 30;
const ROW = 26;

// Who this team's people have also played for, as a two-column graph: the team's people on the left
// (current first), the other tracked teams on the right (most shared people first), one line per
// tenure. The layout is fixed by those orders, so it never reshuffles. Pointing at a person or a team
// lights up its links; the list below says the same thing in text for keyboards and screen readers.
// Links are tenures in Riot's data only: playing on the same team is not a measure of chemistry.
export default function RosterGraph({ teamId, links }) {
  const [hot, setHot] = useState(null); // { personId } or { teamId }
  const home = new Map();
  for (const l of links.filter(l => l.teamId === teamId)) {
    const p = home.get(l.personId) ?? { personId: l.personId, handle: l.handle, open: false, last: 0 };
    p.open ||= l.open;
    p.last = Math.max(p.last, l.last);
    home.set(l.personId, p);
  }
  const people = [...home.values()].sort((a, b) => b.open - a.open || b.last - a.last).slice(0, MAX_PEOPLE);
  const shown = new Set(people.map(p => p.personId));
  const away = links.filter(l => l.teamId !== teamId && shown.has(l.personId));
  const teamsById = new Map();
  for (const l of away) {
    const t = teamsById.get(l.teamId) ?? { teamId: l.teamId, team: l.team, people: new Map() };
    t.people.set(l.personId, l);
    teamsById.set(l.teamId, t);
  }
  const teams = [...teamsById.values()].sort((a, b) => b.people.size - a.people.size || a.team.localeCompare(b.team)).slice(0, MAX_TEAMS);
  const teamRow = new Map(teams.map((t, i) => [t.teamId, i]));
  const personRow = new Map(people.map((p, i) => [p.personId, i]));
  const height = Math.max(people.length, teams.length, 1) * ROW + 10;
  const lit = l => (hot?.personId === l.personId || hot?.teamId === l.teamId);
  const hover = h => ({ onMouseEnter: () => setHot(h), onMouseLeave: () => setHot(null), onFocus: () => setHot(h), onBlur: () => setHot(null) });

  if (!teams.length) return <p className="note">Nobody from this team has been listed on another tracked team.</p>;
  return <div className="graph">
    <svg viewBox={`0 0 600 ${height}`} className="graph-svg" aria-hidden="true">
      {away.filter(l => teamRow.has(l.teamId)).map(l => {
        const y1 = personRow.get(l.personId) * ROW + 18, y2 = teamRow.get(l.teamId) * ROW + 18;
        return <path key={`${l.personId}-${l.teamId}-${l.kind}`} d={`M200 ${y1} C300 ${y1} 300 ${y2} 400 ${y2}`}
          className="graph-edge" data-lit={hot ? lit(l) : undefined} data-open={l.open} />;
      })}
      {people.map((p, i) => <text key={p.personId} x="190" y={i * ROW + 22} textAnchor="end" className="graph-person"
        data-lit={hot ? hot.personId === p.personId || [...(teamsById.get(hot.teamId)?.people.keys() ?? [])].includes(p.personId) : undefined}
        data-open={p.open} {...hover({ personId: p.personId })}>{p.handle}</text>)}
      {teams.map((t, i) => <text key={t.teamId} x="410" y={i * ROW + 22} className="graph-team"
        data-lit={hot ? hot.teamId === t.teamId || t.people.has(hot.personId) : undefined} {...hover({ teamId: t.teamId })}>
        {t.team} ({t.people.size})</text>)}
    </svg>
    <p className="tl-legend"><span><i className="graph-key-open" />Still listed there</span><span><i className="graph-key-past" />Earlier tenure</span></p>
    <ul className="graph-list" aria-label="Also played for">
      {teams.map(t => <li key={t.teamId} data-lit={hot ? hot.teamId === t.teamId || t.people.has(hot.personId) : undefined}>
        <Link className="graph-list-team" to={teamPath({ id: t.teamId, name: t.team })} {...hover({ teamId: t.teamId })}><Crest name={t.team} size={22} /><b>{t.team}</b></Link>
        <span className="graph-list-people">{[...t.people.values()].map(l => <Link key={l.personId} to={personPath(l)} {...hover({ personId: l.personId })}>
          {l.handle} <small>{span(l)}</small></Link>)}</span>
      </li>)}
    </ul>
    {(home.size > MAX_PEOPLE || teamsById.size > MAX_TEAMS) && <p className="note">Showing the {people.length} most recent people and the {teams.length} teams they share most.</p>}
  </div>;
}
