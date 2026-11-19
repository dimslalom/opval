import { Link } from 'react-router-dom';
import Sheet from './Sheet';
import { rosterDay as day } from '../lib/time';
import { PRECISION, PRESENCE, personPath, teamPath, title, windowText } from '../lib/roster';

// What one tenure rests on: the source, the reads that bound it, and what that means for the
// selected date. Opened from the timeline, the lineup or the change list.
export default function RosterEvidence({ membership: m, sources, onClose, from }) {
  const source = m && sources.find(s => s.id === m.sourceId);
  return <Sheet open={Boolean(m)} onClose={onClose} title={m ? m.handle : 'Evidence'}>
    {m && <div className="evidence">
      <p className="evidence-presence" data-presence={m.presence}>{PRESENCE[m.presence]}</p>
      <dl>
        <div><dt>Team</dt><dd>{from === 'team' ? m.team : <Link to={teamPath(m)} onClick={onClose}>{m.team}</Link>}</dd></div>
        <div><dt>Role</dt><dd>{title(m.role)}</dd></div>
        <div><dt>Status</dt><dd>{title(m.status)}</dd></div>
        <div><dt>Contract ends</dt><dd>{m.contractEnd ?? 'Not listed'}{m.contractPrecision && <small>{PRECISION[m.contractPrecision]}</small>}</dd></div>
        <div><dt>Joined</dt><dd>{windowText(m.joined)}</dd></div>
        <div><dt>{m.left ? 'Last listed' : 'Latest read listing them'}</dt><dd>{day(m.lastSeenAt)}</dd></div>
        {m.left && <div><dt>Left</dt><dd>{windowText(m.left)}</dd></div>}
        <div><dt>Source</dt><dd>{source ? <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> : m.sourceId}</dd></div>
      </dl>
      <p className="note">Dates come from when the source was read, not from announcements. A change shows as a range from the last read before it to the first read after it.</p>
      {from !== 'person' && <Link className="secondary evidence-link" to={personPath(m)} onClick={onClose}>{m.handle}'s history</Link>}
    </div>}
  </Sheet>;
}
