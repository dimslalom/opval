import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  IconAdjustmentsHorizontal,
  IconArrowLeft,
  IconArrowUpRight,
  IconChevronRight,
  IconFocusCentered,
  IconMinus,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRestore,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import RosterNetworkCanvas from '../components/RosterNetworkCanvas';
import RosterSource from '../components/RosterSource';
import { buildMediaMap } from '../lib/graphMedia';
import { personPath, teamPath, useRoster } from '../lib/roster';
import {
  createNetwork, filterNetwork, findStories, isMonth, monthLabel, neighborhood,
  otherEnd, pathEdges, regionLabel, shortestPath,
} from '../lib/rosterNetwork';
import { rosterDay } from '../lib/time';
import '../styles/roster-network.css';

const PAGE_SIZE = 20;
const fold = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const monthAt = (months, seconds) => Math.max(0, months.indexOf(new Date(seconds * 1000).toISOString().slice(0, 7)));
const dot = color => <span className="network-dot" style={{ '--dot': color }} aria-hidden="true" />;

function NodeAvatar({ info, size = 'sm' }) {
  if (!info) return null;
  return (
    <span
      className={`network-avatar network-avatar-${info.kind} network-avatar-${size}`}
      style={{ '--ring': info.ringColor, '--accent': info.accent }}
      aria-hidden="true"
    >
      {info.src ? <img src={info.src} alt="" loading="lazy" /> : <b>{info.monogram}</b>}
    </span>
  );
}

function Directory({ query, matches, media, visible, onPick, onHover }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  return <div className="network-directory">
    <div className="network-list-title">
      <h2>{query ? 'Search results' : 'Directory'}</h2>
      <span>{matches.length}</span>
    </div>
    {matches.length ? <>
      <ul className="network-entries" onMouseLeave={() => onHover(null)}>
        {matches.slice(0, limit).map(([key, node]) => {
          const info = media.get(key);
          const count = visible.adjacency.get(key)?.length ?? 0;
          return <li key={key}>
            <button
              type="button"
              onClick={() => onPick(key)}
              onMouseEnter={() => onHover(key)}
              onFocus={() => onHover(key)}
              onBlur={() => onHover(null)}
            >
              <NodeAvatar info={info} size="sm" />
              <span className="network-entry-text">
                <strong>{node.label}</strong>
                <small>
                  {node.type === 'team'
                    ? regionLabel(node.league)
                    : (info?.latestTeamTag || info?.latestTeamName || 'Player')}
                </small>
              </span>
              <span className="network-entry-count" aria-label={`${count} connections`}>{count}</span>
            </button>
          </li>;
        })}
      </ul>
      {matches.length > limit && (
        <button type="button" className="network-text-button" onClick={() => setLimit(n => n + PAGE_SIZE)}>
          Show more ({matches.length - limit} left)
        </button>
      )}
    </> : <p className="network-empty">{query ? 'No matches in these filters.' : 'No players or teams in these filters.'}</p>}
  </div>;
}

function Connections({ node, focus, edges, nodes, media, sources, months, leagues, onPick, onHover, onRoute }) {
  const info = media.get(focus);
  const sortedEdges = useMemo(
    () => [...edges].sort((a, b) => Number(b.latest) - Number(a.latest) || nodes.get(otherEnd(a, focus)).label.localeCompare(nodes.get(otherEnd(b, focus)).label)),
    [edges, nodes, focus],
  );
  return <>
    <div className="network-profile">
      <div className="network-profile-head">
        <NodeAvatar info={info} size="lg" />
        <div className="network-profile-title">
          <h2>{node.label}</h2>
          <p>
            {node.type === 'team'
              ? <span className="network-league-pill" style={{ '--dot': info?.ringColor }}>{regionLabel(node.league)}</span>
              : (info?.latestTeamName ? `Latest: ${info.latestTeamName}` : 'Tracked player')}
          </p>
        </div>
      </div>
      <Link className="network-profile-link secondary" to={node.type === 'team' ? teamPath(node) : personPath(node)}>
        {node.type === 'team' ? 'Open team profile' : 'Open player profile'}
        <IconArrowUpRight size={14} aria-hidden="true" />
      </Link>
      <button type="button" className="network-text-button" onClick={onRoute}>Find a route to…</button>
    </div>
    <div className="network-list-title">
      <h3>{node.type === 'team' ? 'Players' : 'Teams'}</h3>
      <span>{sortedEdges.length}</span>
    </div>
    {sortedEdges.length ? <ul className="network-stints" onMouseLeave={() => onHover(null)}>
      {sortedEdges.map(edge => {
        const other = otherEnd(edge, focus);
        const related = nodes.get(other);
        const relatedInfo = media.get(other);
        const total = months.length || 1;
        const spans = edge.stints.map(stint => [monthAt(months, stint.firstSeenAt), monthAt(months, stint.lastSeenAt), stint]);
        const from = Math.min(...spans.map(span => span[0]));
        const to = Math.max(...spans.map(span => span[1]));
        return <li key={edge.key}>
          <details>
            <summary
              onMouseEnter={() => onHover(other)}
              onFocus={() => onHover(other)}
              onBlur={() => onHover(null)}
            >
              <NodeAvatar info={relatedInfo} size="sm" />
              <span className="network-stint-name">{related.label}</span>
              {edge.latest && <small className="network-latest-pill">Latest</small>}
              <IconChevronRight size={14} aria-hidden="true" />
              <span
                className="network-span"
                role="img"
                aria-label={from === to ? `Listed ${monthLabel(months[from])}` : `Listed ${monthLabel(months[from])} – ${monthLabel(months[to])}`}
                style={{ '--seg': leagues.get(nodes.get(edge.team).league) }}
              >
                {spans.map(([a, b, stint]) => <i
                  key={stint.id}
                  className={stint.latest ? 'is-latest' : undefined}
                  style={{ left: `${a / total * 100}%`, width: `${(b - a + 1) / total * 100}%` }}
                />)}
              </span>
            </summary>
            <ul>
              {[...edge.stints].sort((a, b) => b.firstSeenAt - a.firstSeenAt).map(stint => {
                const source = sources.find(item => item.id === stint.sourceId);
                return <li key={stint.id}>
                  <span>{stint.firstSeenAt === stint.lastSeenAt
                    ? `Listed ${rosterDay(stint.firstSeenAt)}`
                    : `Listed ${rosterDay(stint.firstSeenAt)} – ${rosterDay(stint.lastSeenAt)}`}</span>
                  {(stint.archiveUrl || source?.url) && <a href={stint.archiveUrl ?? source.url} target="_blank" rel="noreferrer">
                    {stint.archiveUrl ? 'Archive capture' : source.name} <IconArrowUpRight size={12} aria-hidden="true" />
                  </a>}
                </li>;
              })}
            </ul>
            <button type="button" className="network-text-button" onClick={() => onPick(other)}>
              Focus on {related.label}
            </button>
          </details>
        </li>;
      })}
    </ul> : <p className="network-empty">No connections match these filters.</p>}
  </>;
}

function RouteView({ route, nodes, media, onFocus, onClear }) {
  const steps = route.path.length - 1;
  return <>
    <div className="network-list-title">
      <h2>Route</h2>
      <span>{steps} {steps === 1 ? 'step' : 'steps'}</span>
    </div>
    <ol className="network-route">
      {route.path.map(key => <li key={key}>
        <button type="button" onClick={() => onFocus(key)}>
          <NodeAvatar info={media.get(key)} size="sm" />
          <span className="network-entry-text">
            <strong>{nodes.get(key).label}</strong>
            <small>{nodes.get(key).type === 'team' ? 'Team' : 'Player'}</small>
          </span>
        </button>
      </li>)}
    </ol>
    <button type="button" className="network-text-button" onClick={onClear}>Clear route</button>
  </>;
}

function Timeline({ network, period, onChange }) {
  const { months, activity } = network;
  const [playing, setPlaying] = useState(false);
  const index = months.indexOf(period);
  const max = Math.max(...activity, 1);
  const step = useEffectEvent(() => {
    if (index + 1 >= months.length) setPlaying(false);
    else onChange(months[index + 1]);
  });
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => step(), 700);
    return () => clearInterval(timer);
  }, [playing]);
  if (months.length < 2) return null;

  const label = isMonth(period) ? monthLabel(period) : period === 'latest' ? 'Latest rosters' : period || 'All tracked history';
  const choose = value => {
    setPlaying(false);
    onChange(value);
  };
  return <div className="network-timeline" role="group" aria-label="Roster timeline">
    <div className="tier-switch" role="group" aria-label="Roster history" style={{ '--n': 2 }}>
      <button type="button" className={period === '' ? 'primary' : undefined} aria-pressed={period === ''} onClick={() => choose('')}>All</button>
      <button type="button" className={period === 'latest' ? 'primary' : undefined} aria-pressed={period === 'latest'} onClick={() => choose('latest')}>Latest</button>
    </div>
    <button
      type="button"
      className="network-play"
      aria-label={playing ? 'Pause timeline' : 'Play timeline'}
      onClick={() => {
        if (!playing && (index < 0 || index === months.length - 1)) onChange(months[0]);
        setPlaying(on => !on);
      }}
    >
      {playing ? <IconPlayerPause size={16} aria-hidden="true" /> : <IconPlayerPlay size={16} aria-hidden="true" />}
    </button>
    <span className="network-timeline-label" aria-live="polite">{label}</span>
    <div className="network-timeline-track">
      <div className="network-histogram" aria-hidden="true">
        {activity.map((count, i) => <i key={months[i]} className={index < 0 || i <= index ? 'is-on' : undefined}
          style={{ height: `${Math.max(count / max * 100, 4)}%` }} />)}
      </div>
      <input
        type="range"
        min="0"
        max={months.length - 1}
        step="1"
        value={index < 0 ? months.length - 1 : index}
        aria-label="Roster month"
        aria-valuetext={label}
        onChange={event => choose(months[Number(event.target.value)])}
      />
    </div>
  </div>;
}

function DisplaySettings({ open, settings, onChange, hasDragged, onResetLayout, onClose }) {
  if (!open) return null;
  return (
    <div className="network-settings" role="dialog" aria-label="Graph display settings">
      <div className="network-settings-head">
        <h3>Display</h3>
        <button type="button" className="network-settings-close" aria-label="Close display settings" onClick={onClose}>
          <IconX size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="network-settings-group">
        <span className="network-settings-label">Name labels</span>
        <div className="tier-switch" role="group" aria-label="Label visibility" style={{ '--n': 3 }}>
          {[
            ['auto', 'Auto'],
            ['always', 'Always'],
            ['hover', 'Hover'],
          ].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={settings.labelMode === mode ? 'primary' : undefined}
              aria-pressed={settings.labelMode === mode}
              onClick={() => onChange({ ...settings, labelMode: mode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="network-settings-group">
        <div className="network-settings-row">
          <label htmlFor="network-node-scale" className="network-settings-label">Node size</label>
          <span className="network-settings-value">{Math.round(settings.nodeScale * 100)}%</span>
        </div>
        <input
          id="network-node-scale"
          type="range"
          min="0.75"
          max="1.5"
          step="0.05"
          value={settings.nodeScale}
          onChange={event => onChange({ ...settings, nodeScale: Number(event.target.value) })}
        />
      </div>
      <label className="network-toggle">
        <span>
          <strong>Transfer bridges</strong>
          <small>Highlight players on 2+ teams</small>
        </span>
        <input
          type="checkbox"
          checked={settings.highlightBridges}
          onChange={event => onChange({ ...settings, highlightBridges: event.target.checked })}
        />
      </label>
      {hasDragged && (
        <button type="button" className="network-reset-layout" onClick={onResetLayout}>
          <IconRestore size={15} aria-hidden="true" /> Reset dragged positions
        </button>
      )}
    </div>
  );
}

function Explorer({ data }) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [hoveredKey, setHoveredKey] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const [settings, setSettings] = useState({
    labelMode: 'auto',
    nodeScale: 1,
    highlightBridges: false,
  });

  const network = useMemo(() => createNetwork(data), [data]);
  const media = useMemo(() => buildMediaMap(network), [network]);
  const league = network.leagues.has(params.get('league')) ? params.get('league') : '';
  const requested = params.get('period');
  const period = requested === 'latest' || network.years.includes(Number(requested)) || network.months.includes(requested) ? requested : '';
  const focus = params.get('focus');
  const selected = network.nodes.get(focus);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(selected));
  const [history, setHistory] = useState([]);
  const [restore, setRestore] = useState(null);
  const [spotlight, setSpotlight] = useState(null);
  const [route, setRoute] = useState(null);
  const canvas = useRef(null);
  const searchInput = useRef(null);
  const depth = params.get('depth') === '2' ? 2 : 1;
  const visible = useMemo(() => filterNetwork(network, { league, period }), [network, league, period]);
  const view = useMemo(() => {
    const local = selected ? neighborhood(visible.adjacency, focus, depth) : null;
    return {
      focus: selected ? focus : null,
      depth,
      period,
      league,
      adjacency: visible.adjacency,
      nodes: local?.nodes ?? new Set(visible.adjacency.keys()),
      edges: new Map(visible.edges.filter(edge => !local || local.edges.has(edge.key)).map(edge => [edge.key, edge])),
    };
  }, [selected, focus, depth, visible, period, league]);
  const counts = useMemo(() => {
    let teams = 0;
    for (const key of view.nodes) if (network.nodes.get(key).type === 'team') teams++;
    return { teams, players: view.nodes.size - teams };
  }, [network, view]);
  const directory = useMemo(() => [...visible.adjacency.keys()].map(key => [key, network.nodes.get(key)])
    .sort(([, a], [, b]) => Number(b.type === 'team') - Number(a.type === 'team') || a.label.localeCompare(b.label)), [network, visible]);
  const q = fold(query.trim());
  const matches = useMemo(() => q ? directory.filter(([, node]) => fold(`${node.label} ${node.tag ?? ''}`).includes(q))
    .sort(([, a], [, b]) => Number(fold(b.label) === q || fold(b.tag ?? '') === q) - Number(fold(a.label) === q || fold(a.tag ?? '') === q))
    : directory, [directory, q]);
  const sources = data.sources;
  const stories = useMemo(() => findStories(network), [network]);
  const trail = useMemo(() => {
    const seen = new Set(view.focus ? [view.focus] : []);
    const past = [];
    for (const entry of [...history].reverse()) {
      if (past.length < 4 && entry.focus && network.nodes.has(entry.focus) && !seen.has(entry.focus)) {
        seen.add(entry.focus);
        past.push(entry.focus);
      }
    }
    return [...past.reverse(), ...(view.focus ? [view.focus] : [])];
  }, [history, view.focus, network]);

  function update(change, replace = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace, preventScrollReset: true });
  }

  function clearSpotlight() {
    setSpotlight(null);
    setRoute(null);
  }

  function open(key) {
    setSpotlight(null);
    setSettingsOpen(false);
    setInspectorOpen(true);
    if (key === view.focus && depth === 1) return;
    checkpoint();
    update({ focus: key, depth: null });
  }

  function connect(key) {
    if (key === route.from) return;
    setInspectorOpen(true);
    const path = shortestPath(visible.adjacency, route.from, key);
    if (!path) {
      setSpotlight(null);
      setRoute({ from: route.from, miss: true });
      return;
    }
    if (view.focus) {
      checkpoint();
      update({ focus: null, depth: null });
    }
    setRoute({ from: route.from, path });
    setSpotlight({
      nodes: new Set(path),
      edges: pathEdges(path),
      frame: true,
      label: `${network.nodes.get(path[0]).label} to ${network.nodes.get(key).label}`,
    });
  }

  function pick(key) {
    setQuery('');
    setHoveredKey(null);
    if (route) connect(key);
    else open(key);
  }

  function startRoute() {
    setRoute({ from: focus });
    setSpotlight(null);
    setQuery('');
    setInspectorOpen(true);
    requestAnimationFrame(() => searchInput.current?.focus());
  }

  function tell(story) {
    if (spotlight?.story === story.id) {
      setSpotlight(null);
      return;
    }
    setRoute(null);
    setHistory([]);
    update({ focus: null, depth: null, league: '', period: story.period ?? '' }, true);
    setSpotlight({ nodes: story.nodes, edges: story.edges, frame: true, label: story.title, story: story.id });
  }

  function checkpoint(pose = canvas.current?.getPose()) {
    const entry = { focus: view.focus, depth, inspectorOpen, pose };
    setHistory(entries => [...entries.slice(-49), entry]);
  }

  function back() {
    const previous = history.at(-1);
    if (!previous && !selected) return false;
    const target = previous ?? { focus: null, depth: 1, inspectorOpen: false };
    setHistory(history.slice(0, -1));
    clearSpotlight();
    setQuery('');
    setHoveredKey(null);
    setInspectorOpen(target.inspectorOpen);
    if (target.pose) setRestore({ ...target });
    if (target.focus !== view.focus || target.depth !== depth) {
      update({ focus: target.focus, depth: target.depth === 2 ? '2' : null }, true);
    }
    return true;
  }

  const handleKeydown = useEffectEvent(event => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    const tag = event.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable;

    if (event.key === 'Escape') {
      if (spotlight || route) {
        clearSpotlight();
        event.preventDefault();
        return;
      }
      if (settingsOpen) {
        setSettingsOpen(false);
        event.preventDefault();
        return;
      }
      if (back()) event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      setSettingsOpen(false);
        setInspectorOpen(true);
      requestAnimationFrame(() => searchInput.current?.focus());
      return;
    }

    if (typing) return;

    if (event.key === '/') {
      event.preventDefault();
      setSettingsOpen(false);
        setInspectorOpen(true);
      requestAnimationFrame(() => searchInput.current?.focus());
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      canvas.current?.zoomIn();
    } else if (event.key === '-') {
      event.preventDefault();
      canvas.current?.zoomOut();
    } else if (event.key === '0' || event.key.toLowerCase() === 'f') {
      event.preventDefault();
      canvas.current?.fit();
    }
  });

  useEffect(() => {
    const listener = event => handleKeydown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return <>
    <div className="network-hud" role="region" data-panel={inspectorOpen || settingsOpen} aria-label="Graph controls">
      <div className="network-toolbar">
        {(history.length > 0 || selected) && <button type="button" className="network-back" onClick={back}
          title="Previous graph view (Esc)" aria-keyshortcuts="Escape">
          <IconArrowLeft size={17} aria-hidden="true" /> Back
        </button>}
        <button type="button" className="network-search-toggle" aria-expanded={inspectorOpen}
          aria-controls="network-inspector" onClick={() => {
            if (!inspectorOpen) {
              setSettingsOpen(false);
                      }
            setInspectorOpen(!inspectorOpen);
          }}
          title="Search & explore (/ or Cmd+K)">
          {inspectorOpen ? <IconX size={17} aria-hidden="true" /> : <IconSearch size={17} aria-hidden="true" />}
          {inspectorOpen ? 'Close panel' : 'Explore'}
        </button>
      </div>

      <div className="network-controls">
        <div className="network-tools" role="group" aria-label="Graph camera">
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => canvas.current?.zoomIn()}><IconPlus size={18} aria-hidden="true" /></button>
          <button type="button" aria-label="Zoom out" title="Zoom out (-)" onClick={() => canvas.current?.zoomOut()}><IconMinus size={18} aria-hidden="true" /></button>
          <button type="button" aria-label="Fit graph" title="Fit graph (F)" onClick={() => canvas.current?.fit()}><IconFocusCentered size={18} aria-hidden="true" /></button>
          <button type="button" aria-label="Graph display settings" title="Display settings" aria-expanded={settingsOpen} onClick={() => {
            if (!settingsOpen) {
              setInspectorOpen(false);
                      }
            setSettingsOpen(!settingsOpen);
          }}><IconAdjustmentsHorizontal size={18} aria-hidden="true" /></button>
        </div>
        {trail.length > 1 && <nav className="network-trail" aria-label="Recently visited">
          <ol>
            {trail.map((key, i) => <li key={key}>
              <button type="button" aria-current={i === trail.length - 1 ? 'true' : undefined} onClick={() => pick(key)}>
                {network.nodes.get(key).label}
              </button>
            </li>)}
          </ol>
        </nav>}
        <div className="network-extent">
          {selected && <div className="tier-switch network-depth" role="group" aria-label="Connection depth" style={{ '--n': 2 }}>
            {[[1, 'Direct'], [2, 'Two steps']].map(([value, text]) => (
              <button key={value} type="button" className={depth === value ? 'primary' : undefined} aria-pressed={depth === value} onClick={() => {
                if (depth === value) return;
                checkpoint();
                update({ depth: value === 2 ? '2' : null }, true);
              }}>{text}</button>
            ))}
          </div>}
          {selected && <button type="button" className="network-clear" onClick={() => {
            setHistory([]);
            clearSpotlight();
            update({ focus: null, depth: null });
          }}>
            <IconX size={16} aria-hidden="true" /> Clear focus
          </button>}
        </div>
        <Timeline network={network} period={period} onChange={value => update({ period: value }, true)} />
        {view.nodes.size > 0 && <ul className="network-legend" aria-label="Graph legend">
          {[...network.leagues].map(([key, color]) => {
            const active = league === key;
            const dimmed = Boolean(league && !active);
            return <li key={key}>
              <button
                type="button"
                className={`network-legend-btn${active ? ' is-active' : ''}${dimmed ? ' is-dim' : ''}`}
                aria-pressed={active}
                title={active ? `Show all leagues` : `Filter to ${regionLabel(key)}`}
                onClick={() => {
                  setHistory([]);
                  update({ league: active ? '' : key }, true);
                }}
              >
                {dot(color)}{regionLabel(key)}
              </button>
            </li>;
          })}
        </ul>}
        {spotlight && <div className="network-chip">
          <span>{spotlight.label}</span>
          <button type="button" aria-label="Clear spotlight" onClick={clearSpotlight}>
            <IconX size={14} aria-hidden="true" />
          </button>
        </div>}
        {!selected && stories.length > 0 && <section className="network-highlights" aria-labelledby="network-highlights-title">
          <h2 id="network-highlights-title">Highlights</h2>
          <ul className="network-stories">
            {stories.map(story => <li key={story.id}>
              <button type="button" className="network-story" aria-pressed={spotlight?.story === story.id} onClick={() => tell(story)}>
                <span>{story.kicker}</span>
                <strong>{story.title}</strong>
                <small>{story.detail}</small>
              </button>
            </li>)}
          </ul>
        </section>}

        <div className="network-counts" aria-live="polite">
          <span><b>{counts.teams}</b> {counts.teams === 1 ? 'team' : 'teams'}</span>
          <span><b>{counts.players}</b> {counts.players === 1 ? 'player' : 'players'}</span>
          <span><b>{view.edges.size}</b> {view.edges.size === 1 ? 'link' : 'links'}</span>
        </div>
        <details className="network-source">
          <summary>Data sources</summary>
          <div>
            <p>Links show observed roster listings. Past coverage varies by team and year.</p>
            <RosterSource sources={sources} now={data.generatedAt} />
            <Link to="/legal">Legal</Link>
          </div>
        </details>
      </div>
      <DisplaySettings
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        hasDragged={hasDragged}
        onResetLayout={() => canvas.current?.resetLayout()}
        onClose={() => setSettingsOpen(false)}
      />
      <aside id="network-inspector" className="network-inspector" aria-label="Explore roster connections" hidden={!inspectorOpen}>
        <form className="network-search" role="search" onSubmit={event => {
          event.preventDefault();
          if (q && matches.length) pick(matches[0][0]);
        }}>
          <IconSearch size={17} aria-hidden="true" />
          <input
            ref={searchInput}
            type="search"
            aria-label="Search players or teams"
            placeholder="Find a player or team..."
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          {!query && <kbd className="network-kbd" aria-hidden="true">/</kbd>}
        </form>
        <div className="network-inspector-body" key={q ? 'search' : route ? 'route' : focus ?? 'directory'}>
          {route?.path && !q && <RouteView
            route={route}
            nodes={network.nodes}
            media={media}
            onFocus={key => {
              setRoute(null);
              open(key);
            }}
            onClear={clearSpotlight}
          />}
          {route && (!route.path || q) && <p className="network-hint">
            Route from {network.nodes.get(route.from).label}
          </p>}
          {route?.miss && <p className="network-empty" role="status">No route in these filters.</p>}
          {!route && selected && !q
            ? <Connections
              node={selected}
              focus={focus}
              edges={visible.adjacency.get(focus) ?? []}
              nodes={network.nodes}
              media={media}
              sources={sources}
              months={network.months}
              leagues={network.leagues}
              onPick={pick}
              onHover={setHoveredKey}
              onRoute={startRoute}
            />
            : (!route?.path || q) && <Directory
              key={q}
              query={q}
              matches={matches}
              media={media}
              visible={visible}
              onPick={pick}
              onHover={setHoveredKey}
            />}
        </div>
      </aside>
    </div>

    <div className="network-map">
      <RosterNetworkCanvas
        ref={canvas}
        network={network}
        view={view}
        onPick={pick}
        onZoom={checkpoint}
        inspectorOpen={inspectorOpen}
        restore={restore}
        externalHover={hoveredKey}
        spotlight={spotlight}
        onLock={key => {
          setRoute(null);
          setSpotlight({ ...neighborhood(visible.adjacency, key, 1), frame: false, label: network.nodes.get(key).label });
        }}
        settings={settings}
        islandLayout={String(settingsOpen)}
        onDraggedChange={setHasDragged}
      />
      {view.nodes.size === 0 && <p className="network-message">No connections match these filters.</p>}
    </div>
  </>;
}

export default function RosterNetwork() {
  const { data, error } = useRoster('/api/roster/v2/graph');
  return <main className="network-page">
    <h1 className="sr">Roster Graph</h1>
    {error && <p className="error" role="alert">{error}</p>}
    {!data && !error && <p className="loading" role="status">Loading roster history</p>}
    {data && <Explorer data={data} />}
  </main>;
}
