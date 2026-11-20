import { useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { UndirectedGraph } from 'graphology';
import Sigma from 'sigma';
import { buildMediaMap, getCachedImage, teamLogoPresentation } from '../lib/graphMedia';
import { careers, neighborhood, previousTeam, regionLabel } from '../lib/rosterNetwork';
import LayoutWorker from '../lib/rosterLayout.worker.js?worker';

const withAlpha = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
const clamp01 = value => Math.max(0, Math.min(1, value));
const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const SETTLE_MS = 1600;
const TWEEN_MS = 520;
const PULSE_MS = 1150;
const APPEAR_MS = 380;

function seedGraph(network) {
  const graph = new UndirectedGraph();
  const regions = [...network.leagues.keys()].sort();
  const teams = [...network.nodes].filter(([, node]) => node.type === 'team');
  const slots = new Map(regions.map(league => [league, 0]));
  const linked = new Map();
  const degree = new Map();

  for (const edge of network.edges) {
    if (!linked.has(edge.player)) linked.set(edge.player, []);
    linked.get(edge.player).push(edge.team);
    degree.set(edge.team, (degree.get(edge.team) ?? 0) + 1);
    degree.set(edge.player, (degree.get(edge.player) ?? 0) + 1);
  }

  for (const [key, team] of teams) {
    const angle = regions.indexOf(team.league) * Math.PI * 2 / Math.max(1, regions.length) + Math.PI / 4;
    const slot = slots.get(team.league);
    slots.set(team.league, slot + 1);
    const offset = slot * 2.4;
    const radius = 12 * Math.sqrt(slot);
    const deg = degree.get(key) ?? 1;
    graph.addNode(key, {
      x: 90 * Math.cos(angle) + radius * Math.cos(offset),
      y: 90 * Math.sin(angle) + radius * Math.sin(offset),
      color: network.leagues.get(team.league),
      label: team.tag || team.label,
      zIndex: 2,
      size: Math.min(14.5, 9.5 + Math.sqrt(deg) * 0.9),
    });
  }

  for (const [key, node] of network.nodes) {
    if (node.type !== 'player') continue;
    const positions = (linked.get(key) ?? []).map(team => graph.getNodeAttributes(team));
    const angle = node.id * 2.4;
    const center = axis => positions.reduce((sum, position) => sum + position[axis], 0) / (positions.length || 1);
    const teamsPlayed = positions.length;
    graph.addNode(key, {
      x: center('x') + 16 * Math.cos(angle),
      y: center('y') + 16 * Math.sin(angle),
      size: teamsPlayed > 1 ? Math.min(8.2, 5.8 + teamsPlayed * 0.55) : 4.8,
      color: '#a6b1c2',
      label: node.label,
      zIndex: 1,
    });
  }

  for (const edge of network.edges) graph.addEdgeWithKey(edge.key, edge.player, edge.team);
  return graph;
}

const cameraPose = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const cameraDuration = () => (reducedMotion() ? 0 : 280);

function moveCamera(camera, pose, duration = cameraDuration()) {
  if (duration || camera.isAnimated()) camera.animate(pose, { duration: duration || 1 });
  else camera.setState(pose);
}

// Target positions for the focus view: the picked node in the middle, rings of neighbours around it.
function radialTargets(graph, view, network) {
  const targets = new Map();
  const focus = view.focus;
  if (!focus || !graph.hasNode(focus)) return targets;

  targets.set(focus, { x: 0, y: 0 });

  const directEdges = [...(view.adjacency.get(focus) ?? [])].filter(edge => view.edges.has(edge.key));
  const hop1 = [];
  const seen = new Set([focus]);

  directEdges.sort((a, b) => {
    if (Boolean(b.latest) !== Boolean(a.latest)) return Number(b.latest) - Number(a.latest);
    const na = network.nodes.get(a.team === focus ? a.player : a.team)?.label ?? '';
    const nb = network.nodes.get(b.team === focus ? b.player : b.team)?.label ?? '';
    return na.localeCompare(nb);
  });

  for (const edge of directEdges) {
    const other = edge.team === focus ? edge.player : edge.team;
    if (seen.has(other) || !graph.hasNode(other)) continue;
    seen.add(other);
    hop1.push(other);
  }

  const count1 = hop1.length;
  // Radii were tuned for a ~220-unit-wide layout; scale them to the real one so the ring keeps its size on screen.
  let minX = Infinity, maxX = -Infinity;
  graph.forEachNode((key, { x }) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); });
  const unit = Number.isFinite(maxX - minX) ? Math.max(1, (maxX - minX) / 220) : 1;
  const r1 = unit * Math.max(48, 32 + count1 * 3.2);
  const hop1Angle = new Map();
  // Start slightly above horizontal so 2-node layouts angle pleasingly and stay balanced
  const startAngle = count1 === 2 ? -Math.PI * 0.12 : -Math.PI / 2;

  hop1.forEach((key, index) => {
    const angle = startAngle + (index * Math.PI * 2) / Math.max(1, count1);
    hop1Angle.set(key, angle);
    targets.set(key, { x: Math.cos(angle) * r1, y: Math.sin(angle) * r1 });
  });

  if (view.depth === 2) {
    const hop2 = [];
    for (const parent of hop1) {
      for (const edge of view.adjacency.get(parent) ?? []) {
        if (!view.edges.has(edge.key)) continue;
        const other = edge.team === parent ? edge.player : edge.team;
        if (seen.has(other) || !graph.hasNode(other)) continue;
        seen.add(other);
        hop2.push({ key: other, parentAngle: hop1Angle.get(parent) ?? 0 });
      }
    }
    hop2.sort((a, b) => a.parentAngle - b.parentAngle);
    const r2 = Math.max(r1 * 1.8, r1 + 48 * unit, hop2.length * 2.4 * unit);
    hop2.forEach(({ key }, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, hop2.length);
      targets.set(key, { x: Math.cos(angle) * r2, y: Math.sin(angle) * r2 });
    });
  }
  return targets;
}

// `targets` frames positions nodes are still flying towards, so the camera can move with them.
function frame(renderer, nodes, duration = cameraDuration(), targets = null) {
  const camera = renderer.getCamera();
  const { width, height } = renderer.getDimensions();
  const canvas = renderer.getContainer().getBoundingClientRect();
  const page = renderer.getContainer().closest('.network-page');
  const header = page?.closest('.shell')?.querySelector('.hud')?.getBoundingClientRect();
  const island = page?.querySelector('.network-hud')?.getBoundingClientRect();
  const panelAtSide = island && island.top < canvas.top + height / 2 && island.left > canvas.left + width * 0.42;
  const available = {
    left: 24,
    top: header ? header.bottom - canvas.top + 16 : 24,
    right: panelAtSide ? island.left - canvas.left - 16 : width - 24,
    bottom: island && !panelAtSide ? island.top - canvas.top - 12 : height - 24,
  };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let count = 0;
  for (const key of nodes) {
    const target = targets?.get(key);
    const point = target ? null : renderer.getNodeDisplayData(key);
    if (!target && !point) continue;
    count++;
    const { x, y } = target
      ? renderer.graphToViewport(target, { cameraState: cameraPose })
      : renderer.framedGraphToViewport(point, { cameraState: cameraPose });
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  let pose = cameraPose;
  if (Number.isFinite(left)) {
    const center = renderer.viewportToFramedGraph({ x: (left + right) / 2, y: (top + bottom) / 2 }, { cameraState: cameraPose });
    const availW = Math.max(96, available.right - available.left - (count <= 8 ? 64 : 40));
    const availH = Math.max(96, available.bottom - available.top - (count <= 8 ? 44 : 36));
    // Fit the actual bounds so a short edge can use the same space as a wider graph.
    const spanX = (right - left) * 1.08;
    const spanY = (bottom - top) * 1.1;
    const ratio = camera.getBoundedRatio(Math.max(spanX / availW, spanY / availH));
    const offset = renderer.viewportToFramedGraph({
      x: (available.left + available.right) / 2,
      y: (available.top + available.bottom) / 2,
    }, { cameraState: { ...cameraPose, ratio } });
    pose = { x: center.x + 0.5 - offset.x, y: center.y + 0.5 - offset.y, angle: 0, ratio };
  }
  moveCamera(camera, pose, duration);
}

// Canvas colours come from the app's tokens (shared/src/styles/tokens.css), read once.
let tokens;
const tok = name => {
  if (!tokens) {
    const css = getComputedStyle(document.documentElement);
    tokens = Object.fromEntries(['--bg', '--surface', '--surface-alt', '--ink', '--muted', '--accent', '--gold']
      .map(key => [key, css.getPropertyValue(key).trim()]));
  }
  return tokens[name];
};

function drawAvatarNode(ctx, x, y, r, info, state, onImgLoad) {
  const { alpha, isFocused, isHovered, isNeighbor, isBridgeLit, detail } = state;
  if (r < 1.2 || alpha <= 0.02) return;

  // Zoomed out: a flat dot in the region colour. Photos and logos fade in as you zoom.
  if (detail < 1) {
    const dotR = info.kind === 'team' ? r * 0.72 : r * 0.62;
    ctx.save();
    ctx.globalAlpha = alpha * (1 - detail);
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fillStyle = info.kind === 'team' ? info.ringColor
      : isBridgeLit ? tok('--gold')
        : info.isLatest ? info.ringColor : tok('--muted');
    ctx.fill();
    if (info.kind === 'team' || isFocused || isHovered) {
      // A ground-coloured rim keeps touching dots apart.
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isFocused ? tok('--accent') : isHovered ? tok('--ink') : tok('--bg');
      ctx.stroke();
    }
    ctx.restore();
    if (detail <= 0) return;
  }

  ctx.save();
  ctx.globalAlpha = alpha * detail;

  // Flat disc with the logo or photo clipped inside.
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  const img = r >= 4 ? getCachedImage(info.src, onImgLoad) : null;
  const logo = info.kind === 'team' && img ? teamLogoPresentation(img) : null;
  ctx.fillStyle = logo?.visible ? logo.background : info.kind === 'team' ? tok('--surface') : tok('--surface-alt');
  ctx.fillRect(x - r, y - r, r * 2, r * 2);

  if (img && img.naturalWidth > 0 && img.naturalHeight > 0 && logo?.visible !== false) {
    if (info.kind === 'team') {
      // Contain fit inside circle with breathing room
      const { sx, sy, sw, sh } = logo;
      const scale = Math.min(r * 1.22 / Math.max(sw, sh), r * 1.48 / Math.hypot(sw, sh));
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(img, sx, sy, sw, sh, x - dw / 2, y - dh / 2, dw, dh);
    } else {
      // Cover fit anchored near top so player faces are clearly framed
      const d = r * 2;
      const scale = Math.max(d / img.naturalWidth, d / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, x - dw / 2, y - r - (dh - d) * 0.14, dw, dh);
    }
  } else if (r >= 6.5) {
    ctx.fillStyle = tok('--muted');
    const fontSize = Math.max(8, Math.round(r * (info.kind === 'team' ? 0.62 : 0.78)));
    ctx.font = `700 ${fontSize}px 'Barlow Condensed', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.monogram, x, y + 0.5);
  }
  ctx.restore();

  // One ring; its colour is the node's state. Region colour at rest, ink on hover, accent when focused.
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  let strokeColor = info.ringColor;
  let lineWidth = info.kind === 'team' ? Math.max(1.6, Math.min(3, r * 0.12)) : Math.max(1.2, Math.min(2.2, r * 0.11));
  if (isFocused) {
    strokeColor = tok('--accent');
    lineWidth = Math.max(2.5, r * 0.14);
  } else if (isHovered) {
    strokeColor = tok('--ink');
    lineWidth = Math.max(2.2, r * 0.13);
  } else if (isBridgeLit) {
    strokeColor = tok('--gold');
    lineWidth = Math.max(2.2, r * 0.13);
  } else if (isNeighbor && info.kind === 'player') {
    strokeColor = tok('--ink');
  } else if (info.kind === 'player' && !info.isLatest) {
    strokeColor = tok('--muted');
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}

// Plain text with a ground-coloured halo, the way map labels sit on a map. No box.
function drawLabel(ctx, text, x, y, { strong, alpha, fontSize }) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${strong ? 700 : 500} ${fontSize}px 'Familjen Grotesk', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = tok('--bg');
  ctx.strokeText(text, x, y);
  ctx.fillStyle = strong ? tok('--ink') : tok('--muted');
  ctx.fillText(text, x, y);
  const width = ctx.measureText(text).width;
  ctx.restore();
  return { left: x - width / 2 - 2, top: y, right: x + width / 2 + 2, bottom: y + fontSize + 2 };
}

function overlaps(box, placed) {
  for (const other of placed) {
    if (box.left < other.right + 4 && box.right + 4 > other.left
      && box.top < other.bottom + 3 && box.bottom + 3 > other.top) {
      return true;
    }
  }
  return false;
}

function HoverTooltip({ hover, network, media, view }) {
  if (!hover || hover.view !== view) return null;
  const node = network.nodes.get(hover.key);
  const info = media.get(hover.key);
  if (!node || !info) return null;

  const connections = view.adjacency.get(hover.key)?.length ?? 0;
  const activeConnections = view.adjacency.get(hover.key)?.filter(e => e.latest).length ?? 0;

  const cardWidth = 236;
  const cardHeight = 86;
  let left = hover.x + hover.r + 22;
  let top = hover.y - cardHeight / 2 - 12;

  if (left + cardWidth > hover.width - 16) {
    left = hover.x - hover.r - cardWidth - 22;
  }
  left = Math.max(12, Math.min(hover.width - cardWidth - 12, left));
  top = Math.max(76, Math.min(hover.height - cardHeight - 16, top));

  return (
    <div className="network-hover-card" style={{ transform: `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)` }} aria-hidden="true">
      <div className={`network-hover-avatar ${info.kind}`} style={{ '--ring': info.ringColor, '--accent': info.accent }}>
        {info.src
          ? <img src={info.src} alt="" />
          : <span>{info.monogram}</span>}
      </div>
      <div className="network-hover-meta">
        <div className="network-hover-name">{node.label}</div>
        <div className="network-hover-sub">
          {info.kind === 'team' ? (
            <>
              <span className="network-hover-badge" style={{ '--dot': info.ringColor }}>{regionLabel(node.league)}</span>
              <span>{connections} {connections === 1 ? 'player' : 'players'}</span>
            </>
          ) : (
            <>
              {info.latestTeamName && (
                <span className="network-hover-team">{info.latestTeamTag || info.latestTeamName}</span>
              )}
              <span>{info.teamCount} {info.teamCount === 1 ? 'team' : 'teams'}</span>
              {activeConnections > 0 && <span className="network-hover-live">Active</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RosterNetworkCanvas({
  ref,
  network,
  view,
  onPick,
  onZoom,
  inspectorOpen,
  restore,
  externalHover,
  settings,
  islandLayout,
  onDraggedChange,
  spotlight,
  onLock,
}) {
  const spotlightRef = useRef(spotlight);
  const prevView = useRef(null);
  const tweenRaf = useRef(0);
  const loopRaf = useRef(0);
  const animUntil = useRef(0);
  const appearAt = useRef(new Map());
  const pulses = useRef([]);
  const lastTap = useRef(null);
  const settleStop = useRef(null);
  const careerMap = useMemo(() => careers(network), [network]);
  const host = useRef(null);
  const overlayRef = useRef(null);
  const engine = useRef(null);
  const graphRef = useRef(null);
  const basePositions = useRef(new Map());
  const display = useRef(view);
  const settingsRef = useRef(settings);
  const canvasHoverKey = useRef(null);
  const externalHoverRef = useRef(externalHover);
  const hoverNeighborhood = useRef(null);
  const hoverMix = useRef(0);
  const animRaf = useRef(0);
  const imgRaf = useRef(0);
  const dragRef = useRef(null);
  const suppressClickUntil = useRef(0);
  const lastRestore = useRef(null);
  const [unavailable, setUnavailable] = useState(false);
  const [tooltip, setTooltip] = useState(null);

  const media = useMemo(() => buildMediaMap(network), [network]);
  const mediaRef = useRef(media);

  const pick = useEffectEvent(key => onPick(key));
  const lock = useEffectEvent(key => onLock?.(key));
  const recordGesture = useEffectEvent(pose => onZoom(pose));
  const notifyDragged = useEffectEvent(val => onDraggedChange?.(val));

  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  useEffect(() => {
    settingsRef.current = settings;
    engine.current?.refresh();
  }, [settings]);

  const drawOverlay = useEffectEvent(() => {
    const renderer = engine.current;
    const canvas = overlayRef.current;
    const shown = display.current;
    if (!renderer || !canvas || !shown) return;

    const { width, height } = renderer.getDimensions();
    if (!width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const scheduleRedraw = () => {
      if (imgRaf.current) return;
      imgRaf.current = requestAnimationFrame(() => {
        imgRaf.current = 0;
        engine.current?.scheduleRefresh();
      });
    };

    const cameraRatio = renderer.getCamera().ratio;
    const cfg = settingsRef.current;
    const activeHoverKey = dragRef.current?.dragging ? null : (canvasHoverKey.current ?? externalHoverRef.current);
    const hood = hoverNeighborhood.current ?? spotlightRef.current;
    const mix = hoverNeighborhood.current ? hoverMix.current : (spotlightRef.current ? 1 : 0);
    const highlightBridges = Boolean(cfg.highlightBridges);
    const labelMode = cfg.labelMode ?? 'auto';
    const visibleCount = shown.nodes.size;
    const isFocusedView = Boolean(shown.focus);
    const now = performance.now();

    // Region names: a large faint word on the far side of each region's teams.
    if (!isFocusedView) {
      const regions = new Map();
      for (const key of shown.nodes) {
        const node = network.nodes.get(key);
        if (node?.type !== 'team') continue;
        const point = renderer.getNodeDisplayData(key);
        if (!point || point.hidden) continue;
        if (!regions.has(node.league)) regions.set(node.league, []);
        regions.get(node.league).push(renderer.framedGraphToViewport(point));
      }
      const all = [...regions.values()].flat();
      const gx = all.reduce((sum, p) => sum + p.x, 0) / (all.length || 1);
      const gy = all.reduce((sum, p) => sum + p.y, 0) / (all.length || 1);
      for (const [league, points] of regions) {
        if (points.length < 2) continue;
        const median = axis => points.map(p => p[axis]).sort((a, b) => a - b)[Math.floor(points.length / 2)];
        const cx = median('x');
        const cy = median('y');
        const dists = points.map(p => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b);
        const radius = Math.max(60, dists[Math.floor(dists.length * 0.8)] + 48);
        const color = network.leagues.get(league) ?? '#90baff';
        const fade = 1 - 0.7 * mix;
        const size = Math.round(Math.max(22, Math.min(64, radius * 0.28)));
        ctx.save();
        ctx.font = `700 ${size}px 'Barlow Condensed', 'Familjen Grotesk', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = `${Math.round(size * 0.12)}px`;
        ctx.fillStyle = withAlpha(color, 0.11 * fade);
        // Name sits on the far side of the region, away from the middle of the graph.
        const away = Math.atan2(cy - gy, cx - gx);
        ctx.fillText(regionLabel(league).toUpperCase(), cx + Math.cos(away) * radius * 0.85, cy + Math.sin(away) * radius * 0.85);
        ctx.restore();
      }
    }

    // Collect visible nodes in viewport
    const items = [];
    const margin = 64;

    for (const key of shown.nodes) {
      const point = renderer.getNodeDisplayData(key);
      if (!point || point.hidden) continue;
      const vp = renderer.framedGraphToViewport(point);
      if (vp.x < -margin || vp.x > width + margin || vp.y < -margin || vp.y > height + margin) continue;

      const node = network.nodes.get(key);
      const info = mediaRef.current.get(key);
      if (!node || !info) continue;

      const isFocused = key === shown.focus;
      const isHovered = key === activeHoverKey;
      const isNeighbor = Boolean(hood && hood.nodes.has(key) && !isHovered);
      const isBridgeLit = highlightBridges && info.isBridge;

      let r = renderer.scaleSize(point.size);
      if (isHovered) r *= 1.16;
      else if (isNeighbor && mix > 0.05) r *= 1 + 0.06 * mix;
      r = Math.min(info.kind === 'team' ? 42 : 32, r);

      // Photos once a node is big enough to read; always for the node you're pointing at.
      const lodStart = info.kind === 'team' ? 12 : 10;
      const detail = isFocused || isHovered ? 1 : clamp01((r - lodStart) / 5);

      // Smooth Obsidian dimming
      let alpha = 1;
      const born = appearAt.current.get(key);
      const grow = born ? easeInOut(clamp01((now - born) / APPEAR_MS)) : 1;
      if (hood && mix > 0.01 && !hood.nodes.has(key)) {
        alpha = 1 - 0.9 * mix;
      } else if (highlightBridges && !isBridgeLit && !isFocused && !isHovered && !isNeighbor) {
        alpha = info.kind === 'team' ? 0.55 : 0.22;
      }

      // Z-order priority
      let z = info.kind === 'team' ? 20 : 10;
      if (alpha < 0.4) z -= 15;
      if (isBridgeLit) z += 12;
      if (isNeighbor) z += 25;
      if (isHovered) z += 50;
      if (isFocused) z += 60;

      alpha *= grow;
      r *= 0.4 + 0.6 * grow;
      items.push({ key, node, info, x: vp.x, y: vp.y, r, alpha, detail, isFocused, isHovered, isNeighbor, isBridgeLit, z });
    }

    items.sort((a, b) => a.z - b.z);

    // Pass 1: Draw all circular nodes (team logos & player photos)
    for (const item of items) {
      drawAvatarNode(ctx, item.x, item.y, item.r, item.info, item, scheduleRedraw);
    }

    // Transfer pulses: a light travels from the old team to the new one, with a short tail.
    pulses.current = pulses.current.filter(pulse => now < pulse.start + PULSE_MS);
    for (const pulse of pulses.current) {
      const t = (now - pulse.start) / PULSE_MS;
      if (t < 0) continue;
      const fromPoint = renderer.getNodeDisplayData(pulse.from);
      const toPoint = renderer.getNodeDisplayData(pulse.to);
      if (!fromPoint || !toPoint) continue;
      const a = renderer.framedGraphToViewport(fromPoint);
      const b = renderer.framedGraphToViewport(toPoint);
      const bend = { x: (a.x + b.x) / 2 - (b.y - a.y) * 0.18, y: (a.y + b.y) / 2 + (b.x - a.x) * 0.18 };
      const at = s => ({
        x: (1 - s) ** 2 * a.x + 2 * (1 - s) * s * bend.x + s ** 2 * b.x,
        y: (1 - s) ** 2 * a.y + 2 * (1 - s) * s * bend.y + s ** 2 * b.y,
      });
      const head = easeInOut(clamp01(t / 0.85));
      const fadeOut = 1 - clamp01((t - 0.85) / 0.15);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = withAlpha(pulse.color, 0.16 * fadeOut);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(bend.x, bend.y, b.x, b.y);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const s = head - i * 0.022;
        if (s < 0) break;
        const p = at(s);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.2 - i * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(i ? pulse.color : tok('--ink'), (1 - i / 8) * fadeOut * 0.9);
        ctx.fill();
      }
      if (t > 0.8) {
        const ring = (t - 0.8) / 0.2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 6 + ring * 18, 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(pulse.color, 0.6 * (1 - ring));
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Pass 2: Draw collision-avoided labels above nodes
    const labelCandidates = [...items].sort((a, b) => {
      const score = item => {
        if (item.isFocused) return 1000;
        if (item.isHovered) return 900;
        if (item.isNeighbor) return 700 + (item.info.kind === 'team' ? 50 : 0);
        if (item.info.kind === 'team') return 400 + item.r;
        if (item.isBridgeLit) return 320 + item.r;
        return (item.info.isBridge ? 220 : 150) + item.r;
      };
      return score(b) - score(a);
    });

    const placed = [];
    for (const item of labelCandidates) {
      if (item.alpha < 0.35) continue;

      const mustShow = item.isFocused || item.isHovered || item.isNeighbor;
      if (!mustShow && labelMode === 'hover') continue;

      let labelAlpha = item.alpha;
      let shouldDraw = mustShow;

      if (!shouldDraw) {
        if (item.info.kind === 'team') {
          shouldDraw = true;
        } else {
          // Player labels: always clear when zoomed in, focused, small graph, or 'always' mode
          if (labelMode === 'always' || isFocusedView || visibleCount <= 55) {
            shouldDraw = true;
          } else {
            const threshold = item.info.isBridge ? 7.2 : 8.6;
            if (item.r >= threshold) {
              shouldDraw = true;
              const fade = Math.min(1, (item.r - threshold) / 4.5);
              labelAlpha *= 0.35 + 0.65 * fade;
            }
          }
        }
      }

      if (!shouldDraw) continue;

      const text = item.info.kind === 'team'
        ? (item.isFocused || item.isHovered || isFocusedView || cameraRatio < 0.6 ? item.node.label : (item.node.tag || item.node.label))
        : item.node.label;

      // Two sizes from the type ramp (--fs-label, --fs-micro): teams and the node in hand are strong, players quiet.
      const strong = item.isFocused || item.isHovered || item.info.kind === 'team';
      const fontSize = strong ? 13 : 11;
      ctx.font = `${strong ? 700 : 500} ${fontSize}px 'Familjen Grotesk', system-ui, sans-serif`;
      const half = ctx.measureText(text).width / 2 + 2;
      const labelY = item.y + item.r + 4;
      const box = { left: item.x - half, top: labelY, right: item.x + half, bottom: labelY + fontSize + 2 };

      if (!item.isFocused && !item.isHovered && overlaps(box, placed)) continue;

      const drawnBox = drawLabel(ctx, text, item.x, labelY, { strong, alpha: labelAlpha, fontSize });
      placed.push(drawnBox);
    }
  });

  // Keeps redrawing the overlay while pulses or fade-ins are playing.
  const kick = useEffectEvent(until => {
    animUntil.current = Math.max(animUntil.current, until);
    if (loopRaf.current) return;
    const tick = () => {
      engine.current?.scheduleRefresh();
      loopRaf.current = performance.now() < animUntil.current ? requestAnimationFrame(tick) : 0;
    };
    loopRaf.current = requestAnimationFrame(tick);
  });

  // Moves nodes to new positions over a short ease, instead of jumping.
  const tweenTo = targets => {
    const graph = graphRef.current;
    if (!graph) return;
    if (tweenRaf.current) cancelAnimationFrame(tweenRaf.current);
    tweenRaf.current = 0;
    if (reducedMotion()) {
      graph.updateEachNodeAttributes((key, attr) => (targets.has(key) ? { ...attr, ...targets.get(key) } : attr), { attributes: ['x', 'y'] });
      return;
    }
    const starts = new Map();
    for (const key of targets.keys()) {
      if (graph.hasNode(key)) starts.set(key, { x: graph.getNodeAttribute(key, 'x'), y: graph.getNodeAttribute(key, 'y') });
    }
    const began = performance.now();
    const step = now => {
      const t = easeInOut(clamp01((now - began) / TWEEN_MS));
      graph.updateEachNodeAttributes((key, attr) => {
        const from = starts.get(key);
        if (!from) return attr;
        const to = targets.get(key);
        return { ...attr, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      }, { attributes: ['x', 'y'] });
      tweenRaf.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    tweenRaf.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    spotlightRef.current = spotlight;
    const renderer = engine.current;
    if (!renderer) return;
    renderer.refresh();
    if (spotlight?.frame) frame(renderer, [...spotlight.nodes].filter(key => display.current?.nodes.has(key)));
  }, [spotlight]);

  const animateHoverMix = useEffectEvent(target => {
    if (animRaf.current) {
      cancelAnimationFrame(animRaf.current);
      animRaf.current = 0;
    }
    if (reducedMotion()) {
      hoverMix.current = target;
      engine.current?.scheduleRefresh();
      drawOverlay();
      return;
    }
    const startVal = hoverMix.current;
    const startTime = performance.now();
    const dur = 150;
    const tick = now => {
      const t = Math.min(1, (now - startTime) / dur);
      const eased = 1 - (1 - t) ** 3;
      hoverMix.current = startVal + (target - startVal) * eased;
      drawOverlay();
      if (t < 1) {
        animRaf.current = requestAnimationFrame(tick);
      } else {
        animRaf.current = 0;
      }
    };
    animRaf.current = requestAnimationFrame(tick);
  });

  const syncHoverState = useEffectEvent((key, fromCanvas = false, touch = false) => {
    const renderer = engine.current;
    const shown = display.current;
    if (!renderer || !shown) return;

    const effectiveKey = key && shown.nodes.has(key) ? key : null;
    if (effectiveKey) {
      hoverNeighborhood.current = neighborhood(shown.adjacency, effectiveKey, 1);
      animateHoverMix(1);
    } else {
      hoverNeighborhood.current = null;
      animateHoverMix(0);
    }

    if (fromCanvas && effectiveKey && !dragRef.current?.dragging) {
      const point = renderer.getNodeDisplayData(effectiveKey);
      if (point) {
        const vp = renderer.framedGraphToViewport(point);
        const { width, height } = renderer.getDimensions();
        const r = renderer.scaleSize(point.size) * (settingsRef.current.nodeScale ?? 1) * 1.18;
        setTooltip({ key: effectiveKey, x: vp.x, y: vp.y, r, width, height, view: shown, touch });
      }
    } else if (fromCanvas || !effectiveKey) {
      setTooltip(null);
    }

    renderer.scheduleRefresh();
  });

  // Sync external hover from Inspector sidebar
  useEffect(() => {
    externalHoverRef.current = externalHover;
    if (!canvasHoverKey.current) {
      syncHoverState(externalHover, false);
    }
  }, [externalHover]);

  useImperativeHandle(ref, () => ({
    getPose: () => engine.current?.getCamera().getState(),
    zoomIn: () => {
      const camera = engine.current?.getCamera();
      if (!camera) return;
      const ratio = camera.getBoundedRatio(camera.ratio * 0.72);
      if (ratio === camera.ratio) return;
      onZoom(camera.getState());
      moveCamera(camera, { ratio });
    },
    zoomOut: () => {
      const camera = engine.current?.getCamera();
      if (!camera) return;
      const ratio = camera.getBoundedRatio(camera.ratio / 0.72);
      if (ratio === camera.ratio) return;
      onZoom(camera.getState());
      moveCamera(camera, { ratio });
    },
    fit: () => engine.current && frame(engine.current, display.current?.nodes ?? view.nodes),
    resetLayout: () => {
      const graph = graphRef.current;
      const renderer = engine.current;
      if (!graph || !renderer || !basePositions.current.size) return;
      settleStop.current?.();
      const targets = display.current?.focus ? radialTargets(graph, display.current, network) : basePositions.current;
      tweenTo(targets);
      onDraggedChange?.(false);
      if (display.current) frame(renderer, display.current.nodes, TWEEN_MS, targets);
    },
  }), [network, view, onZoom, onDraggedChange]);

  useEffect(() => {
    const element = host.current;
    const graph = seedGraph(network);
    graphRef.current = graph;
    basePositions.current = new Map(graph.mapNodes((key, { x, y }) => [key, { x, y }]));

    let renderer;
    let disposed = false;
    const loseContext = () => setUnavailable(true);

    try {
      renderer = new Sigma(graph, element, {
        minCameraRatio: 0.045,
        maxCameraRatio: 2.8,
        renderLabels: false,
        renderEdgeLabels: false,
        stagePadding: 0,
        zoomToSizeRatioFunction: ratio => ratio ** 0.58,
        zIndex: true,
        enableCameraRotation: false,
        defaultDrawNodeHover: () => {},
        nodeReducer(key, attr) {
          const shown = display.current;
          if (shown && !shown.nodes.has(key)) return { ...attr, hidden: true };
          const scale = settingsRef.current?.nodeScale ?? 1;
          const isFocused = key === shown?.focus;
          return {
            ...attr,
            size: attr.size * scale * (isFocused ? 1.24 : 1),
            // Transparent WebGL node: Sigma handles quadtree hit-testing, 2D canvas renders crisp avatars/logos.
            color: 'rgba(0,0,0,0)',
            label: null,
          };
        },
        edgeReducer(key, attr) {
          const shown = display.current;
          const edge = shown?.edges.get(key);
          if (shown && !edge) return { ...attr, hidden: true };

          const hood = hoverNeighborhood.current ?? spotlightRef.current;
          const isLitEdge = hood ? hood.edges.has(key) : false;
          const region = network.leagues.get(network.nodes.get(edge?.team ?? attr.team)?.league) ?? '#90baff';
          const crossing = mediaRef.current.get(edge?.player)?.crossRegion;

          if (hood && !isLitEdge) {
            return { ...attr, color: withAlpha(tok('--muted'), 0.12), size: 0.4 };
          }
          if (isLitEdge) {
            return { ...attr, color: edge?.latest ? region : withAlpha(region, 0.6), size: edge?.latest ? 2.2 : 1.4, zIndex: 2 };
          }
          if (shown?.focus) {
            return { ...attr, color: withAlpha(region, edge?.latest ? 0.75 : 0.4), size: edge?.latest ? 1.5 : 0.95 };
          }
          // Links between regions are the interesting ones: they stay brighter.
          const strength = crossing ? (edge?.latest ? 0.7 : 0.45) : (edge?.latest ? 0.34 : 0.16);
          return { ...attr, color: withAlpha(crossing ? tok('--gold') : region, strength), size: crossing ? 1.1 : (edge?.latest ? 0.9 : 0.6) };
        },
      });
    } catch {
      element.replaceChildren();
      queueMicrotask(() => { if (!disposed) loseContext(); });
      return () => { disposed = true; };
    }

    engine.current = renderer;
    element.addEventListener('webglcontextlost', loseContext, true);

    renderer.on('afterRender', () => drawOverlay());

    // Hover interactions
    renderer.on('enterNode', ({ node }) => {
      if (dragRef.current?.dragging) return;
      canvasHoverKey.current = node;
      element.style.cursor = 'grab';
      syncHoverState(node, true);
    });
    renderer.on('leaveNode', () => {
      canvasHoverKey.current = null;
      if (!dragRef.current?.dragging) {
        element.style.cursor = '';
        syncHoverState(externalHoverRef.current, true);
      }
    });

    // Click to focus (ignored immediately after a drag)
    renderer.on('clickNode', ({ node, event }) => {
      if (performance.now() < suppressClickUntil.current) return;
      const original = event?.original;
      // Touch: first tap previews the node, second tap focuses it.
      if (typeof TouchEvent !== 'undefined' && original instanceof TouchEvent) {
        if (lastTap.current !== node) {
          canvasHoverKey.current = node;
          syncHoverState(node, true, true);
          lastTap.current = node;
          return;
        }
        lastTap.current = null;
        pick(node);
        return;
      }
      if (original?.shiftKey) {
        lock(node);
        return;
      }
      pick(node);
    });
    renderer.on('clickStage', () => {
      lastTap.current = null;
      canvasHoverKey.current = null;
      syncHoverState(externalHoverRef.current, true);
    });

    // Obsidian-style direct node dragging
    const mouse = renderer.getMouseCaptor();
    const touch = renderer.getTouchCaptor();
    const camera = renderer.getCamera();

    renderer.on('downNode', ({ node, event }) => {
      dragRef.current = {
        node,
        startX: event.x,
        startY: event.y,
        dragging: false,
      };
    });

    const onMouseMoveBody = event => {
      const drag = dragRef.current;
      if (!drag) return;
      const dist = Math.hypot(event.x - drag.startX, event.y - drag.startY);
      if (!drag.dragging && dist > 4) {
        drag.dragging = true;
        camera.disable();
        element.style.cursor = 'grabbing';
        setTooltip(null);
        cancelAnimationFrame(tweenRaf.current);
        tweenRaf.current = 0;
        settleStop.current?.();
      }
      if (!drag.dragging) return;
      const pos = renderer.viewportToGraph(event);
      const dx = pos.x - graph.getNodeAttribute(drag.node, 'x');
      const dy = pos.y - graph.getNodeAttribute(drag.node, 'y');
      graph.setNodeAttribute(drag.node, 'x', pos.x);
      graph.setNodeAttribute(drag.node, 'y', pos.y);
      // Neighbours follow: leaf nodes (one link) almost fully, shared ones barely.
      const adjacency = display.current?.adjacency;
      for (const edge of adjacency?.get(drag.node) ?? []) {
        const other = edge.team === drag.node ? edge.player : edge.team;
        if (!graph.hasNode(other)) continue;
        const pull = (adjacency.get(other)?.length ?? 0) === 1 ? 0.9 : 0.15;
        graph.updateNodeAttributes(other, attr => ({ ...attr, x: attr.x + dx * pull, y: attr.y + dy * pull }));
      }
      notifyDragged(true);
      event.preventSigmaDefault();
      event.original?.preventDefault();
    };

    const endDrag = () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.dragging) {
        camera.enable();
        suppressClickUntil.current = performance.now() + 140;
      }
      dragRef.current = null;
      element.style.cursor = canvasHoverKey.current ? 'grab' : '';
    };

    mouse.on('mousemovebody', onMouseMoveBody);
    mouse.on('mouseup', endDrag);
    window.addEventListener('pointerup', endDrag);

    let lastWheel = -Infinity;
    let pinchStart;
    const wheel = ({ delta }) => {
      if (!delta) return;
      setTooltip(null);
      const now = performance.now();
      const ratio = camera.getBoundedRatio(camera.ratio * (delta > 0 ? 0.5 : 2));
      if (now - lastWheel > 250 && ratio !== camera.ratio) recordGesture(camera.getState());
      lastWheel = now;
    };
    const doubleClick = () => {
      if (camera.getBoundedRatio(camera.ratio / 2) !== camera.ratio) recordGesture(camera.getState());
    };
    const startPinch = event => {
      if (event.touches.length === 2) pinchStart = camera.getState();
    };
    const endPinch = () => { pinchStart = undefined; };
    const updatePinch = ({ ratio }) => {
      if (!pinchStart || Math.abs(ratio - pinchStart.ratio) < 0.001) return;
      recordGesture(pinchStart);
      endPinch();
    };

    mouse.on('wheel', wheel);
    mouse.on('doubleClick', doubleClick);
    touch.on('doubletap', doubleClick);
    camera.on('updated', updatePinch);
    element.addEventListener('touchstart', startPinch, { capture: true, passive: true });
    element.addEventListener('touchend', endPinch, true);
    element.addEventListener('touchcancel', endPinch, true);

    if (display.current) frame(renderer, display.current.nodes, 0);

    let worker;
    let settleRaf = 0;
    if (graph.size) {
      try {
        worker = new LayoutWorker();
        worker.onmessage = ({ data: frames }) => {
          worker.terminate();
          if (disposed || !frames?.length) return;
          const toMap = list => new Map(list.map(([key, x, y]) => [key, { x, y }]));
          const last = toMap(frames[frames.length - 1]);
          basePositions.current = last;
          const shown = display.current;
          const write = targets => graph.updateEachNodeAttributes((key, attr) => {
            const to = targets.get(key);
            return to ? { ...attr, x: to.x, y: to.y } : attr;
          }, { attributes: ['x', 'y'] });
          if (shown?.focus) {
            // Hidden nodes still need their settled spots, or leaving focus starts from seed positions.
            const targets = radialTargets(graph, shown, network);
            write(new Map([...last].filter(([key]) => !targets.has(key))));
            renderer.refresh();
            tweenTo(targets);
            frame(renderer, shown.nodes, TWEEN_MS, targets);
            return;
          }
          if (reducedMotion()) {
            write(last);
            renderer.refresh();
            if (shown) frame(renderer, shown.nodes);
            return;
          }
          // Seed positions first, then each ForceAtlas2 snapshot; eased so the graph settles rather than snaps.
          const seq = [toMap(graph.mapNodes((key, { x, y }) => [key, x, y])), ...frames.map(toMap)];
          const began = performance.now();
          settleStop.current = () => {
            cancelAnimationFrame(settleRaf);
            settleRaf = 0;
            settleStop.current = null;
            write(last);
            // The camera was aimed at mid-settle positions; re-aim at where nodes ended up.
            renderer.refresh();
            if (display.current) frame(renderer, display.current.nodes, 0);
          };
          const step = now => {
            const p = clamp01((now - began) / SETTLE_MS);
            const at = (1 - (1 - p) ** 3) * (seq.length - 1);
            const i = Math.min(Math.floor(at), seq.length - 2);
            const t = at - i;
            const a = seq[i];
            const b = seq[i + 1];
            graph.updateEachNodeAttributes((key, attr) => {
              const from = a.get(key);
              const to = b.get(key);
              return from && to ? { ...attr, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t } : attr;
            }, { attributes: ['x', 'y'] });
            if (p < 1) {
              settleRaf = requestAnimationFrame(step);
              return;
            }
            settleRaf = 0;
            settleStop.current = null;
            if (display.current) frame(renderer, display.current.nodes);
          };
          settleRaf = requestAnimationFrame(step);
        };
        worker.onerror = () => worker.terminate();
        worker.postMessage({
          nodes: graph.mapNodes((key, { x, y, size }) => [key, { x, y, size }]),
          edges: network.edges.map(({ player, team }) => ({ player, team })),
        });
      } catch {
        worker?.terminate();
      }
    }

    return () => {
      disposed = true;
      worker?.terminate();
      cancelAnimationFrame(settleRaf);
      settleStop.current = null;
      prevView.current = null;
      cancelAnimationFrame(tweenRaf.current);
      cancelAnimationFrame(loopRaf.current);
      tweenRaf.current = 0;
      loopRaf.current = 0;
      animUntil.current = 0;
      if (animRaf.current) cancelAnimationFrame(animRaf.current);
      if (imgRaf.current) cancelAnimationFrame(imgRaf.current);
      mouse.off('mousemovebody', onMouseMoveBody);
      mouse.off('mouseup', endDrag);
      window.removeEventListener('pointerup', endDrag);
      mouse.off('wheel', wheel);
      mouse.off('doubleClick', doubleClick);
      touch.off('doubletap', doubleClick);
      camera.off('updated', updatePinch);
      element.removeEventListener('touchstart', startPinch, true);
      element.removeEventListener('touchend', endPinch, true);
      element.removeEventListener('touchcancel', endPinch, true);
      element.removeEventListener('webglcontextlost', loseContext, true);
      renderer.kill();
      engine.current = null;
      graphRef.current = null;
      display.current = null;
      hoverNeighborhood.current = null;
      canvasHoverKey.current = null;
    };
  }, [network]);

  useEffect(() => {
    const prev = prevView.current;
    display.current = view;
    canvasHoverKey.current = null;
    hoverNeighborhood.current = null;
    hoverMix.current = 0;
    lastTap.current = null;
    if (host.current) host.current.style.cursor = '';
    if (!engine.current || !graphRef.current) return;
    settleStop.current?.();
    const now = performance.now();
    for (const [key, at] of appearAt.current) if (now - at > APPEAR_MS) appearAt.current.delete(key);

    const targets = view.focus ? radialTargets(graphRef.current, view, network) : basePositions.current;
    tweenTo(targets);
    engine.current.refresh();

    // Timeline scrubbing only changes the period: keep the camera where it is.
    const periodOnly = Boolean(prev) && prev !== view && prev.period !== view.period
      && prev.focus === view.focus && prev.depth === view.depth && prev.league === view.league;
    if (periodOnly) {
      for (const key of view.nodes) if (!prev.nodes.has(key)) appearAt.current.set(key, now);
      let until = now + APPEAR_MS;
      const month = /^\d{4}-\d{2}$/;
      if (month.test(prev.period) && month.test(view.period) && view.period > prev.period) {
        let count = 0;
        for (const [key, edge] of view.edges) {
          if (count >= 40) break;
          if (prev.edges.has(key)) continue;
          const from = previousTeam(careerMap.get(edge.player), edge);
          if (!from) continue;
          const color = network.leagues.get(network.nodes.get(edge.team)?.league) ?? '#90baff';
          pulses.current.push({ from, to: edge.team, color, start: now + count * 45 });
          count++;
        }
        if (count) until = now + PULSE_MS + 45 * 40 + 50;
      }
      kick(until);
    } else if (restore && restore !== lastRestore.current && restore.focus === view.focus && restore.depth === view.depth
      && restore.inspectorOpen === inspectorOpen) {
      lastRestore.current = restore;
      moveCamera(engine.current.getCamera(), restore.pose);
    } else {
      // A spotlight that asked to be framed (story, route) wins over framing the whole view.
      const lit = spotlightRef.current?.frame ? [...spotlightRef.current.nodes].filter(key => view.nodes.has(key)) : [];
      frame(engine.current, lit.length ? lit : view.nodes, TWEEN_MS, targets);
    }
    prevView.current = view;
  }, [network, careerMap, view, inspectorOpen, restore, islandLayout]);

  return <>
    <div className="network-canvas-wrap">
      <div className="network-canvas" ref={host} aria-hidden="true" />
      <canvas className="network-overlay-canvas" ref={overlayRef} aria-hidden="true" />
      <HoverTooltip hover={tooltip} network={network} media={media} view={view} />
    </div>
    {unavailable && <p className="network-message" role="status">The graph is unavailable. Use search or the directory.</p>}
  </>;
}
