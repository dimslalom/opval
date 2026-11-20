export const REGION_COLORS = {
  AMERICAS: '#ff8b83',
  EMEA: '#90baff',
  PACIFIC: '#73dac4',
  CN: '#f6c878',
};

export const regionLabel = league => ({ AMERICAS: 'Americas', PACIFIC: 'Pacific', CN: 'China' })[league] ?? league;
export const graphPath = (type, id) => `/graph?focus=${type}-${id}`;
export const otherEnd = (edge, key) => edge.team === key ? edge.player : edge.team;

export function createNetwork({ players, teams, stints }) {
  const nodes = new Map();
  for (const player of players) nodes.set(`player-${player.id}`, { ...player, type: 'player', label: player.handle });
  for (const team of teams) nodes.set(`team-${team.id}`, { ...team, type: 'team', label: team.name });

  const edges = new Map();
  const years = new Set();
  const leagues = new Map();
  for (const stint of stints) {
    const player = `player-${stint.personId}`;
    const team = `team-${stint.teamId}`;
    const key = `${player}:${team}`;
    if (!edges.has(key)) edges.set(key, { key, player, team, stints: [] });
    edges.get(key).stints.push(stint);
    const first = new Date(stint.firstSeenAt * 1000).getUTCFullYear();
    const last = new Date(stint.lastSeenAt * 1000).getUTCFullYear();
    for (let year = first; year <= last; year++) years.add(year);
  }
  for (const team of teams) leagues.set(team.league, REGION_COLORS[team.league] ?? '#c7a5ed');

  // Month timeline: every month from the first listing to the last, with how many links were active.
  const activity = new Map();
  let lo = Infinity, hi = -Infinity;
  for (const stint of stints) {
    lo = Math.min(lo, monthIndex(stint.firstSeenAt));
    hi = Math.max(hi, monthIndex(stint.lastSeenAt));
  }
  const months = [];
  for (let m = lo; m <= hi; m++) months.push(monthKey(m));
  for (const edge of edges.values()) {
    const active = new Set();
    for (const stint of edge.stints) {
      for (let m = monthIndex(stint.firstSeenAt); m <= monthIndex(stint.lastSeenAt); m++) active.add(m);
    }
    for (const m of active) activity.set(monthKey(m), (activity.get(monthKey(m)) ?? 0) + 1);
  }
  return {
    nodes,
    edges: [...edges.values()],
    years: [...years].sort((a, b) => b - a),
    leagues,
    months,
    activity: months.map(month => activity.get(month) ?? 0),
  };
}

const monthIndex = seconds => {
  const date = new Date(seconds * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};
const monthKey = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
export const isMonth = period => /^\d{4}-\d{2}$/.test(period ?? '');
export const monthLabel = month => new Date(`${month}-01T00:00:00Z`)
  .toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function periodRange(period) {
  if (isMonth(period)) {
    const [y, m] = period.split('-').map(Number);
    return [Date.UTC(y, m - 1, 1) / 1000, Date.UTC(y, m, 1) / 1000];
  }
  const year = Number(period);
  return [Date.UTC(year, 0, 1) / 1000, Date.UTC(year + 1, 0, 1) / 1000];
}

export function filterNetwork(network, { league, period }) {
  const edges = [];
  const adjacency = new Map();
  const [start, end] = periodRange(period);

  for (const edge of network.edges) {
    if (league && network.nodes.get(edge.team).league !== league) continue;
    const stints = edge.stints.filter(stint => {
      if (period === 'latest') return stint.latest;
      return !period || (stint.lastSeenAt >= start && stint.firstSeenAt < end);
    });
    if (!stints.length) continue;

    const visible = { ...edge, stints, latest: stints.some(stint => stint.latest) };
    edges.push(visible);
    for (const key of [edge.player, edge.team]) {
      if (!adjacency.has(key)) adjacency.set(key, []);
      adjacency.get(key).push(visible);
    }
  }
  return { edges, adjacency };
}

export function neighborhood(adjacency, focus, depth) {
  const nodes = new Set([focus]);
  const edges = new Set();
  let frontier = [focus];
  for (let hop = 0; hop < depth; hop++) {
    const next = [];
    for (const key of frontier) {
      for (const edge of adjacency.get(key) ?? []) {
        edges.add(edge.key);
        const neighbor = otherEnd(edge, key);
        if (nodes.has(neighbor)) continue;
        nodes.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}

const firstSeen = edge => Math.min(...edge.stints.map(stint => stint.firstSeenAt));
const lastSeen = edge => Math.max(...edge.stints.map(stint => stint.lastSeenAt));

// A player's teams in the order they were first listed.
export function careers(network) {
  const byPlayer = new Map();
  for (const edge of network.edges) {
    if (!byPlayer.has(edge.player)) byPlayer.set(edge.player, []);
    byPlayer.get(edge.player).push(edge);
  }
  for (const list of byPlayer.values()) list.sort((a, b) => firstSeen(a) - firstSeen(b));
  return byPlayer;
}

// The team a player was listed on just before joining `edge`'s team, if any.
export function previousTeam(career, edge) {
  const start = firstSeen(edge);
  let best = null;
  for (const other of career ?? []) {
    if (other === edge || other.team === edge.team || firstSeen(other) > start) continue;
    if (!best || lastSeen(other) > lastSeen(best)) best = other;
  }
  return best?.team ?? null;
}

// Fewest-hops route between two nodes, through players and teams. Returns node keys or null.
export function shortestPath(adjacency, from, to) {
  if (from === to) return [from];
  const parent = new Map([[from, null]]);
  let frontier = [from];
  while (frontier.length) {
    const next = [];
    for (const key of frontier) {
      for (const edge of adjacency.get(key) ?? []) {
        const other = otherEnd(edge, key);
        if (parent.has(other)) continue;
        parent.set(other, key);
        if (other === to) {
          const path = [to];
          while (parent.get(path[0])) path.unshift(parent.get(path[0]));
          return path;
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}

export const pathEdges = path => new Set(path.slice(1).map((key, i) => {
  const [a, b] = [path[i], key];
  return a.startsWith('player') ? `${a}:${b}` : `${b}:${a}`;
}));

// Headline findings for the story strip. Each one is a spotlight: nodes + edges to light up.
export function findStories(network) {
  const stories = [];
  const byPlayer = careers(network);
  const name = key => network.nodes.get(key)?.label ?? key;
  const tag = key => network.nodes.get(key)?.tag || name(key);
  const spot = edges => ({
    nodes: new Set(edges.flatMap(edge => [edge.player, edge.team])),
    edges: new Set(edges.map(edge => edge.key)),
  });

  let travelled = null;
  for (const [player, list] of byPlayer) if (!travelled || list.length > travelled[1].length) travelled = [player, list];
  if (travelled && travelled[1].length > 2) {
    stories.push({
      id: 'travelled', kicker: 'Most travelled', title: name(travelled[0]),
      detail: `${travelled[1].length} teams`, ...spot(travelled[1]),
    });
  }

  const pairs = new Map();
  for (const list of byPlayer.values()) {
    const teams = [...new Set(list.map(edge => edge.team))].sort();
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
      const key = `${teams[i]}|${teams[j]}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  // Same-name pairs are one org listed twice, not a rivalry.
  const [pair, shared] = [...pairs].filter(([key]) => {
    const [a, b] = key.split('|');
    return name(a).toLowerCase() !== name(b).toLowerCase();
  }).sort((a, b) => b[1] - a[1])[0] ?? [];
  if (shared > 1) {
    const [a, b] = pair.split('|');
    const edges = [...byPlayer.values()].filter(list => list.some(e => e.team === a) && list.some(e => e.team === b))
      .flat().filter(edge => edge.team === a || edge.team === b);
    stories.push({ id: 'pair', kicker: 'Closest rivals', title: `${tag(a)} and ${tag(b)}`, detail: `${shared} shared players`, ...spot(edges) });
  }

  let move = null;
  for (const list of byPlayer.values()) {
    for (const edge of list) {
      const from = previousTeam(list, edge);
      if (!from || network.nodes.get(from).league === network.nodes.get(edge.team).league) continue;
      if (!move || firstSeen(edge) > firstSeen(move.edge)) move = { edge, from, list };
    }
  }
  if (move) {
    const edges = move.list.filter(e => e === move.edge || e.team === move.from);
    stories.push({
      id: 'cross', kicker: 'Latest cross-region move', title: name(move.edge.player),
      detail: `${tag(move.from)} to ${tag(move.edge.team)}`, ...spot(edges),
    });
  }

  const newest = network.months.at(-1);
  const fresh = [];
  for (const list of byPlayer.values()) {
    for (const edge of list) {
      if (monthKey(monthIndex(firstSeen(edge))) !== newest || !previousTeam(list, edge)) continue;
      fresh.push(edge, list.find(e => e.team === previousTeam(list, edge)));
    }
  }
  if (fresh.length) {
    stories.push({
      id: 'fresh', kicker: 'New this month', title: `${fresh.length / 2} ${fresh.length === 2 ? 'move' : 'moves'}`,
      detail: monthLabel(newest), period: newest, ...spot(fresh),
    });
  }
  return stories;
}
