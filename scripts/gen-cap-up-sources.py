#!/usr/bin/env python3
"""Generates src/assets/cap-up-sources.json — the damage-cap-up magnitudes the
Events tab's cap card reconstructs a hit's cap from.

The game fuses every cap-up source into ONE number per attack class before the
hook can see it, so the card cannot decompose that total; it reconstructs the
sources independently and reports the difference as Unaccounted. This file is
the magnitude side of that reconstruction. Source families:

  traits             Sigil / wrightstone / summon-main / weapon-innate traits
                     whose cap-up applies UNCONDITIONALLY. Traits STACK INTO ONE
                     COMBINED LEVEL and the value is looked up once at that
                     total (see computeCombinedTraits) — never summed per sigil.
  conditionalTraits  Cap traits whose value is NOT a function of the loadout
                     alone — HP/crit gates, stacking buffs, timed procs,
                     per-grade shots, per-pet scaling. Emitted at their MAXIMUM
                     so the card can show the potential as its own row, marked
                     conditional and EXCLUDED from the attributed total
                     (Scott's ruling, 2026-08-08): counting a conditional at
                     full value would shrink Unaccounted by a number the
                     formula did not necessarily use.
  transcendedTraits  The three boundary weapon traits (Ain, Two-Crown,
                     Seven-Star) carry an extra cap-up block that applies only
                     when the weapon is transcended. Kept apart from `traits`
                     because whether it ADDS to or REPLACES the base block is
                     not yet verified against the oracle.
  overmasteries      Class per id; the magnitude is already on the log, as
                     `Overmastery.value`.
  summonBonuses      Class per id; the magnitude is already shipped, in
                     src-tauri/assets/summon-bonus-values.json.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/skill_status.tbl -o <dir>
     GBFRDataTools extract -i <data.i> -f system/table/text/en/text.msg -o <dir>
  2. python scripts/gen-cap-up-sources.py <dir>/system/table

## How the trait set was derived — by effect, never by name

Every trait's effect is its `TXT_SKILL_EXPLAIN_<code>` string in the game's
text table (`<code>` is the trait's `SKILL_###_##` key with the prefix
dropped), and that string's `{n}` placeholders index the ten f32 value columns
of `skill_status.tbl` directly. The classification below lists every trait
whose EXPLAIN mentions "DMG Cap" (40 on v2.0.4) with the slot its cap-up
placeholder names. It is a pinned table rather than a live parse so a human
can audit it — but every entry is VALIDATED against the live text at
generation time: the script re-reads each trait's EXPLAIN and fails loudly if
the classified slot no longer matches a `DMG Cap +{slot}` placeholder, if a
conditional marker appears on a trait classified unconditional, or if a trait
mentioning "DMG Cap" is missing from the classification entirely.

skill_status.tbl is parsed raw for the same reason gen-trait-max-levels.py
parses it raw: GBFRDataTools' skill_status.headers predates v2.0.2 and lists
six value columns where the live row has ten. v2.0.4 layout:
  +0x00  10 x f32 per-level effect values
  +0x28  u32 Key hash (the trait id, matches traits.json keys)
  +0x2C  u32 LevelDescription hash
  +0x30  u32 Level

Output shape:
  {
    "traits":            { "<hash8>": [[normal, skill, sba], ...] },  # index = level - 1
    "conditionalTraits": { "<hash8>": [[normal, skill, sba], ...] },
    "conditionalTraitInputs": { "<hash8>": { "<input>": [perLevelValue, ...] } },
    "transcendedTraits": { "<hash8>": [[normal, skill, sba], ...] },
    "overmasteries":     { "<hash8>": "normal" | "skill" | "sba" },
    "summonBonuses":     { "<hash8>": "normal" | "skill" | "sba" }
  }
Trait values are percentages, exactly as the game displays them.
"""

import json
import re
import struct
import sys
from pathlib import Path

import msgpack

ROOT = Path(__file__).resolve().parent.parent

ROW_SIZE = 52
KEY_OFFSET = 0x28
LEVEL_OFFSET = 0x30
INVALID = 0xFFFFFFFF

# Class name -> which of a spec's slots holds it. "all" applies one slot to
# every class.
CLASSES = ("normal", "skill", "sba")

# Unconditional cap traits: hash -> {name, slots}. `slots` maps each attack
# class to the value column the trait's own EXPLAIN placeholder names for it.
UNCONDITIONAL_TRAITS = {
    0xDC584F60: {"name": "DMG Cap", "slots": {"normal": 0, "skill": 1, "sba": 2}},
    0xDBE1D775: {"name": "Alpha", "slots": {"normal": 0}},
    0x8D2ADB6E: {"name": "Beta", "slots": {"skill": 0}},
    0x5C862E13: {"name": "Gamma", "slots": {"all": 0}},
    0xBBD77C33: {"name": "Unbound Strike", "slots": {"normal": 0}},
    0x020DB733: {"name": "Unbound Technique", "slots": {"skill": 0}},
    0x3F682593: {"name": "Unbound Exertion", "slots": {"sba": 0}},
    0x79027FC8: {"name": "Unbound Master", "slots": {"all": 0}},
    0xD029FE08: {"name": "Fatebreaker", "slots": {"all": 2}},
    0xA8A3163B: {"name": "Glass Cannon", "slots": {"all": 1}},
    0x3BFED918: {"name": "Guardian's Conviction", "slots": {"all": 1}},
    0xA374FDF0: {"name": "Helmsman's Tenacity", "slots": {"all": 2}},
    0xE60A735C: {"name": "Lord's Procession", "slots": {"all": 1}},
    0x11AAE5F5: {"name": "Mage's Savvy", "slots": {"all": 0}},
    0x9230E3F5: {"name": "Spirit Edge's Fury", "slots": {"all": 2}},
    0x235D86EF: {"name": "Supernova", "slots": {"all": 1}},
    0xD40D1E9B: {"name": "Supreme Primarch's Awe", "slots": {"all": 0}},
    0x7AD0C010: {"name": "Versalis Ignition", "slots": {"all": 2}},
    0x451D814C: {"name": "Eternal Rage's Ethos", "slots": {"all": 0}},
    0x9ACE140B: {"name": "Bladequeen's Circuit", "slots": {"all": 0}},
    0x36E3848D: {"name": "Celestial Incendo", "slots": {"all": 0}},
    0x9232DC17: {"name": "Celestial Terra", "slots": {"all": 1}},
    # The three boundary weapon traits. Their base block is unconditional; the
    # transcended extra block (slot 6) is emitted into `transcendedTraits`.
    0x1A2EF59E: {"name": "Ain", "slots": {"all": 1}, "transcended": 6},
    0xEF05EC4D: {"name": "Seven-Star Boundary", "slots": {"all": 1}, "transcended": 6},
    0x281214AB: {"name": "Two-Crown Boundary", "slots": {"all": 1}, "transcended": 6},
}

# Conditional cap traits, at the slot holding their MAXIMUM. Kept out of the
# attributed total by the card; see the module docstring.
#
# `inputs` names the OTHER value columns a trait's own EXPLAIN placeholders
# point at — its gate thresholds and its low end. They are in the same ten f32
# columns as the magnitudes, per level, which is what makes a conditional trait
# evaluable at all rather than only showable at its maximum. Names are the
# frontend's (capFactors/traits.ts reads them by name); slots are validated
# against the live text exactly as the value slots are.
CONDITIONAL_TRAITS = {
    # "When at {4} max HP or less" — a FLAT HP threshold (45000 at L25), not a
    # fraction, despite reading like one.
    0x40223C28: {"name": "Catastrophe", "slots": {"all": 1}, "inputs": {"hpAtMost": 4}},
    0x1E1CECCE: {"name": "Catastrophe Nova", "slots": {"all": 1}, "inputs": {"hpAtMost": 4}},
    # "While at {2}% HP or more" — a percentage of max HP (75 at every level).
    0xA7726190: {"name": "Celestial Lumen", "slots": {"all": 1}, "inputs": {"hpPercentAtLeast": 2}},
    0x0DE887A0: {"name": "Celestial Nyx", "slots": {"all": 1}, "inputs": {"hpPercentAtMost": 2}},
    # A band, not a gate: the cap-up ramps from `capMin` at `critMin` crit rate
    # to the emitted maximum at `critMax`.
    0xAEFEB1BC: {
        "name": "DMG Cap Cobalt",
        "slots": {"all": 3},
        "inputs": {"capMin": 2, "critMin": 4, "critMax": 5},
    },
    0x3B71AF12: {
        "name": "DMG Cap Ecru",
        "slots": {"all": 3},
        "inputs": {"capMin": 2, "maxHpMin": 4, "maxHpMax": 5},
    },
    # Stack-gated (Cardinal/Sage I-V). Only the value AT V is in the text, so no
    # per-stack curve is emitted — the frontend reports an intermediate stack as
    # unresolved rather than inventing an interpolation.
    0x0151CF9E: {"name": "DMG Cap Cardinal", "slots": {"all": 6}, "inputs": {}},
    0xFFF8CF64: {"name": "DMG Cap Sage", "slots": {"all": 6}, "inputs": {}},
    0x30773197: {"name": "Enchantress's Rhythm", "slots": {"all": 0}, "inputs": {}},
    0xED8D8AD8: {"name": "The Black's Impulse", "slots": {"all": 1}, "inputs": {}},
    0x46EE3116: {"name": "In a Pinch", "slots": {"all": 3}, "inputs": {}},
    0x51C115D2: {"name": "Super Ultimate Perfect Dodge", "slots": {"all": 0}, "inputs": {}},
    0x461A8E07: {"name": "Ultramarine's Adversity", "slots": {"all": 0}, "inputs": {}},
    # Action-scoped, not class-scoped: per-charge-grade shot caps. Attributing
    # them to every normal hit would overstate, so they stay conditional; the
    # emitted value is the Grade IV (largest) column, with the two lower grades
    # as inputs so the frontend can pick the one the shot actually was.
    0xBE3404B9: {
        "name": "Thunderwolf's Acuity",
        "slots": {"all": 2},
        "inputs": {"gradeII": 0, "gradeIII": 1},
    },
    # "+15% per active pet" — the 15 is literal in the text and the pet count is
    # runtime state. Slot 0 holds a different number, so no slot is emitted; the
    # card names it with no magnitude rather than a wrong one.
    0x7351D602: {"name": "Phantasm's Harmony", "slots": {}, "inputs": {}},
}

# Substrings whose presence marks an EXPLAIN as conditional. Validated both
# ways: a trait in CONDITIONAL_TRAITS must carry one (or be one of the two
# structural exceptions below), and a trait in UNCONDITIONAL_TRAITS must not.
CONDITIONAL_MARKERS = (
    "Min boost",
    "Max boost",
    "When ",
    "Whenever",
    "While at",
    "(At ",
    "a max of",
    "On recovery",
    " sec.",
    "during ",
    "per active",
)
# Conditional for structural reasons the marker scan cannot see: Thunderwolf's
# is scoped to specific charge grades, not to a condition word.
MARKERLESS_CONDITIONALS = {0xBE3404B9}
# The transcendence clause is conditional, but the BASE block of a boundary
# trait applies unconditionally — the marker scan must not flag the whole trait.
TRANSCENDENCE_CLAUSE = "If equipped weapon is transcended"

# Value anchors: (level, class, expected percent). The 238 is ground truth — a
# level-63 DMG Cap reads "DMG Cap +238%" in game.
TRAIT_ANCHORS = {
    0xDC584F60: [(1, "normal", 3.0), (63, "skill", 238.0), (65, "sba", 250.0)],
    0xD029FE08: [(15, "normal", 50.0)],
    0x020DB733: [(15, "skill", 30.0)],
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


def read_explains(msg_path: Path) -> dict[int, str]:
    """trait hash -> its EXPLAIN text, for every trait the repo names."""
    doc = msgpack.unpackb(msg_path.read_bytes(), raw=False, strict_map_key=False)
    text = {row["column_"]["id_hash_"]: row["column_"]["text_"] for row in doc["rows_"]}
    traits = json.loads((ROOT / "src-tauri" / "lang" / "en" / "traits.json").read_text(encoding="utf-8"))
    out: dict[int, str] = {}
    for hash_hex, entry in traits.items():
        code = entry["key"].removeprefix("SKILL_")
        explain = text.get(f"TXT_SKILL_EXPLAIN_{code}")
        if explain:
            out[int(hash_hex, 16)] = explain
    return out


def validate_classification(explains: dict[int, str]) -> None:
    """Every classification claim re-checked against the game's own text."""
    classified = UNCONDITIONAL_TRAITS.keys() | CONDITIONAL_TRAITS.keys()
    mentions = {h for h, s in explains.items() if "DMG Cap" in s}
    missing = mentions - classified
    if missing:
        names = ", ".join(f"{h:08x}" for h in sorted(missing))
        sys.exit(f"unclassified DMG Cap traits: {names} — a patch added or reworked traits; classify them")
    gone = classified - explains.keys()
    if gone:
        names = ", ".join(f"{h:08x}" for h in sorted(gone))
        sys.exit(f"classified traits with no EXPLAIN text: {names}")

    for h, spec in {**UNCONDITIONAL_TRAITS, **CONDITIONAL_TRAITS}.items():
        explain = explains[h]
        conditional = h in CONDITIONAL_TRAITS
        # The base text, with the transcendence clause (its own conditional
        # block) cut off so its markers and placeholders don't leak into the
        # unconditional check.
        base_text = explain.split(TRANSCENDENCE_CLAUSE)[0]
        marked = any(marker in base_text for marker in CONDITIONAL_MARKERS)
        if conditional and not marked and h not in MARKERLESS_CONDITIONALS:
            sys.exit(f"{spec['name']} ({h:08x}) is classified conditional but its text carries no marker: {explain!r}")
        if not conditional and marked:
            sys.exit(f"{spec['name']} ({h:08x}) is classified unconditional but its text reads conditional: {explain!r}")
        # Each mapped slot must be named by a cap placeholder in the text.
        for cls, slot in spec["slots"].items():
            pattern = rf"DMG Cap( by a max of)? ?↑? ?\+?\(?{{{slot}[:}}]"
            if not re.search(pattern, explain, re.IGNORECASE):
                sys.exit(
                    f"{spec['name']} ({h:08x}) claims {cls} cap in slot {slot}, "
                    f"but the text names no such placeholder: {explain!r}"
                )
        # Gate columns are placeholders in the same text, and a moved column is
        # exactly as silent as a moved value column — check them the same way.
        for name, slot in spec.get("inputs", {}).items():
            if not re.search(rf"{{{slot}[:}}]", explain):
                sys.exit(
                    f"{spec['name']} ({h:08x}) claims input {name!r} in slot {slot}, "
                    f"but the text names no such placeholder: {explain!r}"
                )
        transcended = spec.get("transcended")
        if transcended is not None:
            clause = explain.partition(TRANSCENDENCE_CLAUSE)[2]
            if not re.search(rf"DMG Cap \+{{{transcended}[:}}]", clause):
                sys.exit(f"{spec['name']} ({h:08x}): no transcended cap placeholder {{{transcended}}}: {explain!r}")


def read_value_rows(tbl_path: Path) -> dict[int, dict[int, tuple]]:
    """trait hash -> level -> the ten f32 value columns."""
    data = tbl_path.read_bytes()
    row_count = struct.unpack_from("<q", data, 0)[0]
    if 8 + row_count * ROW_SIZE != len(data):
        sys.exit(f"skill_status.tbl row size is no longer {ROW_SIZE} — re-derive the offsets")
    by_trait: dict[int, dict[int, tuple]] = {}
    for i in range(row_count):
        offset = 8 + i * ROW_SIZE
        key = struct.unpack_from("<I", data, offset + KEY_OFFSET)[0]
        if key == INVALID:
            continue
        level = struct.unpack_from("<I", data, offset + LEVEL_OFFSET)[0]
        by_trait.setdefault(key, {})[level] = struct.unpack_from("<10f", data, offset)
    return by_trait


def per_level_values(spec: dict, levels: dict[int, tuple], slot_key: str | None = None) -> list[list[float]]:
    """[[normal, skill, sba], ...] per level, from the spec's slot map."""
    slots = spec["slots"] if slot_key is None else {"all": spec[slot_key]}
    top = max(levels)
    missing = [level for level in range(1, top + 1) if level not in levels]
    if missing:
        sys.exit(f"{spec['name']} is missing levels {missing} — the Level column moved")
    out = []
    for level in range(1, top + 1):
        row = levels[level]
        per_class = []
        for cls in CLASSES:
            slot = slots.get(cls, slots.get("all"))
            per_class.append(row[slot] if slot is not None else 0.0)
        out.append(per_class)
    return out


def input_values(spec: dict, levels: dict[int, tuple]) -> dict[str, list[float]]:
    """{input name: [value per level]} — a conditional trait's gate columns."""
    top = max(levels)
    return {name: [levels[level][slot] for level in range(1, top + 1)] for name, slot in spec["inputs"].items()}


def trait_values(by_trait: dict[int, dict[int, tuple]]) -> dict[str, dict]:
    """The per-level trait maps: unconditional, conditional, transcended, and
    the conditional traits' gate inputs."""
    out: dict[str, dict] = {
        "traits": {},
        "conditionalTraits": {},
        "transcendedTraits": {},
        "conditionalTraitInputs": {},
    }
    for family, table in (("traits", UNCONDITIONAL_TRAITS), ("conditionalTraits", CONDITIONAL_TRAITS)):
        for h, spec in table.items():
            levels = by_trait.get(h)
            if not levels:
                sys.exit(f"{spec['name']} ({h:08x}) has no rows in skill_status.tbl — the Key column moved")
            if spec.get("inputs"):
                out["conditionalTraitInputs"][f"{h:08x}"] = input_values(spec, levels)
            if not spec["slots"]:
                continue  # Phantasm's Harmony: magnitude is not in the table
            out[family][f"{h:08x}"] = per_level_values(spec, levels)
            if "transcended" in spec:
                out["transcendedTraits"][f"{h:08x}"] = per_level_values(spec, levels, "transcended")
    for h, anchors in TRAIT_ANCHORS.items():
        emitted = out["traits"][f"{h:08x}"]
        for level, cls, expected in anchors:
            actual = emitted[level - 1][CLASSES.index(cls)]
            if actual != expected:
                name = UNCONDITIONAL_TRAITS[h]["name"]
                sys.exit(f"{name} L{level} {cls} reads {actual}, expected {expected} — columns moved")
    return out


def class_map(lang_file: str, anchors: dict[str, str]) -> dict[str, str]:
    """id -> attack class, for every id the English table names as a damage cap up."""
    table = json.loads((ROOT / "src-tauri" / "lang" / lang_file).read_text(encoding="utf-8"))
    out = {key: CLASS_BY_NAME[entry["text"]] for key, entry in table.items() if entry.get("text") in CLASS_BY_NAME}
    for anchor, expected in anchors.items():
        if out.get(anchor) != expected:
            sys.exit(f"{lang_file}: anchor {anchor} maps to {out.get(anchor)}, expected {expected}")
    return out


def main() -> None:
    table_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if table_dir is None or not (table_dir / "skill_status.tbl").exists():
        sys.exit("usage: gen-cap-up-sources.py <dir with skill_status.tbl and text/en/text.msg>")

    explains = read_explains(table_dir / "text" / "en" / "text.msg")
    validate_classification(explains)

    out = {
        **trait_values(read_value_rows(table_dir / "skill_status.tbl")),
        "overmasteries": class_map("en/overmasteries.json", OVERMASTERY_ANCHORS),
        "summonBonuses": class_map("en/summon-bonuses.json", SUMMON_BONUS_ANCHORS),
    }

    out_path = ROOT / "src" / "assets" / "cap-up-sources.json"
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"{len(out['traits'])} traits, {len(out['conditionalTraits'])} conditional "
        f"({len(out['conditionalTraitInputs'])} with gate inputs), "
        f"{len(out['transcendedTraits'])} transcended, {len(out['overmasteries'])} overmasteries, "
        f"{len(out['summonBonuses'])} summon bonuses -> {out_path}"
    )


if __name__ == "__main__":
    main()
