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

  ROW SELECTION (live-derived 2026-07-26, 11/11 observed 2nd traits): the
  roll does NOT always use gem.tbl's SkillTypeLotIdForRandom2ndSkill.
  When the sigil's own trait1 belongs to one of the five 2nd-trait
  category lots, the game swaps to the skill_type_lot variant that
  EXCLUDES that category (so a sigil can't roll its own trait's family):
  ATK/HP/Crit/Stun -> 5, offense -> 6, defense -> 7, support -> 26,
  utility -> 27. Sigils whose trait1 has no category (character sigils,
  celestials, Stronghold, ...) use the gem.tbl row as-is.
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

# The five 2nd-trait category lots (skill_lot keys). A trait's category =
# the lot containing it; the exclusion row per category is the
# skill_type_lot variant lacking that lot (see docstring).
CATEGORY_EXCLUSION_ROWS = [
    (0x4CE7152C, 5),  # ATK/HP/Crit Rate/Stun Power
    (0xF865A223, 6),  # offense (Enmity, Stamina, DMG Cap, ...)
    (0x8F952AC1, 7),  # defense (Garrison, resistances, Aegis, ...)
    (0x46D6DFDE, 26),  # support (Regen, Quick Cooldown, Uplift, ...)
    (0xD4078C7D, 27),  # utility (Guts, Autorevive, Provoke, ...)
]

# gem.tbl raw layout (v2.0.2): 64-byte records; a record spans
# [item_hash - 8, item_hash + 56). Fields used here (framing pinned by
# locating known SkillId hashes of fixed-pair sigils):
#   rel -8: SkillId1 hash   rel -4: SkillId2 hash (0x887ae0b0 = empty)
#   rel  0: item id hash    rel +28: SkillTypeLotIdForRandom2ndSkill (-1 = none)
GEM_ROW_START = 16  # header size; item hashes repeat every 64B after it + 8
GEM_ROW_SIZE = 64
EMPTY_KEY = 0x887AE0B0


def load_gem_configs(gem_tbl: Path) -> dict:
    """item hash -> (trait1, trait2, gem.tbl type-lot id) from raw gem.tbl."""
    data = gem_tbl.read_bytes()
    out = {}
    # Item hashes repeat every 64B starting at GEM_ROW_START; skill1/skill2
    # sit just before each (in the previous record's tail / header).
    for off in range(GEM_ROW_START, len(data) - 56 + 1, GEM_ROW_SIZE):
        rel = lambda d: struct.unpack_from("<I", data, off + d)[0]
        trait1 = 0 if rel(-8) == EMPTY_KEY else rel(-8)
        trait2 = 0 if rel(-4) == EMPTY_KEY else rel(-4)
        lot = rel(28) if rel(28) != 0xFFFFFFFF else -1
        out[rel(0)] = (trait1, trait2, lot)
    return out


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <db.sqlite> (see module docstring)")
    db = sqlite3.connect(sys.argv[1])
    db.row_factory = sqlite3.Row
    gem_configs = load_gem_configs(Path(sys.argv[1]).parent / "table" / "gem.tbl")

    # trait hash -> its exclusion row (see CATEGORY_EXCLUSION_ROWS).
    trait_category_row = {}
    for row in db.execute("SELECT Key, SkillId FROM skill_lot ORDER BY rowid"):
        key = cell_hash(row["Key"])
        for lot, type_row in CATEGORY_EXCLUSION_ROWS:
            if key == lot:
                trait_category_row[cell_hash(row["SkillId"])] = type_row

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
        if second_lot >= 0 and trait1 in trait_category_row:
            second_lot = trait_category_row[trait1]
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
