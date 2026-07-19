#!/usr/bin/env python3
"""Generates src/assets/weapon-traits.json — each weapon's innate weapon-skill
(trait) list with per-uncap/awakening level tables — from the game's weapon.tbl
and weapon_skill_level.tbl.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/weapon.tbl -o <dir>
     GBFRDataTools extract -i <data.i> -f system/table/weapon_skill_level.tbl -o <dir>
  2. GBFRDataTools tbl-to-sqlite -i <dir>/system/table -v 2.0.2
  3. python scripts/gen-weapon-traits.py <dir>/system/db.sqlite

Output shape (keys are the game's custom-XXHash32 of the id strings, matching
the weapons.json / traits.json map keys):
  { "<weaponKeyHash8>": [ {"id": "<traitHash8>", "uncap": [7 ints],
                           "awakening": [4 ints], "isAwakening": bool}, ... ] }
"""

import json
import sqlite3
import sys
from pathlib import Path

from gbfr_hash import cell_hash


def main() -> None:
    db_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not db_path or not Path(db_path).exists():
        sys.exit("usage: gen-weapon-traits.py <db.sqlite> (see module docstring)")

    out_path = Path(__file__).resolve().parent.parent / "src" / "assets" / "weapon-traits.json"
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    levels = {}
    for row in con.execute("SELECT * FROM weapon_skill_level"):
        key = cell_hash(row["Key"])
        if key is None:
            continue
        levels[key] = {
            "uncap": [row[f"SkillLevelUncap{i}"] or 0 for i in range(7)],
            "awakening": [row[f"SkillLevelAwakening{i}"] or 0 for i in range(4)],
        }

    slots = [(f"WeaponSkillId{i}", f"WeaponSkillLevelId{i}", False) for i in range(1, 5)] + [
        (f"WeaponSkillId{i}ForAwakening", f"WeaponSkillLevelId{i}ForAwakening", True) for i in range(5, 9)
    ]

    out = {}
    for row in con.execute("SELECT * FROM weapon"):
        weapon_key = cell_hash(row["Key"])
        if weapon_key is None:
            continue
        traits = []
        for skill_col, level_col, is_awakening in slots:
            trait = cell_hash(row[skill_col])
            if trait is None:
                continue
            level = levels.get(cell_hash(row[level_col]) or -1, {})
            traits.append(
                {
                    "id": f"{trait:08x}",
                    "uncap": level.get("uncap", []),
                    "awakening": level.get("awakening", []),
                    "isAwakening": is_awakening,
                }
            )
        if traits:
            out[f"{weapon_key:08x}"] = traits

    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out)} weapons -> {out_path}")


if __name__ == "__main__":
    main()
