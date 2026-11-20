import { colorsFor, logoFor, logoForName, tagForName } from './orgs';
import { cardFor } from './rosterCards';

const imageCache = new Map();
const logoPresentation = new WeakMap();

export function teamLogoPresentation(img) {
  if (logoPresentation.has(img)) return logoPresentation.get(img);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const sample = document.createElement('canvas');
  sample.width = sample.height = 48;
  let result = { sx: 0, sy: 0, sw: width, sh: height, background: '#20242e', visible: true };
  try {
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    if (!ctx) return result;
    ctx.drawImage(img, 0, 0, 48, 48);
    const pixels = ctx.getImageData(0, 0, 48, 48).data;
    let left = 48, top = 48, right = -1, bottom = -1, light = 0, weight = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const opacity = pixels[i + 3] / 255;
      if (opacity < 0.16) continue;
      const x = (i / 4) % 48, y = Math.floor(i / 192);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      const luminance = (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
      light += opacity * luminance;
      weight += opacity;
    }
    if (weight) {
      const sx = Math.max(0, left - 1) * width / 48;
      const sy = Math.max(0, top - 1) * height / 48;
      result = {
        sx, sy,
        sw: Math.min(48, right + 2) * width / 48 - sx,
        sh: Math.min(48, bottom + 2) * height / 48 - sy,
        background: light / weight < 0.43 ? '#e8e9ed' : '#20242e',
        visible: true,
      };
    } else {
      result.visible = false;
    }
  } catch {
    // Keep the original image if a browser restricts pixel access.
  }
  logoPresentation.set(img, result);
  return result;
}

export function playerPhotoUrl(handle, teamName) {
  const card = cardFor(handle, teamName) ?? cardFor(String(handle ?? '').replace(/\s+/g, ''), teamName);
  const photo = card?.photo;
  return photo && !photo.includes('placeholder') ? photo : null;
}

export function teamLogoUrl(tag, name) {
  return logoFor(tag) ?? logoForName(name) ?? null;
}

export function teamAccentColor(tag, name, fallback = '#6e778b') {
  const resolvedTag = tag || tagForName(name);
  const colors = colorsFor(resolvedTag);
  return colors?.[0] ?? fallback;
}

export function getCachedImage(src, onLoad) {
  if (!src) return null;
  let entry = imageCache.get(src);
  if (entry) {
    if (entry.status === 'ready') return entry.img;
    if (entry.status === 'loading' && onLoad) entry.listeners.add(onLoad);
    return null;
  }
  const img = new Image();
  img.decoding = 'async';
  entry = { img, status: 'loading', listeners: new Set(onLoad ? [onLoad] : []) };
  imageCache.set(src, entry);
  img.onload = () => {
    entry.status = 'ready';
    for (const fn of entry.listeners) fn();
    entry.listeners.clear();
  };
  img.onerror = () => {
    entry.status = 'error';
    entry.listeners.clear();
  };
  img.src = src;
  return null;
}

export function buildMediaMap(network) {
  const playerLatestTeam = new Map();
  const teamCount = new Map();
  const activeTeams = new Map();
  const playerLeagues = new Map();

  for (const edge of network.edges) {
    teamCount.set(edge.player, (teamCount.get(edge.player) ?? 0) + 1);
    if (!playerLeagues.has(edge.player)) playerLeagues.set(edge.player, new Set());
    playerLeagues.get(edge.player).add(network.nodes.get(edge.team)?.league);
    const maxSeen = Math.max(0, ...edge.stints.map(s => s.lastSeenAt ?? 0));
    const isLatest = edge.stints.some(s => s.latest);
    if (isLatest) activeTeams.set(edge.player, edge.team);
    const prev = playerLatestTeam.get(edge.player);
    if (!prev || (isLatest && !prev.isLatest) || (isLatest === prev.isLatest && maxSeen > prev.maxSeen)) {
      playerLatestTeam.set(edge.player, { teamKey: edge.team, isLatest, maxSeen });
    }
  }

  const media = new Map();
  for (const [key, node] of network.nodes) {
    if (node.type === 'team') {
      const leagueColor = network.leagues.get(node.league) ?? '#90baff';
      media.set(key, {
        kind: 'team',
        src: teamLogoUrl(node.tag, node.name),
        ringColor: leagueColor,
        accent: teamAccentColor(node.tag, node.name, leagueColor),
        monogram: (node.tag || node.name || '?').slice(0, 4).toUpperCase(),
        latestTeamKey: null,
        teamCount: 0,
        isBridge: false,
      });
    } else {
      const latest = playerLatestTeam.get(key);
      const teamNode = latest ? network.nodes.get(latest.teamKey) : null;
      const count = teamCount.get(key) ?? 0;
      const leagueColor = teamNode ? (network.leagues.get(teamNode.league) ?? '#a6b1c2') : '#a6b1c2';
      media.set(key, {
        kind: 'player',
        src: playerPhotoUrl(node.handle, teamNode?.name),
        ringColor: latest?.isLatest ? leagueColor : '#7e8da6',
        accent: teamNode ? teamAccentColor(teamNode.tag, teamNode.name, '#303a4b') : '#303a4b',
        monogram: String(node.handle ?? '?').slice(0, 2).toUpperCase(),
        latestTeamKey: latest?.teamKey ?? null,
        latestTeamName: teamNode?.name ?? null,
        latestTeamTag: teamNode?.tag ?? null,
        isLatest: Boolean(latest?.isLatest),
        teamCount: count,
        isBridge: count > 1,
        crossRegion: (playerLeagues.get(key)?.size ?? 0) > 1,
      });
    }
  }
  return media;
}
