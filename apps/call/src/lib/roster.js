import { useEffect, useState } from 'react';
import { rosterDay as day } from './time';

// Shared helpers for the public roster pages.

export const DAY = 86400;
export const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const isoOf = s => isoDay(new Date(s * 1000));
// The roster "on" a day is the roster at the end of that day, local time.
export const endOf = iso => Math.floor(new Date(`${iso}T23:59:59`).getTime() / 1000);
export const validIso = s => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? s : null);
export const title = s => String(s ?? '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
export const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const teamPath = t => `/teams/${t.teamId ?? t.id}/${slug(t.team ?? t.name)}`;
export const personPath = m => `/players/${m.personId ?? m.id}/${slug(m.handle)}`;

// A window (after, by]: the change happened after one read and by the next.
export function windowText(w) {
  if (!w) return null;
  if (w.teamExit) return `Last listed ${day(w.after)}, when the team left the source`;
  if (w.after == null) return `First listed ${day(w.by)}; earlier is not known`;
  return day(w.after) === day(w.by) ? day(w.by) : `${day(w.after)} to ${day(w.by)}`;
}

export const PRESENCE = {
  present: 'Listed on this date',
  possible: 'Changed around this date; the exact day is between two reads',
  unknown: 'Before this source was tracked; not known',
  absent: 'Not listed on this date',
};

export const PRECISION = { year: 'Year only', season: 'End of a season', day: 'Exact day', text: 'As written by the source' };

// GET a roster path; a late answer for an older path never replaces the current one. While a new
// path loads, the last data stays (so a date change doesn't blank the page) and `loading` is true.
export function useRoster(path) {
  const [state, setState] = useState({ path: null, data: null, error: '' });
  useEffect(() => {
    if (!path) return undefined;
    const controller = new AbortController();
    fetch(path, { signal: controller.signal })
      .then(r => {
        if (r.status === 404) throw new Error('This is not in the roster database.');
        if (!r.ok) throw new Error('Roster data is unavailable right now. Try again in a minute.');
        return r.json();
      })
      .then(data => setState({ path, data, error: '' }), e => { if (e.name !== 'AbortError') setState({ path, data: null, error: e.message }); });
    return () => controller.abort();
  }, [path]);
  return { data: state.data, error: state.path === path ? state.error : '', loading: Boolean(path) && state.path !== path };
}
