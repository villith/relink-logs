#!/usr/bin/env python3
"""Generates the Synthesis Helper's exclusion assets from the game's gem.tbl:

- src-tauri/assets/synthesis-excluded-sigils.json — item ids of sigils the
  game refuses as Sigil Synthesis material: the "special" sigils (character
  sigils like the Warpath/Awakening lines, and single-trait uniques like War
  Elemental or Auto Potion) that never appear in the game's synthesis
  material list even at trait level 11+. The backend search pool drops them.
- src/assets/synthesis-traits.json — the trait ids that appear on at least
  one synthesizable sigil: the only possible synthesis inputs/results. The
  trait dropdowns show ONLY these. An allow-list (not a special-trait block-
  list) because traits.json also carries ids that exist on no sigil at all —
  weapon traits (Unbound/Catastrophe/DMG Cap color lines, Supplements,
  Supernova...) and display-only duplicates (Crabvestment Returns' visible
  trait id differs from the one on its gem row).

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/gem.tbl -o <dir>
  2. python scripts/gen-synthesis-excluded-sigils.py <dir>/system/table/gem.tbl

gem.tbl is parsed raw because GBFRDataTools' gem.headers predates v2.0.2
(the columns no longer line up). Offsets below are for the v2.0.2 layout
(64-byte rows):
  +0x00  u32 trait 1 hash (matches traits.json keys; 0x887AE0B0 = empty)
  +0x04  u32 trait 2 hash (special sigils always have the empty sentinel —
         their random second trait comes from a lot table, not this column)
  +0x08  u32 Key hash (the sigil item id, matches sigils.json keys)
  +0x38  u8  "special" flag — 1 on exactly the sigils synthesis rejects

Output shape (both files): [ "<hash8>", ... ] (sorted)
"""

import json
import struct
import sys
from pathlib import Path

ROW_SIZE = 64
TRAIT1_OFFSET = 0x00
TRAIT2_OFFSET = 0x04
KEY_OFFSET = 0x08
SPECIAL_OFFSET = 0x38
INVALID = 0xFFFFFFFF
EMPTY_TRAIT = 0x887AE0B0

# Known sigil -> flag pairs; the parse aborts if any mismatch, which is the
# signal that a game patch moved the columns again.
ANCHORS = {
    0xDA9136A1: 1,  # War Elemental -> special
    0x936DFE00: 1,  # Fearless Spirit -> special
    0x0EE1E9D7: 1,  # Roll of the Die -> special
    0x42BB0C1C: 0,  # Supplementary Damage V -> synthesizable
    0xEE732781: 0,  # Damage Cap V -> synthesizable
}

# Known trait -> allowed pairs, same abort-on-mismatch contract.
TRAIT_ANCHORS = {
    0x50079A1C: True,  # ATK -> on normal sigils
    0xDC584F60: True,  # DMG Cap -> on normal sigils
    0x4C588C27: False,  # War Elemental (the trait) -> only on special sigils
    0xDBE1D775: False,  # Alpha -> only on special sigils
    0xBBD77C33: False,  # Unbound Strike -> weapon trait, on no sigil
    0xD461ECFB: False,  # Crabvestment Returns -> its gem row uses another id
}


def main() -> None:
    tbl_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not tbl_path or not Path(tbl_path).exists():
        sys.exit("usage: gen-synthesis-excluded-sigils.py <gem.tbl> (see module docstring)")

    data = Path(tbl_path).read_bytes()
    row_count = struct.unpack_from("<q", data, 0)[0]
    if 8 + row_count * ROW_SIZE != len(data):
        sys.exit(f"gem.tbl row size is no longer {ROW_SIZE} — re-derive the offsets")

    flags = {}
    special_traits, normal_traits = set(), set()
    for i in range(row_count):
        offset = 8 + i * ROW_SIZE
        key = struct.unpack_from("<I", data, offset + KEY_OFFSET)[0]
        if key == INVALID:
            continue
        special = data[offset + SPECIAL_OFFSET]
        flags[key] = special
        for trait_offset in (TRAIT1_OFFSET, TRAIT2_OFFSET):
            trait = struct.unpack_from("<I", data, offset + trait_offset)[0]
            if trait not in (INVALID, EMPTY_TRAIT):
                (special_traits if special == 1 else normal_traits).add(trait)

    for anchor, expected in ANCHORS.items():
        actual = flags.get(anchor)
        if actual != expected:
            sys.exit(f"anchor {anchor:08x} has flag {actual}, expected {expected} — offsets moved")

    for anchor, expected in TRAIT_ANCHORS.items():
        actual = anchor in normal_traits
        if actual != expected:
            sys.exit(f"trait anchor {anchor:08x} allowed={actual}, expected {expected} — offsets moved")

    root = Path(__file__).resolve().parent.parent
    out = sorted(f"{key:08x}" for key, special in flags.items() if special == 1)
    out_path = root / "src-tauri" / "assets" / "synthesis-excluded-sigils.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"{len(out)} excluded sigils -> {out_path}")

    traits_out = sorted(f"{trait:08x}" for trait in normal_traits)
    traits_path = root / "src" / "assets" / "synthesis-traits.json"
    traits_path.write_text(json.dumps(traits_out, indent=2) + "\n", encoding="utf-8")
    print(f"{len(traits_out)} synthesizable traits -> {traits_path}")


if __name__ == "__main__":
    main()
