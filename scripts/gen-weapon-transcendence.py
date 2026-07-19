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
import sqlite3
import sys
from pathlib import Path

from gbfr_hash import cell_hash


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
