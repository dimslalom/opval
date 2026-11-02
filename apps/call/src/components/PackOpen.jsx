import { useEffect, useRef, useState } from 'react';
import { m } from 'motion/react';
import CardThumb from './CardThumb';
import CardPeek3D from './CardPeek3D';
import { peekDrag } from '../lib/cardCurl';
import PackTear from '../../../../shared/src/components/PackTear';
import { playUiSound } from '../../../../shared/src/lib/gameAudio';

// The pack-open moment, built on what makes Pokemon TCG Pocket and Balatro packs feel good:
//  1. You open it yourself (drag the foil), so the pull feels earned, not delivered.
//  2. Cards come out face down and you turn each one, so every card is its own small bet.
//  3. Worst first, best last: the stack builds toward the hit instead of spending it up front.
//  4. A hit announces itself: a gold card rattles before it turns, then lands with a shake.
//  5. Every turn climbs a note, so a pack plays as a rising phrase, and the shake scales with the pull.
//  6. Repeats stay cheap: Space/tap drives everything, and Reveal all skips to the result.

const HIT = new Set(['gold', 'icon']);
const RATTLE_MS = 560;
const AUTO_PEEK_MS = 420;
const FLIP_MS = 380;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function PackOpen({ pids, cardOf, onDone }) {
  const ref = useRef(null);
  const stageRef = useRef(null);
  const busy = useRef(false);
  const timers = useRef([]);
  const press = useRef(null);   // an edge-peek drag in progress
  const peek = useRef(null);
  const suppressClick = useRef(false);
  const [order] = useState(() => [...pids].filter(cardOf).sort((a, b) => cardOf(a).rating - cardOf(b).rating));
  const [phase, setPhase] = useState('pack');   // pack -> stack -> done
  const [i, setI] = useState(0);                 // the card on top of the stack
  const [up, setUp] = useState(false);           // is it turned?
  const [rattling, setRattling] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [big] = useState(() => matchMedia('(min-width: 700px)').matches);

  // Focus the dialog itself, not the pack, so opening by tap does not draw a focus ring on the art.
  useEffect(() => { if (!ref.current.open) { ref.current.showModal(); ref.current.focus(); } }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => { if (phase === 'stack') stageRef.current?.querySelector('.pk-stack')?.focus(); }, [phase]);

  const shake = (px, deg = 0) => {
    if (still()) return;
    stageRef.current?.animate(
      [0, -1, 0.8, -0.6, 0.3, 0].map(k => ({ transform: `translate(${k * px}px, ${-k * px * 0.5}px) rotate(${k * deg}deg)` })),
      { duration: 160 + px * 40, easing: 'ease-out' },
    );
  };

  const turn = (showPeek = false) => {
    if (busy.current) return;
    const tier = cardOf(order[i]).palette;
    const reduced = still();
    const hit = HIT.has(tier);
    busy.current = true;
    setRevealing(true);
    // A tap gives the same edge curl a short moment in the spotlight before
    // the turn. A completed drag has already shown it, so it turns directly.
    if (showPeek && !reduced) peek.current?.peek(0.96, 1);
    const land = () => {
      setRattling(false);
      setUp(true);
      const finish = () => { busy.current = false; setRevealing(false); };
      if (reduced) finish();
      else timers.current.push(setTimeout(finish, FLIP_MS));
      if (hit) {
        playUiSound('jackpot');
        shake(8, 1);
        if (!reduced) stageRef.current?.querySelector('.pk-flash')?.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' });
      } else {
        playUiSound('reveal', i);
        shake(tier === 'silver' ? 3 : 2);
      }
    };
    if (hit && !reduced) {
      setRattling(true);
      timers.current.push(...[0, 140, 260, 360, 440, 500].map(t => setTimeout(() => playUiSound('rattle'), t)));
    }
    const delay = reduced ? 0 : Math.max(showPeek ? AUTO_PEEK_MS : 0, hit ? RATTLE_MS : 0);
    if (delay) timers.current.push(setTimeout(land, delay));
    else land();
  };

  // One captured pointer owns the curl; cancellation never reveals a card.
  const peekDown = e => {
    if (e.button !== 0 || !e.isPrimary || press.current) return;
    suppressClick.current = false;
    if (up || busy.current) return;
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, width: e.currentTarget.getBoundingClientRect().width, progress: 0, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const peekMove = e => {
    const pr = press.current;
    if (!pr || pr.id !== e.pointerId) return;
    const drag = peekDrag(e.clientX - pr.x, e.clientY - pr.y, pr.width);
    pr.moved ||= drag.moved;
    pr.progress = drag.progress;
    if (pr.moved) peek.current?.peek(drag.progress, drag.side);
  };
  const peekUp = (e, cancelled = false) => {
    const pr = press.current;
    if (!pr || pr.id !== e.pointerId) return;
    press.current = null;
    suppressClick.current = pr.moved || cancelled;
    peek.current?.peek(0, 1);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!cancelled && pr.moved && pr.progress >= 0.98) turn();
  };

  const advance = () => {
    if (busy.current || phase !== 'stack') return;
    if (!up) return turn(true);
    setUp(false);
    if (i + 1 >= order.length) setPhase('done');
    else setI(i + 1);
  };

  const revealAll = () => { press.current = null; peek.current?.peek(0, 1); timers.current.forEach(clearTimeout); busy.current = false; setRattling(false); setRevealing(false); setI(order.length); setPhase('done'); };

  const scale = big ? 0.55 : 0.48;
  const tray = order.slice(0, phase === 'done' ? 0 : i);
  const best = order[order.length - 1];

  return (
    <dialog ref={ref} className="pk" tabIndex={-1} onClose={onDone} aria-label="Open pack">
      <div className="pk-top">
        {phase === 'stack' && <button className="secondary" onClick={revealAll}>Reveal all</button>}
      </div>

      <div ref={stageRef} className="pk-stage" data-phase={phase}>
        <div className="pk-flash" aria-hidden="true" />

        {phase === 'pack' && (
          <div className="pk-pack">
            <PackTear interactive onTorn={() => { playUiSound('impact'); setPhase('stack'); }} frontSrc="/assets/pack/OpVAL-Front.png" topSrc="/assets/pack/OpVAL-Top.png" insideSrc={null} />
          </div>
        )}

        {phase === 'stack' && (
          <div className="pk-stack" role="button" tabIndex={0} aria-label={up ? `${cardOf(order[i]).player}, rating ${cardOf(order[i]).rating}. Next card` : 'Turn the card'} data-busy={revealing} aria-busy={revealing} onClick={e => { if (e.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; } advance(); }} onPointerDown={peekDown} onPointerMove={peekMove} onPointerUp={e => peekUp(e)} onPointerCancel={e => peekUp(e, true)} onLostPointerCapture={e => peekUp(e, true)} onDragStart={e => e.preventDefault()}
            onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); } }}
            style={{ width: 400 * scale, height: 580 * scale }}>
            {order.slice(i).reverse().map((pid, k, rest) => {
              const depth = rest.length - 1 - k;   // 0 = top card
              const top = depth === 0;
              return (
                <m.div key={pid} layoutId={`pk-${pid}`} className="pk-card" data-up={top && up} data-rattle={top && rattling} data-tier={cardOf(pid).palette}
                  style={{ zIndex: 10 - depth, x: depth * 4, y: depth * 5, rotate: (depth % 2 ? 1 : -1) * depth * 1.5 }}>
                  {top ? <CardPeek3D card={cardOf(pid)} scale={scale} up={up} hasNext={rest.length > 1} controllerRef={peek} /> : (
                    <div className="pk-back"><div className="pk-back-art"><span className="pk-back-seal" aria-hidden="true">VCT</span></div></div>
                  )}
                </m.div>
              );
            })}
          </div>
        )}

        {phase === 'done' && (
          <div className="pk-done">
            {[...order].reverse().map(pid => (
              <m.div key={pid} layoutId={`pk-${pid}`} className="pk-result" data-best={pid === best}>
                <CardThumb card={cardOf(pid)} scale={pid === best ? (big ? 0.38 : 0.34) : (big ? 0.3 : 0.24)} />
              </m.div>
            ))}
          </div>
        )}
      </div>

      <div className="pk-foot">
        {phase === 'pack' && <div className="pk-gesture pk-gesture-tear" aria-label="Drag the top of the pack to tear it open"><span aria-hidden="true">↔</span></div>}
        {phase === 'stack' && (
          <div className="pk-tray" aria-label="Revealed">
            {order.map((pid, k) => (
              <div key={pid} className="pk-slot" data-current={k === i} data-revealed={tray.includes(pid)}>
                {tray.includes(pid) && <m.div layoutId={`pk-${pid}`}><CardThumb card={cardOf(pid)} scale={0.11} /></m.div>}
                {!tray.includes(pid) && <span className="pk-slot-number" aria-hidden="true">{k + 1}</span>}
              </div>
            ))}
          </div>
        )}
        {phase === 'stack' && <div className="pk-gesture" aria-label={up ? 'Tap for the next card' : 'Tap to turn the card, drag the edge to peek'}><span className="pk-tap-cue" aria-hidden="true" />{!up && <span className="pk-drag-cue" aria-hidden="true">↔</span>}</div>}
        {phase === 'done' && <button className="primary big" autoFocus onClick={() => ref.current.close()}>Done</button>}
      </div>
    </dialog>
  );
}
