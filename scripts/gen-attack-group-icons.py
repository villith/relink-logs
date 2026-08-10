#!/usr/bin/env python3
"""Generate src/assets/attack-group-icons.json — which INPUT ICON the game's
own skillboard UI renders for each per-character attack group.

## Why this exists

Every character's board carries two "Attacks: DMG Cap +35%" nodes whose
shipped English text is IDENTICAL — but the in-game UI distinguishes them
with an input icon (mouse-left vs mouse-right on PC). The icon is not in the
string: `text_skillboard.msg` holds the text with `<d>` placeholders, and
`text_skillboard_tag.msg` (MessagePack, like every .msg) maps each text id to
the icon ids rendered at those placeholders. Joining a node's EXPL text id
(already shipped as `key` in lang/en/skillboard.json) to that tag table pins
each attack group to its icon:

    group 0 -> icon 4 on every character that has it   (basic-attack input)
    group 1 -> icon 3 on every character               (special-attack input)
    Tweyen's charged pair splits the same way (g3=4, g4=3); Rackam's group 18
    renders BOTH icons ("<4>/<3> Attacks"); groups named in words (Multilock
    Hail, Turbine...) carry no icon at all.

The icon does NOT dissolve the solver's value ambiguity by itself — that
still needs to know which input each ACTION id belongs to — but it makes the
twin groups distinguishable data for display, for manual derivation, and for
annotating ambiguity flags with what each candidate group actually means.

## Running it

    GBFRDataTools.exe extract -i <game>/data.i -f system/table/text/en/text_skillboard_tag.msg -o <tmp>
    python scripts/gen-attack-group-icons.py <tmp>/system/table/text/en/text_skillboard_tag.msg

Requires `pip install msgpack`.
"""

import json
import sys
from pathlib import Path

import msgpack

ROOT = Path(__file__).resolve().parent.parent
NODES_PATH = ROOT / "src" / "assets" / "skillboard-cap-sources.json"
LANG_PATH = ROOT / "src-tauri" / "lang" / "en" / "skillboard.json"
OUT_PATH = ROOT / "src" / "assets" / "attack-group-icons.json"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <extracted text_skillboard_tag.msg>")

    with open(sys.argv[1], "rb") as handle:
        tags = msgpack.unpack(handle, strict_map_key=False, raw=False)
    icons_by_text_id = {
        entry["Element"]["id_"]: [icon["Element"]["icon_"] for icon in entry["Element"]["icons_"]]
        for entry in tags["Tag"]["tags_"]
    }

    nodes = json.loads(NODES_PATH.read_text(encoding="utf8"))["nodes"]
    lang = json.loads(LANG_PATH.read_text(encoding="utf8"))

    characters: dict[str, dict[str, list[int]]] = {}
    conflicts = []
    for key, node in sorted(nodes.items()):
        for effect in node["effects"]:
            if effect.get("stat") != "cap" or effect.get("scope") != "attack-group":
                continue
            if effect.get("abilityIds"):
                continue  # ability-scoped: resolved by hash, no group icon needed
            text_id = (lang.get(key) or {}).get("key")
            icons = icons_by_text_id.get(text_id, []) if text_id else []
            character = key.split("_")[0]
            group = str(effect["targetAttackGroup"])
            existing = characters.setdefault(character, {})
            if group in existing and existing[group] != icons:
                # Two nodes of one group disagreeing about the icon would mean
                # the group id does not determine the input — that would break
                # the whole reading, so it must fail loudly, not average out.
                conflicts.append((character, group, existing[group], icons))
            existing[group] = icons

    if conflicts:
        sys.exit(f"icon conflicts within a group: {conflicts}")

    # Hand-rolled layout matching what Prettier produces for this shape (short
    # arrays inline), so `npm run format` never rewrites a fresh regeneration.
    lines = ['{', '  "version": "2.0.4",', '  "characters": {']
    character_items = sorted(characters.items())
    for character_index, (character, groups) in enumerate(character_items):
        lines.append(f'    "{character}": {{')
        group_items = sorted(groups.items(), key=lambda item: int(item[0]))
        for group_index, (group, icons) in enumerate(group_items):
            comma = "," if group_index < len(group_items) - 1 else ""
            rendered = ", ".join(str(icon) for icon in icons)
            lines.append(f'      "{group}": [{rendered}]{comma}')
        comma = "," if character_index < len(character_items) - 1 else ""
        lines.append(f"    }}{comma}")
    lines += ["  }", "}", ""]
    OUT_PATH.write_text("\n".join(lines), encoding="utf8", newline="\n")
    with_icons = sum(1 for groups in characters.values() for icons in groups.values() if icons)
    total = sum(len(groups) for groups in characters.values())
    print(f"{len(characters)} characters, {total} groups ({with_icons} icon-tagged) -> {OUT_PATH}")


if __name__ == "__main__":
    main()
