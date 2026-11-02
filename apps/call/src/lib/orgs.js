import cards from '../../../../shared/src/data/cards.json';
import teamColors from '../data/teamColors.json';
import teams from '../../../../src/data/teams.json';

// Keep feed teams independent of whether their players have collectible cards.
const logos = {};
for (const c of cards) {
  const tag = String(c.org ?? '').trim().toUpperCase();
  if (tag && c.org_logo && !logos[tag]) logos[tag] = c.org_logo;
}
for (const [tag, team] of Object.entries(teams)) logos[tag] = team.logo;
for (const [alias, tag] of Object.entries({ GENG: 'GEN', KRU: 'KRÜ', NV: 'ENVY', VARREL: 'VL' })) {
  if (logos[tag]) logos[alias] = logos[tag];
}

export const logoFor = tag => logos[String(tag ?? '').trim().toUpperCase()] ?? null;
export const colorsFor = tag => teamColors[tag] ?? ['#6e778b'];

// Roster sources name teams in full ("100 THIEVES", "Natus Vincere"), so match them on a loose key
// against the cards' org names and tags, plus a few names the cards spell differently.
const loose = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/esports?|gaming|team|club/g, '').replace(/[^a-z0-9]/g, '');
const byName = { drx: '/assets/orgs/drx.png', geng: '/assets/orgs/geng.png', giantx: '/assets/orgs/gmx.png', sentinels: '/assets/orgs/sentinels.png' };
for (const c of cards) if (c.org_logo) for (const k of [c.org, c.org_name]) if (k && !byName[loose(k)]) byName[loose(k)] = c.org_logo;
for (const [tag, team] of Object.entries(teams)) {
  for (const name of [tag, team.name]) byName[loose(name)] = team.logo;
}
export const logoForName = name => byName[loose(name)] ?? null;

// The same loose names to a team tag, for team colors and jersey kits. Cards first, teams.json wins.
const tagByName = { kruvisa: 'KRÜ', drx: 'DRX', geng: 'GEN', giantx: 'GX', sentinels: 'SEN' };
for (const c of cards) if (c.org) for (const k of [c.org, c.org_name]) if (k && !tagByName[loose(k)]) tagByName[loose(k)] = c.org;
for (const [tag, team] of Object.entries(teams)) for (const name of [tag, team.name]) tagByName[loose(name)] = tag;
export const tagForName = name => tagByName[loose(name)] ?? null;
