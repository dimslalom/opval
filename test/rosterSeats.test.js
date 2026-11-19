import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSeats, lineupEras } from '../apps/call/src/lib/seats.js';

// Synthetic tenures: reads at 100, 200, 300.
const t = (id, handle, by, after = null, left = null, lastSeenAt = 300) =>
  ({ id, personId: id, handle, kind: 'player', joined: { after, by }, left, lastSeenAt });
const roster = [
  t(1, 'ace', 100), t(2, 'bolt', 100), t(3, 'cinder', 100, null, { after: 100, by: 200 }, 100),
  t(4, 'dusk', 200, 100), t(5, 'ember', 300, 200),
];

test('a player first seen in the same read someone vanished takes that seat; others take a free one', () => {
  const seats = assignSeats(roster);
  assert.deepEqual(seats.get(4), { seat: seats.get(3).seat, after: 'cinder' });
  assert.deepEqual(seats.get(5), { seat: 3, after: null });
  assert.equal(new Set([1, 2, 4, 5].map(id => seats.get(id).seat)).size, 4); // no two current players share a seat
});

test('lineups follow the reads, newest first, with what changed', () => {
  const eras = lineupEras(roster, [100, 200, 300], 300);
  assert.deepEqual(eras.map(e => e.members.map(m => m.handle).sort()), [['ace', 'bolt', 'dusk', 'ember'], ['ace', 'bolt', 'dusk'], ['ace', 'bolt', 'cinder']]);
  assert.deepEqual(eras[1].added.map(m => m.handle), ['dusk']);
  assert.deepEqual(eras[1].removed.map(m => m.handle), ['cinder']);
});
