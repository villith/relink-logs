#!/usr/bin/env python3
"""Generate src-tauri/assets/transmarvel-tables.json from the game's gacha
tables.

Feeds the Toolbox transmarvel-roll predictor (src-tauri/src/transmarvel/):
the transmarvel roll (ui::fsm::action::GemGacha exec, FUN_141bb6610 v2.0.2)
is a pure function of these tables plus RNG slot 4's state, so the tables
are baked at build time and only the RNG state is read from the live game.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/gacha.tbl -o <dir>
     (same for gacha_rate_group.tbl, gacha_lot.tbl, skill_type_lot.tbl,
      skill_lot.tbl; gem.tbl is extracted too but parsed RAW below — the
      sqlite converter misaligns its v2.0.2 columns)
  2. GBFRDataTools tbl-to-sqlite -i <dir>/system/table -v 2.0.2
  3. python scripts/gen-transmarvel-tables.py <dir>/system/db.sqlite
     (expects gem.tbl at <dir>/../table/gem.tbl next to the sqlite input)

Output shape (camelCase, deserialized by transmarvel::TransmarvelTables):
  gemChancePercent / wrightstoneChancePercent — the first draw's split
    (draw % 100 < gemChancePercent -> gem).
  gemGroups / stoneGroups — rate groups IN TABLE ORDER (the roll's
    cumulative weighted pick walks this order; weights sum to 10000), each
    with its lot's items IN TABLE ORDER (same cumulative pick over item
    weights; all 50 for transmarvel = uniform).
  Per item: quest gates (questIdMin/questIdMax, 0 = ungated), the
  endless-Ragnarok-unlock flag, and the gem trait config from gem.tbl:
  trait1/trait2 (fixed skill hashes, 0 = none) and secondTraitLot (the
  skill_type_lot key the grant path rolls the random 2nd trait from;
  -1 = no roll — such grants consume 2 fewer draws).
  skillTypeRows / skillLots — the 2nd-trait roll's tables: type row key ->
  (skillLot, percent) options walked cumulatively by one draw, then one
  draw picks uniformly within the lot (all skill_lot weights are 1).

  GACHA OVERRIDE (live-derived 2026-07-26): plain V+ sigils (the _24s in
  lots 81216A95/9092654F) roll from skill_type_lot 26 in the transmarvel
  path, NOT their gem.tbl value (5) — 3/3 live rolls prove 26 and rule out
  5. Mechanism unknown (the number 26 appears nowhere in their gem.tbl
  rows); revisit if a future roll contradicts.
"""

import json
import sqlite3
import struct
import sys
from pathlib import Path

from gbfr_hash import cell_hash

OUT_PATH = Path(__file__).resolve().parent.parent / "src-tauri" / "assets" / "transmarvel-tables.json"

# gacha.tbl row Key for the transmarvel tier (TXT_YOROZU_FORGING_HIGH).
TRANSMARVEL_KEY = 0xFA21E311

# Plain single-trait V+ lots whose 2nd-trait roll uses row 26 (see docstring).
V_PLUS_LOTS = {0x81216A95, 0x9092654F}
V_PLUS_TYPE_LOT = 26

# gem.tbl raw layout (v2.0.2): 64-byte rows of 16 u32s, first row's item
# hash at file offset 76. Fields used here (verified against live rolls +
# the decompiled grant path FUN_14033dbc0):
#   [0] item id hash   [7] SkillTypeLotIdForRandom2ndSkill (-1 = none)
#   [14] SkillId1 hash [15] SkillId2 hash (0x887ae0b0 = empty)
GEM_ROW_START = 16  # header size; rows are contiguous 64B after it
GEM_ROW_SIZE = 64
EMPTY_KEY = 0x887AE0B0


def load_gem_configs(gem_tbl: Path) -> dict:
    """item hash -> (trait1, trait2, second_trait_lot) from raw gem.tbl."""
    data = gem_tbl.read_bytes()
    out = {}
    for off in range(GEM_ROW_START, len(data) - GEM_ROW_SIZE + 1, GEM_ROW_SIZE):
        row = struct.unpack_from("<16I", data, off)
        trait1 = 0 if row[14] == EMPTY_KEY else row[14]
        trait2 = 0 if row[15] == EMPTY_KEY else row[15]
        lot = row[7] if row[7] != 0xFFFFFFFF else -1
        out[row[0]] = (trait1, trait2, lot)
    return out


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <db.sqlite> (see module docstring)")
    db = sqlite3.connect(sys.argv[1])
    db.row_factory = sqlite3.Row
    gem_configs = load_gem_configs(Path(sys.argv[1]).parent / "table" / "gem.tbl")

    tier = None
    for row in db.execute(
        "SELECT Key, GemChancePercent, WrightstoneChancePercent, "
        "GemRateGroup, WrightstoneRateGroup FROM gacha ORDER BY rowid"
    ):
        if cell_hash(row["Key"]) == TRANSMARVEL_KEY:
            tier = row
    assert tier is not None, "transmarvel gacha row not found"

    items_by_lot = {}
    for row in db.execute(
        "SELECT Key, ItemId, Weight, TraitLevel, QuestIDMin, QuestIDMax, "
        "NeedsEndlessRagnarokToDrop FROM gacha_lot ORDER BY rowid"
    ):
        lot_key = cell_hash(row["Key"])
        item = cell_hash(row["ItemId"])
        trait1, trait2, second_lot = gem_configs.get(item, (0, 0, -1))
        if lot_key in V_PLUS_LOTS:
            second_lot = V_PLUS_TYPE_LOT
        items_by_lot.setdefault(lot_key, []).append(
            {
                "item": item,
                "weight": row["Weight"],
                "traitLevel": row["TraitLevel"],
                "questIdMin": cell_hash(row["QuestIDMin"]) or 0,
                "questIdMax": cell_hash(row["QuestIDMax"]) or 0,
                "needsEndlessRagnarok": bool(row["NeedsEndlessRagnarokToDrop"]),
                "trait1": trait1,
                "trait2": trait2,
                "secondTraitLot": second_lot,
            }
        )

    def groups(rate_group_cell: str) -> list:
        key = cell_hash(rate_group_cell)
        out = []
        for row in db.execute(
            "SELECT Key, GachaLotId, Weight FROM gacha_rate_group ORDER BY rowid"
        ):
            if cell_hash(row["Key"]) != key:
                continue
            lot = cell_hash(row["GachaLotId"])
            assert lot in items_by_lot, f"rate group references unknown lot {lot:08x}"
            out.append({"lot": lot, "weight": row["Weight"], "items": items_by_lot[lot]})
        total = sum(g["weight"] for g in out)
        assert total == 10000, f"group weights sum to {total}, expected 10000"
        return out

    gem_groups = groups(tier["GemRateGroup"])
    stone_groups = groups(tier["WrightstoneRateGroup"])

    # The 2nd-trait roll tables, limited to the type rows the gem pool can
    # reach (plus their skill lots).
    used_rows = {
        i["secondTraitLot"]
        for g in gem_groups
        for i in g["items"]
        if i["secondTraitLot"] >= 0
    }
    skill_type_rows = {}
    used_lots = set()
    for row in db.execute("SELECT * FROM skill_type_lot ORDER BY rowid"):
        if row["Key"] not in used_rows:
            continue
        opts = []
        for i in range(1, 7):
            lot = cell_hash(row[f"SkillLotId{i}"])
            pct = row[f"ChancePercent{i}"]
            if lot is not None and pct:
                opts.append([lot, pct])
                used_lots.add(lot)
        skill_type_rows[row["Key"]] = opts
    missing = used_rows - skill_type_rows.keys()
    assert not missing, f"gem configs reference unknown type rows {missing}"

    skill_lots = {}
    for row in db.execute("SELECT Key, SkillId, Unk3 FROM skill_lot ORDER BY rowid"):
        key = cell_hash(row["Key"])
        if key in used_lots:
            assert row["Unk3"] == 1, "skill_lot weights are no longer uniform"
            skill_lots.setdefault(key, []).append(cell_hash(row["SkillId"]))
    assert used_lots == skill_lots.keys(), "type rows reference unknown skill lots"

    out = {
        "gemChancePercent": tier["GemChancePercent"],
        "wrightstoneChancePercent": tier["WrightstoneChancePercent"],
        "gemGroups": gem_groups,
        "stoneGroups": stone_groups,
        "skillTypeRows": skill_type_rows,
        "skillLots": skill_lots,
    }
    OUT_PATH.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    n_gem = sum(len(g["items"]) for g in out["gemGroups"])
    n_stone = sum(len(g["items"]) for g in out["stoneGroups"])
    print(
        f"wrote {OUT_PATH} — {len(out['gemGroups'])} gem groups ({n_gem} items), "
        f"{len(out['stoneGroups'])} stone groups ({n_stone} items), "
        f"{len(skill_type_rows)} type rows, {len(skill_lots)} skill lots"
    )


if __name__ == "__main__":
    main()
