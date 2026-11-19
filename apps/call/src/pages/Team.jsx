import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Crest } from '../components/Face';
import RosterSource from '../components/RosterSource';
import RosterTimeline from '../components/RosterTimeline';
import RosterEvidence from '../components/RosterEvidence';
import PersonPhoto from '../components/PersonPhoto';
import { rosterDay as day } from '../lib/time';
import { DAY, endOf, isoDay, isoOf, title, useRoster, validIso, windowText } from '../lib/roster';
import { assignSeats, lineupEras } from '../lib/seats';
import { dismiss, isDismissed, lastVisit, markVisit, setSuggestionsOff, suggestionsOff } from '../lib/visits';

const KIND = { player: 'Players', coach: 'Coaches', staff: 'Staff' };
const announcedDay = iso => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
  // Today asks for the latest read; a past day asks for its end. `rev` refetches after new data.
  const [rev, setRev] = useState(0);
  const query = [on === today ? null : `at=${endOf(on)}`, rev ? `rev=${rev}` : null].filter(Boolean).join('&');
  const { data, error, loading } = useRoster(`/api/roster/v2/teams/${encodeURIComponent(teamId)}${query ? `?${query}` : ''}`);
  const [selectedId, setSelectedId] = useState(null);
  // The person under the pointer or keyboard focus, highlighted in the lineup, timeline and changes at once.
  const [hot, setHot] = useState(null);
  const hover = id => ({ onMouseEnter: () => setHot(id), onMouseLeave: () => setHot(null), onFocus: () => setHot(id), onBlur: () => setHot(null) });
  // What you last saw of this team (read once per team, before this visit is recorded).
  const prevVisit = useMemo(() => lastVisit(teamId), [teamId]);
  const [fresh, setFresh] = useState(false);
  const [allSince, setAllSince] = useState(false);
  const [, setPrefs] = useState(0); // re-render after a suggestion is dismissed or turned off

  const shown = data && data.team.id === Number(teamId) ? data : null;
  const memberships = useMemo(() => shown?.memberships ?? [], [shown]);
  const listed = memberships.filter(m => m.presence === 'present' || m.presence === 'possible');
  // Today's lineup puts manual entries first: announced or reported leaves drop out, joins come in.
  const manual = on === today ? (shown?.announced ?? []) : [];
  const leaving = new Set(manual.filter(a => a.move === 'leave').map(a => `${a.kind}|${a.handle.toLowerCase()}`));
  const BASIS = { announced: 'Announced', reported: 'Reported' };
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
  // Record this visit once today's data is on screen; the next visit compares against it.
  useEffect(() => { if (shown && on === today) markVisit(teamId, shown.latestRead); }, [shown, on, today, teamId]);
  // While you read, check quietly for a newer read. Nothing changes on screen until you ask.
  useEffect(() => {
    if (!shown || on !== today) return undefined;
    const source = shown.sources[0];
    const timer = setInterval(async () => {
      try {
        const latest = (await (await fetch('/api/roster/v2/teams')).json()).sources.find(s => s.id === source?.id);
        if (latest?.lastChangeAt > (source?.lastChangeAt ?? 0)) setFresh(true);
      } catch { /* offline: try again next time */ }
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [shown, on, today]);
  const sinceVisit = shown && on === today && prevVisit && shown.latestRead > prevVisit.read ? changes.filter(c => c.w.by > prevVisit.read) : [];
  const latestChange = changes[0];
  const suggestKey = latestChange && `compare-${teamId}-${latestChange.w.by}`;
  const showSuggestion = on === today && latestChange && !suggestionsOff() && !isDismissed(suggestKey);
  const thisYear = new Date().getFullYear();
  const endsThisYear = end => Number(/\d{4}/.exec(end ?? '')?.[0]) === thisYear;

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
        {fresh && <p className="team-fresh" role="status">New roster data is in.
          <button type="button" className="ghost" onClick={() => { setFresh(false); setRev(r => r + 1); }}>Show it</button></p>}
        <Link className="secondary team-compare" to={`/compare?a=${shown.team.id}&ad=${on === today ? isoOf(Math.max(tracked, endOf(on) - 28 * DAY)) : on}&b=${shown.team.id}`}>Compare dates</Link>
      </div>

      {sinceVisit.length > 0 && <section className="roster-block since-visit" aria-label="Since your last visit">
        <h2 className="sum"><b>{sinceVisit.length}</b><span>{sinceVisit.length === 1 ? 'change' : 'changes'} since your last visit on {day(prevVisit.at)}</span></h2>
        <ul className="change-list">
          {(allSince ? sinceVisit : sinceVisit.slice(0, 6)).map(({ m, verb, w }) => <li key={`${m.id}-${verb}`} data-hot={hot === m.personId} {...hover(m.personId)}>
            <span className="change-verb" data-verb={verb}>{verb}</span>
            <button type="button" className="change-who" onClick={() => setSelectedId(m.id)}><PersonPhoto handle={m.handle} team={m.team} size="chip" />{m.handle}</button>
            <span className="change-role">{m.kind === 'player' ? '' : title(m.role)}</span>
            <span className="change-when">{windowText(w)}</span>
          </li>)}
        </ul>
        {sinceVisit.length > 6 && <button type="button" className="ghost" onClick={() => setAllSince(v => !v)}>{allSince ? 'Show fewer' : `Show all ${sinceVisit.length}`}</button>}
      </section>}

      {/* The roster "on" a day is its end, so the day before the last unchanged read is safely before. */}
      {showSuggestion && <aside className="suggest">
        <Link to={`/compare?a=${shown.team.id}&ad=${isoOf((latestChange.w.after ?? latestChange.w.by) - DAY)}&b=${shown.team.id}&bd=${isoOf(latestChange.w.by)}`}>
          Compare the lineup before and after the latest change ({latestChange.m.handle} {latestChange.verb.toLowerCase()})</Link>
        <button type="button" className="ghost" onClick={() => { dismiss(suggestKey); setPrefs(n => n + 1); }}>Dismiss</button>
        <button type="button" className="ghost" onClick={() => { setSuggestionsOff(true); setPrefs(n => n + 1); }}>Turn off suggestions</button>
      </aside>}

      {before
        ? <p className="note">This team first appears in the source on {day(tracked)}. Who was on it before that is not known.</p>
        : ['player', 'coach', 'staff'].map(kind => {
          const riot = listed.filter(m => m.kind === kind && !leaving.has(`${kind}|${m.handle.toLowerCase()}`))
            // Seat order keeps a lineup stable across dates; reserves and the like sit after the actives.
            .sort((a, b) => NORMAL.has(b.status) - NORMAL.has(a.status) || (seats.get(a.id)?.seat ?? 99) - (seats.get(b.id)?.seat ?? 99));
          const joining = manual.filter(a => a.move === 'join' && a.kind === kind);
          const list = [...riot, ...joining.map(a => ({ id: `manual-${a.id}`, handle: a.handle, manual: a }))];
          if (!list.length) return null;
          const isSeats = kind === 'player';
          // The contract end most of the section shares is said once, in its header; tiles show
          // only the exceptions. (Two or more people must share it, or every tile shows its own.)
          // (Only Riot's rows have contracts; manual entries never do.)
          const counts = riot.reduce((out, m) => out.set(m.contractEnd, (out.get(m.contractEnd) ?? 0) + 1), new Map());
          const [commonEnd, commonCount] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
          const sameEnd = commonCount > 1 || riot.length === 1 ? commonEnd : undefined;
          return <section key={kind} className="roster-block">
            <header className="lineup-head">
              <h2 className="sum"><b>{list.length}</b><span>{KIND[kind]}</span></h2>
              {sameEnd !== undefined && <p className="lineup-common" data-due={on === today && endsThisYear(sameEnd)}>{sameEnd ? `${riot.length === commonCount && !joining.length ? 'Contracts end' : 'Most contracts end'} ${sameEnd}` : 'No contract end listed'}{on === today && endsThisYear(sameEnd) && <span className="lineup-due">This year</span>}</p>}
            </header>
            <ul className={isSeats ? 'lineup seats' : 'lineup'} style={isSeats ? { '--n': Math.min(list.length, 6) } : undefined}>
              {list.map(m => m.manual ? <li key={m.id} data-manual={m.manual.basis}>
                <a className="lineup-tile" href={m.manual.sourceUrl ?? undefined} target="_blank" rel="noreferrer">
                  <PersonPhoto handle={m.handle} team={shown.team.name} />
                  <b className="lineup-name">{m.handle}</b>
                  {kind !== 'player' && <small>{title(kind)}</small>}
                  <small className="lineup-flag">{BASIS[m.manual.basis]} {announcedDay(m.manual.announcedOn)}</small>
                  <small>Not yet in Riot's database</small>
                </a>
              </li> : <li key={m.id} data-presence={m.presence} data-hot={hot === m.personId}>
                <button type="button" className="lineup-tile" onClick={() => setSelectedId(m.id)} {...hover(m.personId)}>
                  <PersonPhoto handle={m.handle} team={shown.team.name} />
                  <b className="lineup-name">{m.handle}</b>
                  {kind !== 'player' && <small>{title(m.role)}</small>}
                  {isSeats && <small>{since(m)}</small>}
                  {isSeats && seats.get(m.id)?.after && m.joined.by - m.joined.after <= 45 * DAY && <small className="seat-after">{returning(m) ? 'Returned' : 'Joined'} as {seats.get(m.id).after} left</small>}
                  {!NORMAL.has(m.status) && <small className="lineup-flag">{title(m.status)}</small>}
                  {m.contractEnd !== sameEnd && <small data-due={on === today && endsThisYear(m.contractEnd)}>{m.contractEnd ? `Contract ends ${m.contractEnd}` : 'No contract end listed'}</small>}
                  {m.presence === 'possible' && <small className="lineup-flag">{possibleNote(m)}</small>}
                </button>
              </li>)}
            </ul>
          </section>;
        })}
      {!before && listed.length === 0 && <p className="note">Nobody is listed for this team on this date.</p>}

      {on === today && shown.announced?.length > 0 && <section className="roster-block">
        <h2 className="sum"><b>{shown.announced.length}</b><span>{shown.announced.length === 1 ? 'change' : 'changes'} not yet in Riot's database</span></h2>
        <ul className="change-list">
          {shown.announced.map(a => <li key={a.id}>
            <span className="change-verb" data-verb={a.move === 'join' ? 'Joined' : 'Left'}>{a.move === 'join' ? 'Joining' : 'Leaving'}</span>
            <span className="change-who"><PersonPhoto handle={a.handle} team={shown.team.name} size="chip" />{a.handle}</span>
            <span className="change-role">{a.kind === 'player' ? '' : title(a.kind)}</span>
            <span className="change-when">{a.sourceUrl
              ? <a href={a.sourceUrl} target="_blank" rel="noreferrer">{BASIS[a.basis]} {announcedDay(a.announcedOn)}</a>
              : `${BASIS[a.basis]} ${announcedDay(a.announcedOn)}`}</span>
          </li>)}
        </ul>
        <p className="note">Added by hand. Announced means the team said so; reported means journalists' sources did. Both are shown in the lineup above, ahead of Riot's contract database, until Riot's database lists the change.</p>
      </section>}

      {Number.isFinite(tracked) && <section className="roster-block" aria-label="Who was here when">
        <h2 className="sum"><span>Who was here when</span></h2>
        <RosterTimeline rows={rows} trackedSince={tracked} latestRead={shown.latestRead} reads={shown.reads} bands={bands} at={endOf(on)} selectedId={selectedId}
          onPickDate={t => setOn(isoOf(t))} onSelect={m => setSelectedId(m.id)} hotKey={hot} onHover={setHot} />
      </section>}

      <section className="roster-block">
        <h2 className="sum"><b>{changes.length}</b><span>{changes.length === 1 ? 'change' : 'changes'} since tracking began</span></h2>
        {changes.length > 0 && <p className="note">Dates are ranges: after the last read that showed the old roster, by the first read that showed the new one.</p>}
        {changes.length === 0
          ? <p className="note">No joins or departures between reads yet.</p>
          : <ul className="change-list">
            {changes.map(({ m, verb, w }) => <li key={`${m.id}-${verb}`} data-hot={hot === m.personId} {...hover(m.personId)}>
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
