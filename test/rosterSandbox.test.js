import test from 'node:test';
import assert from 'node:assert/strict';
import { blankDraft, checkLineup, diffFromBase } from '../apps/call/src/lib/sandbox.js';

const at = (teamId, team, extra = {}) => ({ teamId, team, status: 'active', contractEnd: '2027', ...extra });
const slot = (personId, handle, now) => ({ personId, handle, now });
const base = [slot(1, 'ace', at(9, 'Home')), slot(2, 'bolt', at(9, 'Home')), slot(3, 'cinder', at(9, 'Home'))];

test('the sandbox warns about facts but never blocks them; a duplicate person is the only error', () => {
  const draft = { ...blankDraft('d'), baseTeamId: 9, starters: [base[0], base[1], slot(4, 'dusk', at(7, 'Rival')), slot(5, 'ember', null), slot(6, 'frost', at(9, 'Home', { status: 'reserve' }))] };
  const r = checkLineup(draft);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map(w => w.text), [
    'dusk is listed on Rival, contract ending 2027.',
    'ember is not on a tracked team in Riot\'s data now.',
    'frost is listed as reserve.',
  ]);
  assert.ok(r.notChecked.length > 0); // rules without data are said to be unchecked, not passed
  const twice = checkLineup({ ...draft, bench: [base[0]] });
  assert.deepEqual(twice.errors, ['ace is in the lineup twice.']);
  assert.equal(checkLineup({ ...blankDraft('e'), starters: [base[0], null, null, null, null] }).warnings[0].text, '1 of 5 starters picked.');
});

test('a draft is compared with the lineup it started from', () => {
  const draft = { ...blankDraft('d'), baseTeamId: 9, starters: [base[0], slot(4, 'dusk', null), null, null, null], staff: [base[2]] };
  const d = diffFromBase(draft, base);
  assert.deepEqual(d.added.map(s => s.handle), ['dusk']);
  assert.deepEqual(d.removed.map(s => s.handle), ['bolt']);
});
