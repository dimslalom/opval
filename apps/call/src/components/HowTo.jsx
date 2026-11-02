import cards from '../../../../shared/src/data/cards.json';
import { ECONOMY, TRACKED_MAX } from '../../../../src/engine/collect/rules';
import { assetPath, thumbnailSrc } from '../../../../shared/src/lib/utils';
import { logoFor } from '../lib/orgs';

const virtyy = cards.find(card => card.id === 'loud-virtyy-gold-001');
const valyn = cards.find(card => card.id === 'g2-valyn-gold-001');
const monyet = cards.find(card => card.player === 'Monyet' && card.org === 'RRQ');
const xavi = cards.find(card => card.player.toLowerCase() === 'xavi8k');

function Team({ tag }) {
  const logo = logoFor(tag);
  return <span className="guide-team">{logo && <img src={logo} alt="" />}<b>{tag}</b></span>;
}

function Logo({ tag }) {
  const logo = logoFor(tag);
  return logo ? <img src={logo} alt="" /> : null;
}

function Player({ card }) {
  if (!card) return null;
  const image = thumbnailSrc(card);
  return <span className="guide-player">
    {image && <img src={assetPath(image)} alt="" />}
    <b>{card.player}</b>
  </span>;
}

export default function HowTo({ onDone }) {
  return <div className="guide">
    <section className="guide-row">
      <div className="guide-copy">
        <h3>Call a match</h3>
        <p>Before kickoff, pick a winner. Score and star are optional.</p>
      </div>
      <div className="guide-match" role="img" aria-label="Example call: LOUD selected over GE">
        <span className="guide-match-picked"><Team tag="LOUD" /><span aria-hidden="true">✓</span></span>
        <span className="guide-match-other"><Team tag="GE" /></span>
      </div>
    </section>

    <section className="guide-row">
      <div className="guide-copy">
        <h3>Guess roster moves</h3>
        <p>In Rosters, tap a team, then a player: who replaces them, or where they go. Stake credits. Every move Riot confirms before the roster lock pays.</p>
      </div>
      <div className="guide-swap guide-move" role="img" aria-label="Example guess: xavi8k replaces Monyet on RRQ">
        <span className="guide-move-out"><small>Out</small><Player card={monyet} /></span>
        <span className="guide-swap-arrow" aria-hidden="true">→</span>
        <span><small>In</small><Player card={xavi} /></span>
      </div>
    </section>

    <section className="guide-row">
      <div className="guide-copy">
        <h3>Track your ten</h3>
        <p>Open your two free packs to build a team. Only Tracked cards earn player points. Swap with Storage in Cards.</p>
      </div>
      <div className="guide-swap" role="img" aria-label={`Swap a player from Storage into your ${TRACKED_MAX} Tracked cards`}>
        <span><small>Tracked</small><Player card={virtyy} /></span>
        <span className="guide-swap-arrow" aria-hidden="true">←</span>
        <span><small>Storage</small><Player card={valyn} /></span>
      </div>
    </section>

    <section className="guide-row">
      <div className="guide-copy">
        <h3>Play bingo</h3>
        <p>Pick four squares during this week and lock your card. Later matches and official roster changes can score. Name a match to earn more. Lines and a full card pay again.</p>
      </div>
      {/* A mini weekly card in the real card's language: short names, the target as logos, a hit in green glass. */}
      <div className="guide-bingo" role="img" aria-label="Example weekly bingo card: Overtime in NRG against T1 for 5 points has hit; 13-5 stomp in any match for 2; Player joins for 5; Ace for 3">
        <span data-hit="true"><b>5</b><small>Overtime</small><i><Logo tag="NRG" /><Logo tag="T1" /></i></span>
        <span><b>2</b><small>13-5 stomp</small><i><Logo tag="LOUD" /><Logo tag="G2" /><Logo tag="PRX" /><em>+5</em></i></span>
        <span data-rare="true"><b>5</b><small>Player joins</small><i><em>Riot GCD</em></i></span>
        <span><b>3</b><small>Ace</small><i><Logo tag="PRX" /><Logo tag="LOUD" /></i></span>
      </div>
    </section>

    <section className="guide-row guide-row-last">
      <div className="guide-copy">
        <h3>Reveal &amp; collect</h3>
        <p>Reveal finished results to score your call and cards. Earn credits for packs.</p>
      </div>
      <div className="guide-reward" role="img" aria-label={`Points earn credits; ${ECONOMY.packCost} credits opens ${ECONOMY.packSize} cards`}>
        <span className="guide-reveal-pill">Reveal result <span aria-hidden="true">↗</span></span>
        <span className="guide-reward-pack"><img src="/assets/pack/OpVAL-Front.png" alt="" /><strong>{ECONOMY.packCost} <small>CR</small></strong><span>{ECONOMY.packSize} cards</span></span>
      </div>
    </section>

    <footer className="guide-footer"><button type="button" className="primary" onClick={onDone}>Got it</button></footer>
  </div>;
}
