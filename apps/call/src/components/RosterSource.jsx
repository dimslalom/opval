import { rosterDay as day } from '../lib/time';

// One quiet line: which source a roster rests on and when it was last read. `now` is the server's
// generatedAt, so freshness matches the data it describes.
function ago(s, now) {
  const d = Math.max(0, now - s);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
}

// A daily source is stale after two missed days.
const STALE = 2 * 86400;

export default function RosterSource({ sources, now }) {
  if (!sources?.length) return <p className="roster-source">No roster source is active.</p>;
  return sources.map(s => {
    const stale = !s.lastSuccessAt || now - s.lastSuccessAt > STALE;
    return <p key={s.id} className="roster-source" data-stale={stale}>
      From the <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
      {s.lastSuccessAt ? <>, last read {day(s.lastSuccessAt)} <span className="roster-source-age">({ago(s.lastSuccessAt, now)})</span></> : ', not read yet'}.
      {stale && s.lastError && <span className="roster-source-error"> The last read failed.</span>}
    </p>;
  });
}
