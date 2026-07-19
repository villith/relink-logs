#!/usr/bin/env python3
"""Generates src/assets/trait-max-levels.json — each sigil trait's maximum
effective level — from the game's skill_status.tbl. That table holds one row
per (trait, level) with the level's effect values; a trait's effect stops
scaling past its highest row, so max(Level) per trait is the cap. The Builds
tab uses this to flag combined trait levels above the cap as wasted.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/skill_status.tbl -o <dir>
  2. python scripts/gen-trait-max-levels.py <dir>/system/table/skill_status.tbl

skill_status.tbl is parsed raw because GBFRDataTools' skill_status.headers
predates v2.0.2 (the row grew to 52 bytes). v2.0.2 layout:
  +0x00  10 x f32 per-level effect values (unused here)
  +0x28  u32 Key hash (the trait id, matches traits.json keys)
  +0x2C  u32 level-description hash
  +0x30  u32 level

Output shape: { "<traitHash8>": maxLevel }
"""

import json
import struct
import sys
from pathlib import Path

ROW_SIZE = 52
KEY_OFFSET = 0x28
LEVEL_OFFSET = 0x30
INVALID = 0xFFFFFFFF

# Known trait -> max-level pairs; the parse aborts if any mismatch, which is
# the signal that a game patch moved the columns again.
ANCHORS = {
    0xDC584F60: 65,  # DMG Cap
    0xCEB700EE: 45,  # Stun Power
    0x4C588C27: 15,  # War Elemental
    0x50079A1C: 50,  # ATK
}


def main() -> None:
    tbl_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not tbl_path or not Path(tbl_path).exists():
        sys.exit("usage: gen-trait-max-levels.py <skill_status.tbl> (see module docstring)")

    data = Path(tbl_path).read_bytes()
    row_count = struct.unpack_from("<q", data, 0)[0]
    if 8 + row_count * ROW_SIZE != len(data):
        sys.exit(f"skill_status.tbl row size is no longer {ROW_SIZE} — re-derive the offsets")

    out = {}
    for i in range(row_count):
        offset = 8 + i * ROW_SIZE
        key = struct.unpack_from("<I", data, offset + KEY_OFFSET)[0]
        level = struct.unpack_from("<I", data, offset + LEVEL_OFFSET)[0]
        if key == INVALID:
            continue
        out[f"{key:08x}"] = max(out.get(f"{key:08x}", 0), level)

    for anchor, expected in ANCHORS.items():
        actual = out.get(f"{anchor:08x}")
        if actual != expected:
            sys.exit(f"anchor {anchor:08x} has max level {actual}, expected {expected} — offsets moved")

    out_path = Path(__file__).resolve().parent.parent / "src" / "assets" / "trait-max-levels.json"
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out)} traits -> {out_path}")


if __name__ == "__main__":
    main()
