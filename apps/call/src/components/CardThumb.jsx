import PlayerCard from '../../../../shared/src/components/PlayerCard';

// The designed FIFA-style card at a given scale. `kit` re-dresses the player in another
// team's jersey (used for the club you pick, later).
export default function CardThumb({ card, scale = 0.28, kit, selected = false, onClick }) {
  return (
    <div style={{ width: 400 * scale, height: 580 * scale, flexShrink: 0 }}>
      <PlayerCard card={card} kit={kit} displayScale={scale} tilt={false} canDrag={false} pressScale={0.99} selected={selected} onClick={onClick} portraitLoading="lazy" showSpecialties={false} />
    </div>
  );
}
