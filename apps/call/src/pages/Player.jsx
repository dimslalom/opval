import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Crest } from '../components/Face';
import RosterSource from '../components/RosterSource';
import RosterTimeline from '../components/RosterTimeline';
import RosterEvidence from '../components/RosterEvidence';
import { teamPath, title, useRoster, windowText } from '../lib/roster';

// One person's tenures across tracked teams. Anything before tracking or outside the tracked
// leagues is simply not here, and the page says so.
export default function Player() {
  const { personId } = useParams();
  const { data, error } = useRoster(`/api/roster/v2/people/${encodeURIComponent(personId)}`);
  const [selectedId, setSelectedId] = useState(null);
  const shown = data && data.person.id === Number(personId) ? data : null;
  const memberships = useMemo(() => shown?.memberships ?? [], [shown]);
  const tracked = Math.min(...(shown?.sources ?? []).map(s => s.trackedSince ?? Infinity));
  const rows = useMemo(() => {
    const byTeam = new Map();
    for (const m of memberships) {
      if (!byTeam.has(m.teamId)) byTeam.set(m.teamId, { key: m.teamId, label: m.team, tenures: [], current: false });
      const row = byTeam.get(m.teamId);
      row.tenures.push(m);
      if (!m.left) row.current = true;
      if (m.kind !== 'player') row.tag = title(m.role);
    }
    return [...byTeam.values()].sort((a, b) => b.current - a.current
      || Math.max(...b.tenures.map(m => m.lastSeenAt)) - Math.max(...a.tenures.map(m => m.lastSeenAt)));
  }, [memberships]);
  const selected = memberships.find(m => m.id === selectedId) ?? null;
  const newestFirst = [...memberships].sort((a, b) => b.joined.by - a.joined.by);

  return <section className="roster-page team-page">
    <p className="team-back"><Link to="/">All rosters</Link></p>
    {error && <p className="error" role="alert">{error}</p>}
    {!shown && !error && <p className="loading">Loading player</p>}
    {shown && <>
      <h1>{shown.person.handle}</h1>
      {Number.isFinite(tracked) && <section className="roster-block" aria-label="Timeline">
        <RosterTimeline rows={rows} trackedSince={tracked} latestRead={shown.latestRead} selectedId={selectedId}
          onSelect={m => setSelectedId(m.id)} />
      </section>}

      <section className="roster-block">
        <h2 className="sum"><b>{memberships.length}</b><span>{memberships.length === 1 ? 'tenure' : 'tenures'} on tracked teams</span></h2>
        <ul className="team-list player-tenures">
          {newestFirst.map(m => <li key={m.id}>
            <Link className="player-team" to={teamPath(m)}><Crest name={m.team} size={26} /><b>{m.team}</b></Link>
            <span className="team-cell"><small>Role</small>{title(m.role)}</span>
            <span className="team-cell"><small>Joined</small>{windowText(m.joined)}</span>
            <span className="team-cell"><small>Left</small>{m.left ? windowText(m.left) : 'Still listed'}</span>
            <button type="button" className="ghost player-evidence" onClick={() => setSelectedId(m.id)}>Evidence</button>
          </li>)}
        </ul>
        <p className="note">Only teams OpVAL tracks appear here, from when tracking began.</p>
      </section>

      <section className="roster-block">
        <h2 className="sum"><span>Evidence</span></h2>
        <RosterSource sources={shown.sources} now={shown.generatedAt} />
      </section>
      <RosterEvidence membership={selected} sources={shown.sources} from="person" onClose={() => setSelectedId(null)} />
    </>}
  </section>;
}
