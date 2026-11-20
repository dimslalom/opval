import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetwork, filterNetwork, findStories, pathEdges, shortestPath } from '../apps/call/src/lib/rosterNetwork.js';

const day = (y, m) => Date.UTC(y, m - 1, 15) / 1000;
const stint = (id, personId, teamId, from, to, latest = false) =>
  ({ id, personId, teamId, firstSeenAt: day(...from), lastSeenAt: day(...to), latest, sourceId: 1 });

const network = createNetwork({
  players: [{ id: 1, handle: 'Ace' }, { id: 2, handle: 'Bolt' }, { id: 3, handle: 'Cove' }],
  teams: [
    { id: 1, name: 'Alpha', tag: 'ALP', league: 'EMEA' },
    { id: 2, name: 'Bravo', tag: 'BRV', league: 'AMERICAS' },
    { id: 3, name: 'Charlie', tag: 'CHR', league: 'EMEA' },
  ],
  stints: [
    stint(1, 1, 1, [2024, 1], [2024, 6]),
    stint(2, 1, 2, [2024, 8], [2024, 9], true),
    stint(3, 2, 2, [2024, 1], [2024, 9], true),
    stint(4, 3, 3, [2024, 2], [2024, 3], true),
  ],
});

test('months span the whole timeline and count active links', () => {
  assert.equal(network.months[0], '2024-01');
  assert.equal(network.months.at(-1), '2024-09');
  assert.equal(network.activity[0], 2); // Ace at Alpha, Bolt at Bravo
  assert.equal(filterNetwork(network, { period: '2024-07' }).edges.length, 1);
});

test('shortest path runs through shared teams', () => {
  const { adjacency } = filterNetwork(network, {});
  const path = shortestPath(adjacency, 'player-2', 'team-1');
  assert.deepEqual(path, ['player-2', 'team-2', 'player-1', 'team-1']);
  assert.deepEqual([...pathEdges(path)], ['player-2:team-2', 'player-1:team-2', 'player-1:team-1']);
  assert.equal(shortestPath(adjacency, 'player-2', 'player-3'), null);
});

test('stories find the cross-region move', () => {
  const cross = findStories(network).find(story => story.id === 'cross');
  assert.equal(cross.title, 'Ace');
  assert.equal(cross.detail, 'ALP to BRV');
});
