#!/usr/bin/env python3
"""Generates src/assets/sigil-trait-categories.json — each sigil trait's
in-game type (0 basic / 1 attack / 2 defense / 3 support / 4 other) — from the
game's skill.tbl. The Builds-tab checklist uses this to count Basic/Attack/
Defense-or-Support sigils (a sigil's type is its FIRST trait's type).

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/skill.tbl -o <dir>
  2. python scripts/gen-sigil-trait-categories.py <dir>/system/table/skill.tbl

skill.tbl is parsed raw because GBFRDataTools' skill.headers predates v2.0.2
(the row grew to 112 bytes). Offsets below are for the v2.0.2 layout:
  +0x00  16-byte icon id ("<type+1>_<nn>", e.g. "02_08" for an attack trait)
  +0x44  u32 Key hash (the trait id, matches traits.json keys)
  +0x5C  u32 type category

Output shape: { "<traitHash8>": 0..4 }
"""

import json
import struct
import sys
from pathlib import Path

ROW_SIZE = 112
KEY_OFFSET = 0x44
CATEGORY_OFFSET = 0x5C
INVALID = 0xFFFFFFFF

# Known trait -> category pairs; the parse aborts if any mismatch, which is
# the signal that a game patch moved the columns again.
ANCHORS = {
    0x50079A1C: 0,  # ATK -> basic
    0x4C588C27: 1,  # War Elemental -> attack
    0xE0ABFDFE: 2,  # Aegis -> defense
    0xB5FF9FD3: 3,  # Uplift -> support
    0xE69A4694: 4,  # Guts -> other
}


def main() -> None:
    tbl_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not tbl_path or not Path(tbl_path).exists():
        sys.exit("usage: gen-sigil-trait-categories.py <skill.tbl> (see module docstring)")

    data = Path(tbl_path).read_bytes()
    row_count = struct.unpack_from("<q", data, 0)[0]
    if 8 + row_count * ROW_SIZE != len(data):
        sys.exit(f"skill.tbl row size is no longer {ROW_SIZE} — re-derive the offsets")

    out = {}
    for i in range(row_count):
        offset = 8 + i * ROW_SIZE
        key = struct.unpack_from("<I", data, offset + KEY_OFFSET)[0]
        category = struct.unpack_from("<I", data, offset + CATEGORY_OFFSET)[0]
        if key == INVALID or category > 4:
            continue
        out[f"{key:08x}"] = category

    for anchor, expected in ANCHORS.items():
        actual = out.get(f"{anchor:08x}")
        if actual != expected:
            sys.exit(f"anchor {anchor:08x} has category {actual}, expected {expected} — offsets moved")

    out_path = Path(__file__).resolve().parent.parent / "src" / "assets" / "sigil-trait-categories.json"
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out)} traits -> {out_path}")


if __name__ == "__main__":
    main()
