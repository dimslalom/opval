// Per-map point rules shared by every mode that scores real VALORANT stats.
// One place, so a rule change is a one-line edit.
export const SCORING = {
  kill: 2,
  assist: 1,
  death: -1,
  firstKill: 2,
  firstDeath: -2,
  multi: { 3: 3, 4: 6, 5: 10 },            // rounds with exactly N kills
  clutch: { 1: 2, 2: 4, 3: 7, 4: 10, 5: 15 }, // clutches WON, 1vN
  kastBands: [[80, 4], [70, 2], [60, 0], [0, -2]],
  mapWin: 4,
  seriesWin: 5,                              // credited on the series' last map
  mapMvp: 5,                                 // best R2.0 of the ten players on the map
};
