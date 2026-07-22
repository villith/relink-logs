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
import re
import sqlite3
import sys
from pathlib import Path

from gbfr_hash import cell_hash, game_xxhash32

# WEP_PL####_NN with an optional _MM ascension-variant suffix; group 1 is the
# weapon family shared by all of its variant rows.
FAMILY_RE = re.compile(r"^(WEP_PL\d{4}_\w{2})(?:_\d{2})?$")


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
    names = {}  # weapon-key hash -> resolved Key string (raw-hex cells excluded)
    row_hashes = set()
    for row in con.execute("SELECT * FROM weapon"):
        weapon_key = cell_hash(row["Key"])
        if weapon_key is None:
            continue
        row_hashes.add(weapon_key)
        if FAMILY_RE.match(row["Key"] or ""):
            names[weapon_key] = row["Key"]
        slots = []
        for i in range(1, 6):
            curve = curves.get(cell_hash(row[f"WeaponSkillLevelRebuildId{i}"]) or -1)
            if curve and any(curve["levels"]):
                slots.append(curve)
        if slots:
            out[f"{weapon_key:08x}"] = slots

    # The hook can report a weapon under a PRE-ascension variant row id (a
    # stale record read: e.g. WEP_PL2700_06_02 for a weapon whose true form is
    # _06_03), but the tbl attaches transcendence curves only to the final
    # variant — which killed the frontend's stage derivation for those reads.
    # The live innate LEVELS identify the stage on their own, so share each
    # family's single curve set with its curve-less sibling rows.
    #
    # Some rows' Key cells are unresolved raw hex (entire families can be,
    # e.g. every WEP_PL2700_06* row); recover their names by hashing every
    # plausible key (character x weapon-slot x ascension variant).
    weapon_slots = [f"{i:02d}" for i in range(10)] + [f"{c}{i}" for c in "AB" for i in range(10)]
    for char in range(100):
        for slot in weapon_slots:
            base = f"WEP_PL{char * 100:04d}_{slot}"
            for candidate in [base] + [f"{base}_{mm:02d}" for mm in range(10)]:
                candidate_hash = game_xxhash32(candidate.encode("ascii"))
                if candidate_hash in row_hashes and candidate_hash not in names:
                    names[candidate_hash] = candidate

    families = {}
    for weapon_hash, name in names.items():
        families.setdefault(FAMILY_RE.match(name).group(1), set()).add(weapon_hash)

    propagated = 0
    for members in families.values():
        holders = {f"{h:08x}" for h in members} & out.keys()
        if len(holders) != 1:
            continue
        slots = out[next(iter(holders))]
        for member in members:
            key = f"{member:08x}"
            if key not in out:
                out[key] = slots
                propagated += 1

    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(out)} weapons ({propagated} via family sharing) -> {out_path}")


if __name__ == "__main__":
    main()
