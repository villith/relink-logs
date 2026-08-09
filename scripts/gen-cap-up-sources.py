#!/usr/bin/env python3
"""Generates src/assets/cap-up-sources.json — the damage-cap-up magnitudes the
Events tab's cap card reconstructs a hit's cap from.

The game fuses every cap-up source into ONE number per attack class before the
hook can see it, so the card cannot decompose that total; it reconstructs the
sources independently and reports the difference as Unaccounted. This file is
the magnitude side of that reconstruction. Three source families:

  traits          Sigil / wrightstone / summon-main / weapon-innate traits.
                  Traits STACK INTO ONE COMBINED LEVEL and the value is looked
                  up once at that total (see computeCombinedTraits) — it is not
                  summed per sigil.
  overmasteries   Class per id; the magnitude is already on the log, as
                  `Overmastery.value`.
  summonBonuses   Class per id; the magnitude is already shipped, in
                  src-tauri/assets/summon-bonus-values.json.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/skill_status.tbl -o <dir>
  2. python scripts/gen-cap-up-sources.py <dir>/system/table/skill_status.tbl

The class maps need no extraction — they are read from this repo's own English
tables, which are themselves regenerated from the game on a patch.

skill_status.tbl is parsed raw for the same reason gen-trait-max-levels.py
parses it raw: GBFRDataTools' skill_status.headers predates v2.0.2 and lists six
value columns where the live row has ten. v2.0.4 layout:
  +0x00  10 x f32 per-level effect values
  +0x28  u32 Key hash (the trait id, matches traits.json keys)
  +0x2C  u32 LevelDescription hash
  +0x30  u32 Level

WHICH of the ten f32 is the cap-up is trait-specific — there is no fixed
Normal/Skill/SBA split. The slots are named by the trait's own EXPLAIN string
(`TXT_SKILL_EXPLAIN_<code>` in system/table/text/<locale>/text.msg), whose {n}
placeholders index these columns directly. For DMG Cap that string reads

    Attack DMG Cap +{0}% / Skill DMG Cap +{1}% / SBA DMG Cap +{2}%

so slots 0/1/2 ARE the per-class cap-ups for THAT trait, and the ANCHORS below
pin them.

Only UNCONDITIONAL traits are emitted. The other four cap traits are all
conditional and their magnitude is not a function of the loadout alone:

  DMG Cap Cobalt   ({2}..{3}) scales with excess critical hit rate over 100%
  DMG Cap Ecru     ({2}..{3}) scales with maximum health
  DMG Cap Cardinal ({6})      a stacking buff, at full only "At Cardinal V"
  DMG Cap Sage     ({6})      a stacking buff, gained per link level

Emitting their maximum would overstate the reconstruction and shrink Unaccounted
by a number the formula did not necessarily use. They stay unattributed, which
is the honest answer, until the runtime state that selects their value is on the
log.

Output shape:
  {
    "traits":        { "<traitHash8>": [[normal, skill, sba], ...] },   # index = level - 1
    "overmasteries": { "<idHash8>": "normal" | "skill" | "sba" },
    "summonBonuses": { "<idHash8>": "normal" | "skill" | "sba" }
  }
Trait values are percentages, exactly as the game displays them.
"""

import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ROW_SIZE = 52
KEY_OFFSET = 0x28
LEVEL_OFFSET = 0x30
INVALID = 0xFFFFFFFF

# Unconditional cap traits -> the value column per attack class, from the
# trait's own EXPLAIN placeholders (see the module docstring).
UNCONDITIONAL_TRAITS = {
    0xDC584F60: {"name": "DMG Cap", "slots": (0, 1, 2)},
}

# Trait anchors: (level, expected [normal, skill, sba]). The 238 is ground
# truth — a level-63 DMG Cap reads "DMG Cap +238%" in game.
TRAIT_ANCHORS = {
    0xDC584F60: [(1, [3.0, 3.0, 3.0]), (63, [238.0, 238.0, 238.0]), (65, [250.0, 250.0, 250.0])],
}

# The game's own English effect names -> attack class. Healing Cap Up is
# deliberately absent: it is not a damage cap and never enters this formula.
CLASS_BY_NAME = {
    "Normal Attack Damage Cap Up": "normal",
    "Skill Damage Cap Up": "skill",
    "Skybound Art Damage Cap Up": "sba",
}

# One known id per class, so a renamed or re-hashed table fails loudly rather
# than silently emitting an empty map. These are utils.ts' OVERMASTERY_EFFECT_IDS.
OVERMASTERY_ANCHORS = {"06595c52": "normal", "0b0e4311": "skill", "047b7a70": "sba"}
SUMMON_BONUS_ANCHORS = {"9245dfa4": "normal", "2ffb509f": "skill", "5a1d2c89": "sba"}


def trait_values(tbl_path: Path) -> dict[str, list[list[float]]]:
    """Per-level [normal, skill, sba] cap-up percentages for each unconditional trait."""
    data = tbl_path.read_bytes()
    row_count = struct.unpack_from("<q", data, 0)[0]
    if 8 + row_count * ROW_SIZE != len(data):
        sys.exit(f"skill_status.tbl row size is no longer {ROW_SIZE} — re-derive the offsets")

    by_trait: dict[int, dict[int, list[float]]] = {}
    for i in range(row_count):
        offset = 8 + i * ROW_SIZE
        key = struct.unpack_from("<I", data, offset + KEY_OFFSET)[0]
        if key == INVALID or key not in UNCONDITIONAL_TRAITS:
            continue
        level = struct.unpack_from("<I", data, offset + LEVEL_OFFSET)[0]
        columns = struct.unpack_from("<10f", data, offset)
        by_trait.setdefault(key, {})[level] = [columns[s] for s in UNCONDITIONAL_TRAITS[key]["slots"]]

    out: dict[str, list[list[float]]] = {}
    for key, spec in UNCONDITIONAL_TRAITS.items():
        levels = by_trait.get(key)
        if not levels:
            sys.exit(f"{spec['name']} ({key:08x}) has no rows in skill_status.tbl — the Key column moved")
        # Contiguous 1..max, so the level indexes the array directly.
        top = max(levels)
        missing = [level for level in range(1, top + 1) if level not in levels]
        if missing:
            sys.exit(f"{spec['name']} is missing levels {missing} — the Level column moved")
        for level, expected in TRAIT_ANCHORS[key]:
            if levels[level] != expected:
                sys.exit(f"{spec['name']} L{level} reads {levels[level]}, expected {expected} — columns moved")
        out[f"{key:08x}"] = [levels[level] for level in range(1, top + 1)]
    return out


def class_map(lang_file: str, anchors: dict[str, str]) -> dict[str, str]:
    """id -> attack class, for every id the English table names as a damage cap up."""
    table = json.loads((ROOT / "src-tauri" / "lang" / "en" / lang_file).read_text(encoding="utf-8"))
    out = {key: CLASS_BY_NAME[entry["text"]] for key, entry in table.items() if entry.get("text") in CLASS_BY_NAME}
    for anchor, expected in anchors.items():
        if out.get(anchor) != expected:
            sys.exit(f"{lang_file}: anchor {anchor} maps to {out.get(anchor)}, expected {expected}")
    return out


def main() -> None:
    tbl_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not tbl_path or not Path(tbl_path).exists():
        sys.exit("usage: gen-cap-up-sources.py <skill_status.tbl> (see module docstring)")

    out = {
        "traits": trait_values(Path(tbl_path)),
        "overmasteries": class_map("overmasteries.json", OVERMASTERY_ANCHORS),
        "summonBonuses": class_map("summon-bonuses.json", SUMMON_BONUS_ANCHORS),
    }

    out_path = ROOT / "src" / "assets" / "cap-up-sources.json"
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"{len(out['traits'])} traits, {len(out['overmasteries'])} overmasteries, "
        f"{len(out['summonBonuses'])} summon bonuses -> {out_path}"
    )


if __name__ == "__main__":
    main()
