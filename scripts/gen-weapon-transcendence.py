#!/usr/bin/env python3
"""Generates src/assets/weapon-transcendence.json — each weapon's transcendence
("rebuild"/"Transcension") innate-skill level curves — from the game's
weapon.tbl and weapon_skill_level_rebuild.tbl.

The frontend derives a weapon's transcendence stage by locating the LIVE
innate skill level (hook-read from the player record) inside these curves:
each curve lists the skill's level per transcendence stage, right-aligned to
the 10-stage display scale (a curve whose last defined value sits at index 7
covers display stages 3..10). Verified 2026-07-18 against four stage-9/10
dragon-series weapons: every skill's live level lands on display stage 9.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/weapon.tbl -o <dir>
     GBFRDataTools extract -i <data.i> -f system/table/weapon_skill_level_rebuild.tbl -o <dir>
  2. GBFRDataTools tbl-to-sqlite -i <dir>/system/table -v 2.0.2
  3. python scripts/gen-weapon-transcendence.py <dir>/system/db.sqlite

Output shape (keys are the game's custom-XXHash32 of the id strings, matching
the weapons.json / traits.json map keys):
  { "<weaponKeyHash8>": [ {"id": "<skillHash8>", "levels": [11 ints]}, ... ] }
"""

import json
import struct
import sqlite3
import sys
from pathlib import Path

PRIME32_1 = 0x9E3779B1
PRIME32_2 = 0x85EBCA77
PRIME32_3 = 0xC2B2AE3D
PRIME32_4 = 0x27D4EB2F
PRIME32_5 = 0x165667B1
M32 = 0xFFFFFFFF


def rotl(x, r):
    return ((x << r) | (x >> (32 - r))) & M32


def game_xxhash32(data: bytes) -> int:
    """The game's custom XXHash32 (seed 0x178A54A4, hardcoded lane seeds, and
    a `> 16`-not-`>= 16` inner loop — faithful port of GBFRDataTools'
    XXHash32Custom)."""
    p = 0
    n = len(data)
    h32 = 0x178A54A4
    if n >= 16:
        v1, v2, v3, v4 = 0x2557311B, 0x871FB76A, 0x0133ECF3, 0x62FC7342
        while True:
            for i, v in enumerate((v1, v2, v3, v4)):
                lane = struct.unpack_from("<I", data, p + i * 4)[0]
                v = rotl((v + lane * PRIME32_2) & M32, 13) * PRIME32_1 & M32
                if i == 0:
                    v1 = v
                elif i == 1:
                    v2 = v
                elif i == 2:
                    v3 = v
                else:
                    v4 = v
            p += 16
            if n - p <= 16:
                break
        h32 = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M32
    h32 = (h32 + n) & M32
    while n - p >= 4:
        h32 = rotl((h32 + struct.unpack_from("<I", data, p)[0] * PRIME32_3) & M32, 17) * PRIME32_4 & M32
        p += 4
    while p < n:
        h32 = rotl((h32 + data[p] * PRIME32_5) & M32, 11) * PRIME32_1 & M32
        p += 1
    h32 ^= h32 >> 15
    h32 = h32 * PRIME32_2 & M32
    h32 ^= h32 >> 13
    h32 = h32 * PRIME32_3 & M32
    h32 ^= h32 >> 16
    return h32


def cell_hash(value) -> int | None:
    """A hash_string sqlite cell is either the resolved id string or 8 raw hex
    chars; empty/None means no value."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        if len(value) == 8:
            try:
                return int(value, 16)
            except ValueError:
                pass
        return game_xxhash32(value.encode("ascii"))
    return int(value) & M32


def main() -> None:
    db_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not db_path or not Path(db_path).exists():
        sys.exit("usage: gen-weapon-transcendence.py <db.sqlite> (see module docstring)")

    out_path = Path(__file__).resolve().parent.parent / "src" / "assets" / "weapon-transcendence.json"
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    # weapon_skill_level_rebuild: 11 per-stage level columns (community header
    # names are partly wrong — Transcension0..5, Unk7, Transcension6, Unk9,
    # Unk10, Transcension7 ARE the 11 stage slots, in physical order), then
    # the skill id string and the row key the weapon.tbl references.
    curves = {}
    for row in con.execute("SELECT * FROM weapon_skill_level_rebuild"):
        key = cell_hash(row[12])
        if key is None:
            continue
        skill = cell_hash(row[11])
        curves[key] = {
            "id": f"{skill:08x}" if skill is not None else None,
            "levels": [row[i] or 0 for i in range(11)],
        }

    out = {}
    for row in con.execute("SELECT * FROM weapon"):
        weapon_key = cell_hash(row["Key"])
        if weapon_key is None:
            continue
        slots = []
        for i in range(1, 6):
            curve = curves.get(cell_hash(row[f"WeaponSkillLevelRebuildId{i}"]) or -1)
            if curve and any(curve["levels"]):
                slots.append(curve)
        if slots:
            out[f"{weapon_key:08x}"] = slots

    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out)} weapons -> {out_path}")


if __name__ == "__main__":
    main()
