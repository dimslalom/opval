// VCT 2027 partnered teams, by league. Roster sources spell names their own way
// ("KRÜ VISA", "TYLOO GAMING", "JDG ESPORTS"), so each team lists the loose keys it may arrive under.
export const PARTNERS_2027 = {
  AMERICAS: [
    ['100 Thieves'], ['G2 Esports', 'g2'], ['KRÜ Esports', 'kruvisa', 'kru'], ['Leviatán'],
    ['LOUD'], ['MIBR'], ['NRG'], ['Sentinels'],
  ],
  CN: [
    ['All Gamers'], ['Bilibili Gaming'], ['Edward Gaming'], ['JD Gaming', 'jdgesports', 'jdg'],
    ['Trace Esports'], ['TYLOO', 'tyloogaming'], ['Weibo Gaming'], ['Xi Lai Gaming'],
  ],
  EMEA: [
    ['BBL Esports'], ['Fnatic'], ['FUT Esports'], ['Karmine Corp'],
    ['Gentle Mates'], ['Team Heretics'], ['Team Liquid'], ['Team Vitality'],
  ],
  PACIFIC: [
    ['Crazy Raccoon'], ['Full Sense'], ['GAM Esports'], ['Gen.G Esports', 'geng'],
    ['Paper Rex'], ['Rex Regum Qeon'], ['T1'], ['ZETA Division'],
  ],
};

export const nameKey = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Split a league's teams into the eight partners (in league order, each paired with its best-read row,
// or none if no source lists it yet) and every other team, one entry per name.
export function splitLeague(league, teams) {
  const size = t => (t.players ?? 0) + (t.staff ?? 0);
  const best = new Map();
  for (const t of teams) {
    const k = nameKey(t.name);
    if (!best.has(k) || size(t) > size(best.get(k))) best.set(k, t);
  }
  const claimed = new Set();
  const partners = (PARTNERS_2027[league] ?? []).map(([name, ...aliases]) => {
    const keys = [name, ...aliases].map(nameKey);
    const row = keys.map(k => best.get(k)).filter(Boolean).sort((a, b) => size(b) - size(a))[0] ?? null;
    keys.forEach(k => claimed.add(k));
    return { name, team: row };
  });
  const others = [...best.entries()].filter(([k]) => !claimed.has(k)).map(([, t]) => t)
    .sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name));
  return { partners, others };
}
