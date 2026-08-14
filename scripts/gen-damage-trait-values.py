#!/usr/bin/env python3
"""Generates src/assets/damage-trait-values.json — per-level values for the
damage-formula traits the debug tab's damage-calculation panel cites.

Unlike gen-cap-up-sources.py (which classifies traits by their EXPLAIN text),
the trait set and each trait's value column here are PINNED FROM THE DECOMPILE
of the damage builder / PDE (v2.0.4, gbfr204fast; see the damage-head handoff).
The proven convention `fld+8 = {0}` maps decompiled field reads to display
placeholders, and placeholder {n} is column n of skill_status.tbl's ten f32
value columns. Text-bearing traits are still validated fail-loud against their
EXPLAIN placeholders; textless internal traits are pinned by SKILL key
(recovered by hash preimage) and exempt.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/skill_status.tbl -o <dir>
     GBFRDataTools extract -i <data.i> -f system/table/text/en/text.msg -o <dir>
  2. python scripts/gen-damage-trait-values.py <dir>/system/table

Output shape:
  {
    "version": "2.0.4",
    "traits": {
      "<hash8>": {
        "key": "SKILL_###_##",
        "name": "<display name or SKILL key>",
        "textless": true?,            # only on the internal traits
        "values": { "<label>": [perLevelValue, ...] }   # index = level - 1
      }
    }
  }
Values are percentages exactly as the game tables ship them.
"""

import json
import re
import struct
import sys
from pathlib import Path

import msgpack

ROOT = Path(__file__).resolve().parent.parent

GAME_VERSION = "2.0.4"
ROW_SIZE = 52
KEY_OFFSET = 0x28
LEVEL_OFFSET = 0x30
INVALID = 0xFFFFFFFF

# tag -> {slots: {label: placeholder column}, key?: pinned SKILL key for
# textless traits}. Provenance of every column is the decompile, via
# fld+8={0}, +0xC={1}, +0x10={2}, +0x14={3}.
TRAITS = {
    # Attack chain (FUN_141f43670), class_flags / flags gates.
    0x1C360C63: {"slots": {"value": 0}},  # Charged Attack DMG
    0x8D078597: {"slots": {"value": 0}},  # Throw DMG
    0xEAE321EB: {"slots": {"value": 0}},  # Skilled Assault
    0x3FEC5F80: {"slots": {"link": 0, "sba": 2}},  # Linked Together
    0xA7A45F28: {"slots": {"value": 0}},  # Combo Finisher DMG
    0xB360801D: {"slots": {"value": 0}},  # Concentrated Fire
    0x6B694D6D: {"slots": {"weakpoint": 0, "backattack": 1}},  # Weak Point DMG
    0x54401E12: {"slots": {"value": 0}, "key": "SKILL_015_00"},  # vulnerable-window x(1.2+t%)
    # Additive group.
    0x8F502F0D: {"slots": {"value": 0}},  # Life on the Line
    0x84078CB0: {"slots": {"value": 1}},  # Quick Charge (ATK is {1})
    0xDC225C96: {"slots": {"value": 1}},  # Power Hungry (ATK is {1})
    0x82CE278D: {"slots": {"tier0": 3, "tier1": 2, "tier2": 1, "tier3": 0}},  # Less Is More
    0x1568E0E4: {"slots": {"value": 0}},  # Head Start
    0xAEFEB1BC: {"slots": {"atkLow": 0, "atkHigh": 1, "rateMin": 4, "rateMax": 5}},  # DMG Cap Cobalt ATK ramp
    # HP-curve product traits.
    0x2FC8FBFF: {"slots": {"value": 0}},  # Stamina
    0x3F488339: {"slots": {"value": 0}},  # Enmity
    # Target-state gate bytes.
    0x4F1A3683: {"slots": {"value": 0}},  # Injury to Insult
    0xA9D17F55: {"slots": {"value": 0}},  # Overdrive Assassin
    0xAC9674C1: {"slots": {"value": 0}},  # Break Assassin
    # Crit.
    0xC0979A17: {"slots": {"value": 0}},  # Critical Hit DMG
    0xC35B111B: {"slots": {"value": 0}},  # Lucky Charge (crit RATE, charged)
    0x4B400B01: {"slots": {"value": 0}, "key": "SKILL_099_00"},  # back-attack crit rate
    # Roll of the Die: cumulative band percents for x4 / x3 / x2 / dmg=1.
    # bands live in record fields +8..+0x14 (decompile-pinned); display text has no {n} placeholders
    0x333E5862: {"slots": {"band4x": 0, "band3x": 1, "band2x": 2, "band1": 3}, "noExplain": True},
    # Celestial ATK halves (HP-gated) — gate threshold is {2}.
    0xA7726190: {"slots": {"value": 0, "hpGate": 2}},  # Celestial Lumen (HP >= gate)
    0x0DE887A0: {"slots": {"value": 0, "hpGate": 2}},  # Celestial Nyx (HP <= gate)
    # Post-cap amplify.
    0x73220725: {"slots": {"value": 0}},  # Celestial Ventus
    0xA898E283: {"slots": {"value": 0}},  # Celestial Aqua
    0x90F61DC3: {"slots": {"value": 0}, "key": "SKILL_168_00"},  # textless amplify
    # Target-side (players taking hits) — cited by the taken-side section only.
    0xE6CDBA9C: {"slots": {"value": 0}},  # Garrison
    0x74AA75D6: {"slots": {"value": 0}},  # Stronghold
    0x1470F860: {"slots": {"value": 0}},  # Steel Nerves
    0x0053599E: {"slots": {"value": 1}},  # Steady Focus
    0xBEB4D1E9: {"slots": {"value": 0}, "key": "SKILL_035_00"},  # generic DMG-taken-down
    0xFE02D02F: {"slots": {"value": 0}, "key": "SKILL_026_00"},  # taken slice additive
    # Per-element resistance block (DAT_1459b0bd0, attack element 1..6).
    0x06F7CEDE: {"slots": {"value": 0}, "key": "SKILL_037_00"},
    0x709B29B6: {"slots": {"value": 0}, "key": "SKILL_038_00"},
    0xF8F6FD8E: {"slots": {"value": 0}, "key": "SKILL_039_00"},
    0xE338C0E0: {"slots": {"value": 0}, "key": "SKILL_040_00"},
    0x687202B5: {"slots": {"value": 0}, "key": "SKILL_041_00"},
    0xD5A33083: {"slots": {"value": 0}, "key": "SKILL_042_00"},
}


def load_traits_json() -> dict[str, dict]:
    return json.loads((ROOT / "src-tauri" / "lang" / "en" / "traits.json").read_text(encoding="utf-8"))


def read_explains(msg_path: Path, traits_json: dict[str, dict]) -> dict[int, str]:
    """trait hash -> EXPLAIN text, for every trait traits.json names."""
    doc = msgpack.unpackb(msg_path.read_bytes(), raw=False, strict_map_key=False)
    text = {row["column_"]["id_hash_"]: row["column_"]["text_"] for row in doc["rows_"]}
    out: dict[int, str] = {}
    for hash_hex, entry in traits_json.items():
        code = entry["key"].removeprefix("SKILL_")
        explain = text.get(f"TXT_SKILL_EXPLAIN_{code}")
        if explain:
            out[int(hash_hex, 16)] = explain
    return out


def validate(explains: dict[int, str], traits_json: dict[str, dict]) -> None:
    for h, spec in TRAITS.items():
        hex8 = f"{h:08x}"
        pinned_key = spec.get("key")
        in_json = hex8 in traits_json
        if pinned_key is not None and in_json:
            sys.exit(f"{hex8} is pinned textless but traits.json now names it — drop the pin")
        if pinned_key is None and not in_json:
            sys.exit(f"{hex8} has no traits.json entry and no pinned key — pin its SKILL key")
        if pinned_key is None and not spec.get("noExplain"):
            explain = explains.get(h)
            if not explain:
                sys.exit(f"{hex8} ({traits_json[hex8]['key']}) has no EXPLAIN text")
            for label, col in spec["slots"].items():
                if not re.search(rf"{{{col}[:}}]", explain):
                    sys.exit(
                        f"{hex8} claims {label!r} in column {col}, "
                        f"but its text names no {{{col}}} placeholder: {explain!r}"
                    )


def read_value_rows(tbl_path: Path) -> dict[int, dict[int, tuple]]:
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


def emit(by_trait: dict[int, dict[int, tuple]], traits_json: dict[str, dict]) -> dict:
    out: dict[str, dict] = {}
    for h, spec in TRAITS.items():
        hex8 = f"{h:08x}"
        levels = by_trait.get(h)
        if not levels:
            sys.exit(f"{hex8} has no rows in skill_status.tbl — the Key column moved or the trait is gone")
        top = max(levels)
        missing = [level for level in range(1, top + 1) if level not in levels]
        if missing:
            sys.exit(f"{hex8} is missing levels {missing} — the Level column moved")
        json_entry = traits_json.get(hex8)
        entry: dict = {
            "key": spec.get("key") or json_entry["key"],
            "name": (json_entry or {}).get("text") or spec.get("key"),
            "values": {
                label: [levels[level][col] for level in range(1, top + 1)]
                for label, col in spec["slots"].items()
            },
        }
        if spec.get("key") is not None:
            entry["textless"] = True
        out[hex8] = entry
    return {"version": GAME_VERSION, "traits": out}


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: gen-damage-trait-values.py <dir>/system/table")
    table_dir = Path(sys.argv[1])
    traits_json = load_traits_json()
    explains = read_explains(table_dir / "text" / "en" / "text.msg", traits_json)
    validate(explains, traits_json)
    by_trait = read_value_rows(table_dir / "skill_status.tbl")
    out = emit(by_trait, traits_json)
    out_path = ROOT / "src" / "assets" / "damage-trait-values.json"
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {out_path} ({len(out['traits'])} traits)")


if __name__ == "__main__":
    main()
