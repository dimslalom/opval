import { useEffect, useMemo, useState } from 'react';
import { EVENTS, currentEvents } from '../lib/events';
import MatchCard from '../components/MatchCard';
import { fetchSchedule } from '../lib/feed';
import { useGame } from '../lib/gameContext';
import { dayKey, longDay, todayKey } from '../lib/time';

// An event's logo, or its name until the logo file exists.
function EventLogo({ event }) {
  const [ok, setOk] = useState(true);
  return ok
    ? <img className="event-logo" src={event.logo} alt={event.name} onError={() => setOk(false)} />
    : <span className="event-name">{event.name}</span>;
}

export default function Today() {
  const { state } = useGame();
  const [matches, setMatches] = useState(null);
  const [feedFailed, setFeedFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [day, setDay] = useState(null);
  const [eventId, setEventId] = useState(null);   // null = every event
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let live = true;
    Promise.all(EVENTS.map(async ev => {
      const schedule = await fetchSchedule(ev.id);
      return schedule?.map(m => ({ ...m, eventLabel: ev.name, eventId: ev.id })) ?? null;
    })).then(parts => {
      if (!live) return;
      setFeedFailed(parts.every(part => part === null));
      setMatches(parts.flatMap(part => part ?? []));
    }).catch(() => {
      if (live) { setFeedFailed(true); setMatches([]); }
    });
    return () => { live = false; };
  }, [reloadKey]);

  // The schedule refreshes itself: every 2 minutes while the page is visible, and at once when you
  // come back to it (the feed updates every 15 minutes). The old matches stay on screen until the
  // new ones arrive, so nothing flickers.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setReloadKey(key => key + 1); };
    const t = setInterval(refresh, 120000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  // Keeps LIVE/locked states honest without a refresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30000);
    return () => clearInterval(t);
  }, []);

  // Events with matches right now. One shows as a logo; several (Kickoff, Stages: one per
  // league) become a selector that filters the schedule.
  const running = currentEvents(EVENTS, matches ?? [], now);
  // The glow behind the header follows the event on show: the only one running, or the picked one.
  const glow = running.length === 1 ? running[0] : running.find(ev => ev.id === eventId);
  const visible = useMemo(
    () => (matches ?? []).filter(m => m.startsAt && (eventId == null || m.eventId === eventId)),
    [matches, eventId],
  );
  const days = useMemo(() => [...new Set(visible.map(m => dayKey(m.startsAt)))].sort(), [visible]);

  // If nothing plays today, lead with the next day people can still call.
  const today = todayKey();
  const current = day ?? (days.includes(today) ? today : (days.find(d => d > today) ?? days.at(-1) ?? today));
  const dayMatches = visible.filter(m => dayKey(m.startsAt) === current).sort((x, y) => x.startsAt - y.startsAt);

  const live = dayMatches.filter(m => m.status === 'live' || (m.status === 'upcoming' && m.startsAt <= now));
  const later = dayMatches.filter(m => m.status === 'upcoming' && m.startsAt > now);
  const earlier = dayMatches.filter(m => m.status === 'final').reverse();
  const isToday = current === today;
  const prev = days.filter(d => d < current).pop();
  const next = days.find(d => d > current);
  const openMatches = visible.filter(m => m.status === 'upcoming' && m.startsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  const callsMade = openMatches.filter(m => state?.calls[m.matchId]?.winner).length;
  const nextOpenDay = openMatches.length ? dayKey(openMatches[0].startsAt) : null;

  const card = m => <MatchCard key={m.matchId} match={m} eventLabel={m.eventLabel} now={now} />;

  return (
    <section className="matches-page">
      <header className="matches-intro" style={glow ? { '--event': glow.color } : undefined}>
        <h1>Matches</h1>
        {running.length === 1 && <EventLogo event={running[0]} />}
        {running.length > 1 && (
          <div className="event-pick" role="group" aria-label="Event">
            <button aria-pressed={eventId == null} onClick={() => { setEventId(null); setDay(null); }}>All</button>
            {running.map(ev => (
              <button key={ev.id} aria-pressed={eventId === ev.id} aria-label={ev.name} onClick={() => { setEventId(ev.id); setDay(null); }}>
                <EventLogo event={ev} />
              </button>
            ))}
          </div>
        )}
      </header>
      {matches != null && <div className="matches-overview" aria-label="Call status">
        <span><strong>{openMatches.length}</strong> open</span>
        <span><strong>{callsMade}</strong> called</span>
        {live.length > 0 && <span><strong>{live.length}</strong> live</span>}
        {nextOpenDay && <button type="button" className="secondary next-open" hidden={nextOpenDay === current} onClick={() => setDay(nextOpenDay)}>Next open</button>}
      </div>}
      <div className="day-switch">
        <button aria-label="Previous day with matches" disabled={!prev} onClick={() => setDay(prev)}>&larr;</button>
        <div><h2>{longDay(current)}</h2></div>
        <button aria-label="Next day with matches" disabled={!next} onClick={() => setDay(next)}>&rarr;</button>
      </div>

      {matches == null && <p className="note">Loading the schedule</p>}
      {feedFailed && <p className="note" role="alert">The schedule isn't available right now. <button className="link" onClick={() => { setMatches(null); setFeedFailed(false); setReloadKey(key => key + 1); }}>Try again</button></p>}
      {matches != null && !feedFailed && dayMatches.length === 0 && (
        <p className="note">
          No matches on this day.{' '}
          {prev && <button className="link" onClick={() => setDay(prev)}>Previous matches</button>}
          {prev && next && ' or '}
          {next && <button className="link" onClick={() => setDay(next)}>next matches</button>}
        </p>
      )}

      {live.length > 0 && <><h2 className="section">Live</h2>{live.map(card)}</>}
      {later.length > 0 && <><h2 className="section">{isToday ? 'Later today' : 'Upcoming'}</h2>{later.map(card)}</>}
      {earlier.length > 0 && <><h2 className="section">{isToday ? 'Earlier today' : 'Results'}</h2>{earlier.map(card)}</>}
    </section>
  );
}
