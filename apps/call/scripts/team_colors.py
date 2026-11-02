"""Refresh OpVAL's team colors from the logo artwork in public/assets/orgs."""

import colorsys
import json
from collections import defaultdict
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
CARDS = ROOT / "shared/src/data/cards.json"
OUT = ROOT / "apps/call/src/data/teamColors.json"

# These marks have important secondary colors or a dominant dark/white field.
OVERRIDES = {
    "LOUD": ["#49e829", "#159447"],
    "GE": ["#cf3347", "#f3f4f5", "#3157a8"],
    "FUT": ["#15203b", "#d73750"],
    "KC": ["#2e68dc", "#f0f3fb"],
    "VIT": ["#ffe500"],
    "PRX": ["#ff69b4"],
}


def primary(path):
    image = Image.open(path).convert("RGBA")
    image.thumbnail((120, 120))
    bins = defaultdict(lambda: [0, 0, 0, 0])
    neutrals = defaultdict(lambda: [0, 0, 0, 0])
    for r, g, b, a in image.getdata():
        if a < 128:
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        target = bins if s >= .25 and v >= .22 else neutrals
        key = int(h * 24) if target is bins else int(v * 5)
        bucket = target[key]
        bucket[0] += 1
        bucket[1] += r
        bucket[2] += g
        bucket[3] += b
    source = bins if bins else neutrals
    if not source:
        return "#6e778b"
    count, red, green, blue = max(source.values(), key=lambda row: row[0])
    return f"#{red // count:02x}{green // count:02x}{blue // count:02x}"


logos = {}
for card in json.loads(CARDS.read_text()):
    if card.get("org") and card.get("org_logo"):
        logos.setdefault(card["org"], ROOT / "public" / card["org_logo"].lstrip("/"))
for tag, team in json.loads((ROOT / "src/data/teams.json").read_text()).items():
    logos[tag] = ROOT / "public" / team["logo"].lstrip("/")

colors = {tag: [primary(path)] for tag, path in sorted(logos.items()) if path.exists()}
colors.update(OVERRIDES)
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(dict(sorted(colors.items())), indent=2) + "\n")
print(f"Wrote colors for {len(colors)} teams to {OUT}")
