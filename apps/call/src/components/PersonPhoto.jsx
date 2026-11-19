import { cardFor } from '../lib/rosterCards';
import { colorsFor, tagForName } from '../lib/orgs';

// A person's cut-out photo from the designed cards, on their team's colour. Handles are matched
// as GCD writes them, then without spaces ("luk xo" is "lukxo" on the card). No card: initials.
// Some cards carry a placeholder image, which reads as a broken photo: treat it as none.
const photoOf = (handle, team) => {
  const photo = (cardFor(handle, team) ?? cardFor(String(handle).replace(/\s+/g, ''), team))?.photo;
  return photo && !photo.includes('placeholder') ? photo : null;
};

export default function PersonPhoto({ handle, team, size = 'tile' }) {
  const photo = photoOf(handle, team);
  return <span className="person-photo" data-size={size} style={{ '--team': colorsFor(tagForName(team))[0] }} aria-hidden="true">
    {photo ? <img src={photo} alt="" loading="lazy" /> : <b>{String(handle).slice(0, 2)}</b>}
  </span>;
}
