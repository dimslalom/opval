import { useState } from 'react';
import { rosterDay as day } from '../lib/time';
import { DAY } from '../lib/roster';

const YEAR = 365 * DAY;

// How long a tenure was confirmed: first read listing them to last read listing them.
function length(seconds) {
  const d = seconds / DAY;
  if (d < 1) return null;
  if (d < 14) return `${Math.round(d)} d`;
  if (d < 60) return `${Math.round(d / 7)} wk`;
  if (d < 365) return `${Math.round(d / 30.4)} mo`;
  return `${(d / 365).toFixed(1)} yrs`;
}

// Who was here when, as a tenure ladder. The chart runs from the first read to the latest one (after
// the latest read nothing is known, so it isn't drawn). A solid bar is a span the source listed
// someone, read after read, with its length on it; the faded ends are the windows a join or
// departure happened in. Shaded bands behind are the team's lineups (bands: [{start, end}]). Ticks
// on the date strip are the reads themselves, so a long window explains itself. Clicking the strip
// (or an empty track) picks a date; a bar opens its evidence. The date input and the change list
// on the page are the keyboard and screen-reader equivalents.
// rows: [{ key, label, tag?, current, tenures }]; current rows come first, then former ones.
export default function RosterTimeline({ rows, trackedSince, latestRead, reads = [], bands = [], at, selectedId, onPickDate, onSelect, hotKey, onHover }) {
  const [allFormer, setAllFormer] = useState(false);
  const to = latestRead;
  const from = Math.min(trackedSince, to - 14 * DAY);
  const span = Math.max(1, to - from);
  const pct = t => `${((Math.min(Math.max(t, from), to) - from) / span) * 100}%`;
  const pick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    onPickDate(Math.round(from + ((e.clientX - r.left) / r.width) * span));
  };
  const years = [];
  for (let y = new Date(from * 1000).getFullYear() + 1; ; y++) {
    const t = new Date(y, 0, 1).getTime() / 1000;
    if (t >= to) break;
    years.push({ y, t });
  }

  const current = rows.filter(r => r.current);
  const former = rows.filter(r => !r.current);
  // Former members from the last two years of the chart; older ones on request.
  const recentFormer = former.filter(r => Math.max(...r.tenures.map(m => m.lastSeenAt)) >= to - 2 * YEAR);
  const shownFormer = allFormer ? former : recentFormer;
  const grid = <>
    {bands.map((b, i) => i % 2 === 1 && <span key={b.start} className="tl-band" style={{ left: pct(b.start), width: `calc(${pct(b.end)} - ${pct(b.start)})` }} />)}
    {years.map(({ y, t }) => <span key={y} className="tl-year" style={{ left: pct(t) }} />)}
  </>;

  const row = r => <div key={r.key} className="tl-row" data-hot={hotKey === r.key}
    onMouseEnter={onHover && (() => onHover(r.key))} onMouseLeave={onHover && (() => onHover(null))}>
    <span className="tl-label"><span className="tl-name">{r.label}</span>{r.tag && <small>{r.tag}</small>}</span>
    <div className="tl-track" onClick={onPickDate ? pick : undefined}>
      {grid}
      {trackedSince > from && <span className="tl-untracked" style={{ width: pct(trackedSince) }} />}
      {r.tenures.map(m => {
        const start = m.joined.after ?? m.joined.by;
        const end = m.left?.by ?? m.lastSeenAt;
        const width = Math.max(1, end - start);
        const share = (a, b) => `${((b - a) / width) * 100}%`;
        const confirmed = (m.left ? m.left.after : m.lastSeenAt) - m.joined.by;
        const label = length(confirmed);
        // A wide solid part carries its length inside; otherwise it sits beside the whole bar
        // (on the left when the bar ends near the right edge).
        const place = confirmed / span > 0.14 ? 'in' : (end - from) / span > 0.85 ? 'before' : 'after';
        return <button key={m.id} type="button" className="tl-bar" aria-pressed={selectedId === m.id}
          aria-label={`${r.label}: ${m.role.toLowerCase()}, open evidence`}
          style={{ left: `min(${pct(start)}, calc(100% - 6px))`, width: `max(6px, calc(${pct(end)} - ${pct(start)}))` }}
          onClick={e => { e.stopPropagation(); onSelect(m); }}>
          {m.joined.after != null && <span className="tl-unsure" style={{ width: share(m.joined.after, m.joined.by) }} />}
          <span className="tl-solid">{label && place === 'in' && <span className="tl-len" data-place="in">{label}</span>}</span>
          {m.left && <span className="tl-unsure" style={{ width: share(m.left.after, m.left.by) }} />}
          {label && place !== 'in' && <span className="tl-len" data-place={place}>{label}</span>}
        </button>;
      })}
      {at != null && at >= from && <span className="tl-marker" style={{ left: pct(at) }} />}
    </div>
  </div>;

  return <div className="tl">
    <div className="tl-axis" aria-hidden="true">
      <span className="tl-axis-hint">{onPickDate && 'Pick a date'}</span>
      <span className="tl-scrub" data-pick={Boolean(onPickDate)} onClick={onPickDate ? pick : undefined}>
        {years.length
          ? years.map(({ y, t }) => <span key={y} className="tl-year-label" style={{ left: pct(t) }}>{y}</span>)
          : <span className="tl-ticks"><span>{day(from)}</span><span>{day(to)}</span></span>}
        {reads.filter(t => t >= from && t <= to).map(t => <span key={t} className="tl-read" style={{ left: pct(t) }} />)}
        {at != null && at >= from && <span className="tl-marker" style={{ left: pct(at) }} />}
      </span>
    </div>
    {current.map(row)}
    {former.length > 0 && <div className="tl-divider">
      <span>Former</span>
      {former.length > recentFormer.length && <button type="button" className="ghost" onClick={() => setAllFormer(v => !v)}>
        {allFormer ? 'Show recent only' : `Show all ${former.length}`}
      </button>}
    </div>}
    {shownFormer.map(row)}
    <div className="tl-legend" aria-hidden="true">
      <span><i className="tl-key-solid" />Listed</span>
      <span><i className="tl-key-unsure" />Changed somewhere in this window</span>
      {bands.length > 1 && <span><i className="tl-key-band" />One lineup</span>}
      <span><i className="tl-key-read" />A read of the source</span>
      {trackedSince > from && <span><i className="tl-key-untracked" />Not read yet</span>}
    </div>
  </div>;
}
