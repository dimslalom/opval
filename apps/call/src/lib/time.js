// Dates are grouped in the viewer's own timezone, like the official schedule.
const dayFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const longFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export const dayKey = unix => dayFmt.format(new Date(unix * 1000));
export const todayKey = () => dayFmt.format(new Date());
export const timeOf = unix => timeFmt.format(new Date(unix * 1000));
export const longDay = key => longFmt.format(new Date(`${key}T12:00:00`));

// How long until a start time, for countdowns: "in 45m", "in 3h 20m", "in 2d". Null once started.
export const untilOf = (unix, now) => {
  const m = Math.floor((unix - now) / 60);
  if (m < 0) return null;
  if (m < 60) return `in ${m}m`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `in ${Math.floor(m / 1440)}d`;
};

// A roster date at the precision we know it: day, month, year.
export const rosterDay = s => new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
