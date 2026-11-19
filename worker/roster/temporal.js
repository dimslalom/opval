// What a membership row can honestly say about one moment t (unix seconds).
// A membership only knows: it was first seen at start_before (and was absent at start_after, the
// previous complete read, if any), last seen at last_seen_at, and gone by end_before (if closed).
//   present  - inside the observed span, seen by consecutive complete reads
//   possible - inside a join/leave window, or within 30 days after the latest read of a still-open tenure
//   unknown  - before tracking began, or more than 30 days since anything confirmed an open tenure
//              (e.g. a coach while the source was only read for players); the source says nothing
//   absent   - outside every window
const STALE = 30 * 86400;

export function presenceAt(m, t) {
  if (t >= m.start_before && t <= m.last_seen_at) return 'present';
  if (t < m.start_before) {
    if (m.start_after == null) return 'unknown';
    return t > m.start_after ? 'possible' : 'absent';
  }
  if (m.end_before != null) return t < m.end_before ? 'possible' : 'absent';
  return t - m.last_seen_at > STALE ? 'unknown' : 'possible';
}

// GCD contract ends come as '2027', '2027 Season End' or 'June 30, 2027'. Keep the text and its
// precision; never widen '2027' into a fake 31 December.
export function contractPrecision(text) {
  if (!text) return null;
  if (/^\d{4}$/.test(text)) return 'year';
  if (/^\d{4} season end$/i.test(text)) return 'season';
  if (!Number.isNaN(Date.parse(text)) && /\d{1,2},?\s+\d{4}$/.test(text)) return 'day';
  return 'text';
}
