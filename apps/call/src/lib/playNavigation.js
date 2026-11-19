export const playHome = '/?view=play';

export function showsPlayHome({ pathname, search }) {
  return pathname === '/' && new URLSearchParams(search).get('view') === 'play';
}
