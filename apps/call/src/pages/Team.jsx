import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Crest } from '../components/Face';
import RosterSource from '../components/RosterSource';
import RosterTimeline from '../components/RosterTimeline';
import RosterEvidence from '../components/RosterEvidence';
import PersonPhoto from '../components/PersonPhoto';
import { rosterDay as day } from '../lib/time';
import { DAY, endOf, isoDay, isoOf, title, useRoster, validIso, windowText } from '../lib/roster';
import { assignSeats, lineupEras } from '../lib/seats';

const KIND = { player: 'Players', coach: 'Coaches', staff: 'Staff' };
const month = t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
// Status values that are the default for their section, so not worth a flag.
const NORMAL = new Set(['active', 'staff']);

// One team at a chosen date. The date, the timeline marker, the lineup and the evidence panel all
// follow the same `on` (kept in the URL, so links and back/forward reproduce the view).
export default function Team() {
  const { teamId } = useParams();
  const [params, setParams] = useSearchParams();
  const today = isoDay(new Date());
  const on = validIso(params.get('on')) ?? today;
  const setOn = iso => setParams(iso >= today ? {} : { on: iso }, { replace: true });
  // Today asks for the latest read; a past day asks for its end.
  const { data, error, loading } = useRoster(`/api/roster/v2/teams/${encodeURIComponent(teamId)}${on === today ? '' : `?at=${endOf(on)}`}`);
  const [selectedId, setSelectedId] = useState(null);

  const shown = data && data.team.id === Number(teamId) ? data : null;
  const memberships = useMemo(() => shown?.memberships ?? [], [shown]);
  const listed = memberships.filter(m => m.presence === 'present' || m.presence === 'possible');
  // When this team first appears in its source (a promoted team appears later than the source began).
  const tracked = Math.min(...memberships.map(m => m.joined.by));
  const before = shown && Number.isFinite(tracked) && endOf(on) < tracked;
  const rows = useMemo(() => {
    const byPerson = new Map();
    for (const m of memberships) {
      if (!byPerson.has(m.personId)) byPerson.set(m.personId, { key: m.personId, label: m.handle, tenures: [] });
      if (m.kind !== 'player') byPerson.get(m.personId).tag = title(m.role);
      byPerson.get(m.personId).tenures.push(m);
    }
    // People listed on the selected date first (players, then staff, longest-serving first), then
    // everyone else by how recently they were last listed.
    const KIND_ORDER = { player: 0, coach: 1, staff: 2 };
    const sortKey = row => {
      const now = row.tenures.find(m => m.presence === 'present' || m.presence === 'possible');
      const last = Math.max(...row.tenures.map(m => m.lastSeenAt));
      return now ? [0, KIND_ORDER[now.kind] ?? 3, now.joined.by] : [1, 0, -last];
    };
    return [...byPerson.values()].map(row => ({ row, key: sortKey(row) }))
      .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
      .map(x => ({ ...x.row, current: x.key[0] === 0 }));
  }, [memberships]);
  // The text twin of the timeline: every join and departure seen between two reads, newest first.
  const changes = useMemo(() => memberships.flatMap(m => [
    ...(m.joined.after != null ? [{ m, verb: 'Joined', w: m.joined }] : []),
    ...(m.left && !m.left.teamExit ? [{ m, verb: 'Left', w: m.left }] : []),
  ]).sort((a, b) => b.w.by - a.w.by), [memberships]);
  const selected = memberships.find(m => m.id === selectedId) ?? null;
  const eras = useMemo(() => (shown ? lineupEras(memberships, shown.reads ?? [], shown.latestRead) : []), [shown, memberships]);
  // Lineup periods, oldest first, as alternating bands behind the timeline.
  const bands = useMemo(() => eras.map(e => ({ start: e.start, end: e.next ?? shown.latestRead })).reverse(), [eras, shown]);
  const seats = useMemo(() => assignSeats(memberships), [memberships]);
  // When they joined, at the precision the reads allow: a month when the window is short, the
  // whole window when the reads were far apart.
  const since = m => {
    if (m.joined.after == null) return `Since ${month(m.joined.by)} or earlier`;
    const verb = returning(m) ? 'Back' : 'Joined';
    if (m.joined.by - m.joined.after > 45 * DAY) return `${verb} ${month(m.joined.after)} to ${month(m.joined.by)}`;
    return `${returning(m) ? 'Back since' : 'Since'} ${month(m.joined.by)}`;
  };
  // Why someone is only possibly listed on the chosen date.
  const possibleNote = m => {
    const at = endOf(on);
    if (m.left && at >= m.left.after) return 'Left around this date';
    if (at > m.lastSeenAt) return `Last listed ${month(m.lastSeenAt)}`;
    return 'Joined around this date';
  };
  // An earlier tenure on this team means this one is a return.
  const returning = m => memberships.some(o => o.personId === m.personId && o.kind === m.kind && o.joined.by < m.joined.by);

  return <section className="roster-page team-page">
    <p className="team-back"><Link to={shown ? `/?league=${shown.team.league}` : '/'}>All rosters</Link></p>
    {error && <p className="error" role="alert">{error}</p>}
    {!shown && !error && <p className="loading">Loading roster</p>}
    {shown && <>
      <header className="team-head">
        <Crest name={shown.team.name} size={56} />
        <div>
          <h1>{shown.team.name}</h1>
          <p className="team-meta"><span>{shown.team.league}</span>{shown.team.tag && <span>{shown.team.tag}</span>}</p>
        </div>
      </header>

      <div className="team-date" data-loading={loading}>
        <label htmlFor="roster-on">Roster on</label>
        <input id="roster-on" type="date" value={on} max={today} onChange={e => e.target.value && setOn(e.target.value)} />
        {on !== today && <button type="button" className="secondary" onClick={() => setOn(today)}>Today</button>}
        {on === today && endOf(today) - shown.latestRead > 2 * DAY && <p className="team-stale">Latest read {day(shown.latestRead)}. Nothing newer is known yet.</p>}
        <Link className="secondary team-compare" to={`/compare?a=${shown.team.id}&ad=${on === today ? isoOf(Math.max(tracked, endOf(on) - 28 * DAY)) : on}&b=${shown.team.id}`}>Compare dates</Link>
      </div>

      {before
        ? <p className="note">This team first appears in the source on {day(tracked)}. Who was on it before that is not known.</p>
        : ['player', 'coach', 'staff'].map(kind => {
          const list = listed.filter(m => m.kind === kind)
            // Seat order keeps a lineup stable across dates; reserves and the like sit after the actives.
            .sort((a, b) => NORMAL.has(b.status) - NORMAL.has(a.status) || (seats.get(a.id)?.seat ?? 99) - (seats.get(b.id)?.seat ?? 99));
          if (!list.length) return null;
          const isSeats = kind === 'player';
          // The contract end most of the section shares is said once, in its header; tiles show
          // only the exceptions. (Two or more people must share it, or every tile shows its own.)
          const counts = list.reduce((out, m) => out.set(m.contractEnd, (out.get(m.contractEnd) ?? 0) + 1), new Map());
          const [commonEnd, commonCount] = [...counts].sort((a, b) => b[1] - a[1])[0];
          const sameEnd = commonCount > 1 || list.length === 1 ? commonEnd : undefined;
          return <section key={kind} className="roster-block">
            <header className="lineup-head">
              <h2 className="sum"><b>{list.length}</b><span>{KIND[kind]}</span></h2>
              {sameEnd !== undefined && <p className="lineup-common">{sameEnd ? `${list.length === commonCount ? 'Contracts end' : 'Most contracts end'} ${sameEnd}` : 'No contract end listed'}</p>}
            </header>
            <ul className={isSeats ? 'lineup seats' : 'lineup'} style={isSeats ? { '--n': Math.min(list.length, 6) } : undefined}>
              {list.map(m => <li key={m.id} data-presence={m.presence}>
                <button type="button" className="lineup-tile" onClick={() => setSelectedId(m.id)}>
                  <PersonPhoto handle={m.handle} team={shown.team.name} />
                  <b className="lineup-name">{m.handle}</b>
                  {kind !== 'player' && <small>{title(m.role)}</small>}
                  {isSeats && <small>{since(m)}</small>}
                  {isSeats && seats.get(m.id)?.after && m.joined.by - m.joined.after <= 45 * DAY && <small className="seat-after">{returning(m) ? 'Returned' : 'Joined'} as {seats.get(m.id).after} left</small>}
                  {!NORMAL.has(m.status) && <small className="lineup-flag">{title(m.status)}</small>}
                  {m.contractEnd !== sameEnd && <small>{m.contractEnd ? `Contract ends ${m.contractEnd}` : 'No contract end listed'}</small>}
                  {m.presence === 'possible' && <small className="lineup-flag">{possibleNote(m)}</small>}
                </button>
              </li>)}
            </ul>
          </section>;
        })}
      {!before && listed.length === 0 && <p className="note">Nobody is listed for this team on this date.</p>}

      {Number.isFinite(tracked) && <section className="roster-block" aria-label="Who was here when">
        <h2 className="sum"><span>Who was here when</span></h2>
        <RosterTimeline rows={rows} trackedSince={tracked} latestRead={shown.latestRead} reads={shown.reads} bands={bands} at={endOf(on)} selectedId={selectedId}
          onPickDate={t => setOn(isoOf(t))} onSelect={m => setSelectedId(m.id)} />
      </section>}

      <section className="roster-block">
        <h2 className="sum"><b>{changes.length}</b><span>{changes.length === 1 ? 'change' : 'changes'} since tracking began</span></h2>
        {changes.length > 0 && <p className="note">Dates are ranges: after the last read that showed the old roster, by the first read that showed the new one.</p>}
        {changes.length === 0
          ? <p className="note">No joins or departures between reads yet.</p>
          : <ul className="change-list">
            {changes.map(({ m, verb, w }) => <li key={`${m.id}-${verb}`}>
              <span className="change-verb" data-verb={verb}>{verb}</span>
              <button type="button" className="change-who" onClick={() => setSelectedId(m.id)}><PersonPhoto handle={m.handle} team={m.team} size="chip" />{m.handle}</button>
              <span className="change-role">{m.kind === 'player' ? '' : title(m.role)}</span>
              <span className="change-when">{windowText(w)}</span>
            </li>)}
          </ul>}
      </section>

      <section className="roster-block">
        <h2 className="sum"><span>Evidence</span></h2>
        <RosterSource sources={shown.sources} now={shown.generatedAt} />
      </section>

      <RosterEvidence membership={selected} sources={shown.sources} from="team" onClose={() => setSelectedId(null)} />
    </>}
  </section>;
}
