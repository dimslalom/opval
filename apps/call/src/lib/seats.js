// Pure lineup logic for team pages (no React, so tests can import it directly).

// Seats: a stable place for each player in the lineup display. Riot's sheet never says who replaced
// whom, so a seat is only a layout: a player who first appears in the same read that showed someone
// gone takes that seat ("joined as X left", which is true); otherwise the lowest free seat.
// Returns Map(tenureId -> { seat, after: handle that left in the same window, or null }).
export function assignSeats(memberships) {
  const players = memberships.filter(m => m.kind === 'player')
    .sort((a, b) => a.joined.by - b.joined.by || a.handle.localeCompare(b.handle));
  const points = [...new Set(players.flatMap(m => [m.joined.by, ...(m.left ? [m.left.by] : [])]))].sort((a, b) => a - b);
  const holder = [];
  const seats = new Map();
  for (const t of points) {
    const freed = [];
    holder.forEach((m, i) => { if (m?.left?.by === t) { holder[i] = null; freed.push({ i, m }); } });
    for (const m of players.filter(p => p.joined.by === t)) {
      const same = freed.shift();
      let i = same ? same.i : holder.indexOf(null);
      if (i === -1) i = holder.length;
      holder[i] = m;
      seats.set(m.id, { seat: i, after: same ? same.m.handle : null });
    }
  }
  return seats;
}

// A team's player lineups, newest first. Each lineup runs from the first read that listed it to the
// last read before the next change; the change itself happened somewhere between those two reads.
// Built only from what the reads showed: a person is in a lineup if that lineup's first read
// listed them.
export function lineupEras(memberships, reads, latestRead) {
  const players = memberships.filter(m => m.kind === 'player');
  const firstRead = Math.min(...players.map(m => m.joined.by));
  if (!Number.isFinite(firstRead)) return [];
  const points = [...new Set([
    firstRead,
    ...players.filter(m => m.joined.after != null).map(m => m.joined.by),
    ...players.filter(m => m.left).map(m => m.left.by),
  ])].filter(t => t <= latestRead).sort((a, b) => a - b);
  const eras = [];
  for (const [i, start] of points.entries()) {
    const next = points[i + 1];
    const members = players.filter(m => m.joined.by <= start && start <= m.lastSeenAt);
    const ids = members.map(m => m.personId).sort().join();
    const prev = eras.at(-1);
    // A change point that left the player set as it was (a role or status change) is not a new lineup.
    if (prev && prev.ids === ids) { prev.next = next; continue; }
    eras.push({ start, next, ids, members, added: prev ? members.filter(m => !prev.members.some(p => p.personId === m.personId)) : [],
      removed: prev ? prev.members.filter(p => !members.some(m => m.personId === p.personId)) : [] });
  }
  for (const era of eras) {
    // The last read before the next change still showed this lineup.
    era.end = era.next ? Math.max(era.start, ...reads.filter(t => t < era.next)) : latestRead;
  }
  return eras.reverse();
}
