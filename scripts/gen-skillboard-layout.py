#!/usr/bin/env python3
"""Generate src/assets/skillboard-layout.json from the game's skillboard_layout.tbl.

The master-traits display uses this as the ground truth for which node
(EffectUiId, the id the hook emits per unlocked node) sits in which board tier
— the id value itself does NOT encode the tier, so this cannot be derived from
the ids alone.

Regeneration on a game update (GBFRDataTools = github.com/Nenkai/GBFRDataTools):

    GBFRDataTools.exe extract -i <game>/data.i -f system/table/skillboard_layout.tbl -o <tmp>
    GBFRDataTools.exe tbl-to-sqlite -i <tmp>/system/table -o <tmp>/skillboard.sqlite -v <game-version>
    python scripts/gen-skillboard-layout.py <tmp>/skillboard.sqlite

Output shape: { "pl####": { "1": [ids], "2": [ids], "3": [ids], "ex": [ids] } }.
"""

import json
import sqlite3
import sys
from pathlib import Path

OUT_PATH = Path(__file__).resolve().parent.parent / "src" / "assets" / "skillboard-layout.json"

TIER_BY_GROUP = {"CHAOS1": "1", "CHAOS2": "2", "CHAOS3": "3", "EX": "ex"}


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <skillboard_layout sqlite db>")

    db = sqlite3.connect(sys.argv[1])
    out: dict[str, dict[str, list[int]]] = {}
    unknown_groups: set[str] = set()
    # Unk25=100 marks the per-category keystone/special nodes (3 categories x
    # Chaos 1-3, ids = category*100 + tier-1). The in-game boards do NOT list
    # them as tier traits, so they are excluded here; when the hook emits one
    # as unlocked, the frontend's id-band fallback still places it correctly.
    for character, group, ui_id in db.execute(
        "SELECT CharacterId, SkillboardGroupId, EffectUiId FROM skillboard_layout WHERE Unk25 != 100"
    ):
        tier = TIER_BY_GROUP.get(group)
        if tier is None:
            unknown_groups.add(group)
            continue
        out.setdefault(character.lower(), {}).setdefault(tier, []).append(ui_id)

    for board in out.values():
        for ids in board.values():
            ids.sort()

    if unknown_groups:
        print(f"WARN: skipped unknown SkillboardGroupId values: {sorted(unknown_groups)}")

    OUT_PATH.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    total = sum(len(ids) for board in out.values() for ids in board.values())
    print(f"wrote {total} nodes across {len(out)} characters to {OUT_PATH}")


if __name__ == "__main__":
    main()
