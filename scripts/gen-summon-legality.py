#!/usr/bin/env python3
"""Generates src-tauri/assets/summon-legality.json from the game's summon tables.

Feeds the build-legality rules (src-tauri/src/legality/): an equipped summon
(`protocol::EquippedSummon`) carries a main trait + level and an equip bonus +
level, and both are rolled from tables keyed by the summon's own id. This table
is the complete roll space, so a rule can say both "that trait cannot appear on
that summon" and "that trait at that level had probability p".

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/summon.tbl -o <dir>
     (same for summon_lot.tbl, summon_curve.tbl, summon_base_param.tbl)
  2. python scripts/gen-summon-legality.py <dir>/system/table

No `tbl-to-sqlite` step: all four tables are parsed RAW. The converter's
declared column order does match the byte order here (unlike gem.tbl, whose
v2.0.2 export is provably wrong — see gen-sigil-legality.py), but reading the
bytes removes a step from the pipeline and a class of silent failure with it.
The framing is self-checking: an 8-byte row count followed by fixed-width rows
of u32 columns, and 6812/14528/884/1480 bytes divide exactly into 36/20/12/64,
i.e. the 9/5/3/16 columns the schema declares.

v2.0.2 layouts (u32 columns, 8-byte row-count header):
  summon (189 rows, 36B)
    +0x00 chance main-trait lot     +0x04 guaranteed main-trait lot
    +0x08 chance equip-bonus lot    +0x0C guaranteed equip-bonus lot
    +0x10 summon id (EquippedSummon.summon_id; keys lang/<l>/summons.json)
    +0x18 rarity   +0x1C sort order   +0x20 unknown flag
    (0x887ae0b0 = the empty-key sentinel, shared with gem.tbl)
  summon_lot (726 rows, 20B)
    +0x00 lot key   +0x04 candidate id   +0x08 curve id   +0x0C weight
  summon_curve (73 rows, 12B)
    +0x00 curve key   +0x04 level   +0x08 weight
  summon_base_param (23 rows, 64B) — only +0x28 (the bonus id) is read, as a
    cross-table check that every equip-bonus candidate is a real bonus.

THE JOIN
--------
summon.<chance|guaranteed><Main|Bonus>Lot -> summon_lot rows with that Key.
Each such row is one CANDIDATE (a trait id for main, a summon_base_param id for
the bonus) with a pick Weight, and points at a summon_curve Key whose rows are
that candidate's (level, weight) window. Every id resolves: 152 chance-main /
34 guaranteed-main / 4 chance-bonus / 34 guaranteed-bonus lots, all 27
referenced curves present, all 82 trait ids in traits.json, all 22 bonus ids in
summon_base_param (and disjoint from the trait ids).

WEIGHTS, AND WHY THEY ARE EMITTED
---------------------------------
Nothing here is uniform, so a uniform-draw odds figure would be wrong, and the
downstream rule shows its number to a user. The real weights are emitted and
the rule should compute

    P(candidate, level) = weight/sum(weights) * levelWeight/sum(levelWeights)

Both factors matter. A tier-3 lot picks one of 5 traits at 1840/10000 but one
"special" trait at only 800/10000, and within a level curve the top level is
deliberately rarer than the rest (tier 3: 2200/2100/2000/1900/1000 for 11..15).

The two tables are consistent in a way that pins this reading: for every lot,
each curve's weight sum equals the total lot weight of exactly the candidates
that share it (verified for all 224 lots, 0 mismatches, +/-2 for the table's
own rounding — some lots sum to 9999 or 9998 rather than 10000). That means the
designers authored a group budget out of 10000 and split it by level, so the
"pick a candidate then pick a level" reading and a "joint (candidate, level)
draw" reading give identical probabilities. Candidates sharing a curve always
share a weight too, which is what makes the two agree exactly.

PER-CANDIDATE WINDOWS, NOT PER-TIER
-----------------------------------
The published per-tier windows (tier 1 = 4-6, tier 2 = 7-10, tier 3 = 11-15) do
reproduce, but they are NOT safe to use as the model. Three things break them,
and each one would make a per-tier rule falsely accuse an honest player:

  1. A level window belongs to a (summon, candidate) pair, not to a summon.
     Silverslime II (0d94b89f) and Goldslime II (316641a4) are rarity 4 and
     their lots hold the expected 7-10 curve for three candidates, plus a
     fourth candidate — Improved Dodge and War Elemental respectively — on its
     own singleton curve at level 15, weight 300/10000. Their tier-3 twins
     (e528e76f, 439cdb88) do the same at level 15 weight 800. 21 of the 152
     rolled lots carry two distinct curves like this; the tier-3 ones simply
     hide it because their special candidate's level 15 is inside 11-15 anyway.
  2. 37 of the 189 summons do not roll at all. They carry guaranteed lots
     instead of chance lots (the two are strictly either/or — 152 chance-both,
     37 guaranteed-both, no summon mixes them), each holding one candidate on a
     single-level 100% curve. Their fixed levels ignore the tier windows
     completely: Wheel of Fate III (48732d1f) is rarity 5 with a fixed level-4
     Critical Hit DMG, and Lurker in the Dark (6d6cb496) is rarity 4 with a
     fixed level-1 Divergence.
  3. Several display names map to two different summon ids, one rolled and one
     fixed — e.g. Vrazarek Firewyrm III is both f2be819e (rolls 11-15) and
     9f0ecf8b (guaranteed DMG Cap at level 15). Only the id can tell them
     apart, so any per-name or per-tier shortcut is wrong by construction.

So the emitted window is per (summon, candidate). This costs nothing over
per-tier and removes the assumption entirely.

Point 2 also shows why the weights are load-bearing rather than a nicety:
9f0ecf8b's main trait sits at the very top of its window at probability 1.0. A
rule reading only "top of window" would report the game's own fixed summon as
improbable.

PERMISSIVENESS
--------------
The module's governing rule is that incomplete data emits no finding, and that
a too-WIDE window only misses cheats while a too-NARROW one accuses an honest
player. Applied here:
  - Every candidate is emitted, including the rare specials; nothing is
    averaged, clamped or dropped. All 189 summons resolve completely, so
    nothing needs omitting today — but a future summon that failed to resolve
    must be omitted rather than emitted partially, and a summon id absent from
    this table must produce no finding at all.
  - UNVERIFIED, and important for the rule's wording: this table is the
    ACQUISITION roll space. Whether a summon's trait or bonus can be improved
    after acquisition is a gameplay behavior nobody has confirmed. The tables
    give a reason to think not — the I/II/III tiers are separate summon ids
    with separate rolls, so a "better" copy is a different id — but that is
    inference, not observation. Until it is confirmed, an out-of-window value
    should be reported as improbable, not as impossible.

Output shape: { "<summonIdHex8>": {
    "tier": 1|2|3,          // rarity 3|4|5 renumbered to the in-game I/II/III
    "rolled": bool,         // false = fixed main trait AND fixed bonus
    "mainTraits": { "<traitIdHex8>": {"weight": w, "levels": [[lvl, w], ...]} },
    "bonuses":    { "<bonusIdHex8>": {"weight": w, "levels": [[lvl, w], ...]} }
} }
Main-trait levels are 1-based as displayed. Bonus levels are 0-based, indexing
summon_base_param's ten LevelNValue columns, matching EquippedSummon.bonus_level
and src-tauri/assets/summon-bonus-values.json. `levels` is sorted ascending, so the
top of a window is its last entry. Weight totals are not emitted: sum them,
because the table's own totals are 10000, 9999 or 9998 depending on the lot.

The file is written one summon per line rather than fully indented. Indenting
these deeply-nested weight pairs costs 4x the bytes for an asset that is
include_str!'d into the binary, and a line per summon is the diff granularity
that actually helps when a patch moves a roll.
"""

import json
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

EMPTY_KEY = 0x887AE0B0

# (columns, expected row count). A row-count change means a game patch; a size
# that no longer divides means the columns moved, and either way a table built
# on the old layout would be confidently wrong.
TABLES = {
    "summon": (9, 189),
    "summon_lot": (5, 726),
    "summon_curve": (3, 73),
    "summon_base_param": (16, 23),
}

# summon.tbl column indices.
CHANCE_MAIN, GUARANTEED_MAIN, CHANCE_BONUS, GUARANTEED_BONUS = 0, 1, 2, 3
SUMMON_KEY, RARITY = 4, 6
# summon_base_param.tbl: the bonus id, used only for the cross-table check.
BASE_PARAM_KEY = 10

# summon.Rarity -> the in-game I/II/III tier, with the row count each must have.
TIERS = {3: 1, 4: 2, 5: 3}
EXPECTED_RARITY_COUNTS = {3: 46, 4: 78, 5: 65}

# Rolled summons only, tier -> {level window: how many summons have it}. The
# plain windows are the published 4-6 / 7-10 / 11-15; the extra entries are the
# real outliers documented above, pinned here so a patch that adds, removes or
# reshapes one aborts the run instead of silently changing the rule's behaviour.
EXPECTED_MAIN_WINDOWS = {
    1: {(4, 5, 6): 38},
    2: {(7, 8, 9, 10): 61, (7, 8, 9, 10, 15): 2},
    3: {(11, 12, 13, 14, 15): 51},
}
EXPECTED_BONUS_WINDOWS = {
    1: {(0, 1, 2): 38},
    2: {(3, 4, 5): 63},
    3: {(5, 6, 7, 8, 9): 4, (6, 7, 8, 9): 47},
}

# 152 summons roll both sides, 37 have both fixed, and none mixes the two.
EXPECTED_ROLLED = 152
EXPECTED_FIXED = 37

# Concrete anchors: (tier, rolled, main trait -> (weight, levels)).
# Goldslime II is the rarity-4 outlier — its level-15 War Elemental is the
# reason windows are per-candidate. Vrazarek Firewyrm III (fixed copy) is the
# guaranteed top-of-window case that proves the odds must be weighted.
# Lucilius is an ordinary tier-3 roll, including its rarer special candidate.
ANCHORS = {
    "316641a4": (  # Goldslime II
        2,
        True,
        {
            "4c588c27": (300, [[15, 300]]),  # War Elemental
            "5e422ae5": (3233, [[7, 2700], [8, 2600], [9, 2400], [10, 2000]]),
        },
    ),
    "9f0ecf8b": (  # Vrazarek Firewyrm III, the fixed copy of f2be819e
        3,
        False,
        {"dc584f60": (10000, [[15, 10000]])},  # DMG Cap, guaranteed
    ),
    "6e5968fc": (  # Lucilius
        3,
        True,
        {
            "ee85cd1f": (800, [[15, 800]]),  # Berserker Echo
            "dbe1d775": (
                1840,
                [[11, 2200], [12, 2100], [13, 2000], [14, 1900], [15, 1000]],
            ),  # Alpha
        },
    ),
}


def hex8(value: int) -> str:
    return format(value & 0xFFFFFFFF, "08x")


def levels_of(block: dict[str, dict]) -> tuple[int, ...]:
    """The union of a candidate block's levels — the summon's whole window."""
    return tuple(sorted({level for entry in block.values() for level, _ in entry["levels"]}))


def read_table(directory: Path, name: str) -> list[tuple[int, ...]]:
    """Rows of a .tbl as tuples of u32, with the framing checked."""
    columns, expected_rows = TABLES[name]
    path = directory / f"{name}.tbl"
    if not path.exists():
        sys.exit(f"{path} is missing — extract it first (see module docstring)")
    data = path.read_bytes()
    row_count = struct.unpack_from("<q", data, 0)[0]
    if 8 + row_count * columns * 4 != len(data):
        sys.exit(
            f"{name}.tbl is not {columns} u32 columns ({len(data)} bytes, "
            f"{row_count} rows) — re-derive the layout"
        )
    if row_count != expected_rows:
        sys.exit(f"{name}.tbl has {row_count} rows, expected {expected_rows} — verify the layout")
    return [
        struct.unpack_from(f"<{columns}I", data, 8 + i * columns * 4) for i in range(row_count)
    ]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <extracted system/table dir> (see module docstring)")
    table_dir = Path(sys.argv[1])
    root = Path(__file__).resolve().parent.parent

    summons = read_table(table_dir, "summon")
    lot_table = read_table(table_dir, "summon_lot")
    curve_table = read_table(table_dir, "summon_curve")
    base_params = read_table(table_dir, "summon_base_param")

    lots: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
    for key, candidate, curve_id, weight, _unk in lot_table:
        lots[key].append((candidate, curve_id, weight))
    curves: dict[int, list[list[int]]] = defaultdict(list)
    for key, level, weight in curve_table:
        curves[key].append([level, weight])

    if any(weight <= 0 for rows in lots.values() for _, _, weight in rows):
        sys.exit("summon_lot has a non-positive candidate weight — the weight column moved")
    if any(weight <= 0 for rows in curves.values() for _, weight in rows):
        sys.exit("summon_curve has a non-positive level weight — the weight column moved")

    # Every curve's weight sum equals the total lot weight of the candidates
    # sharing it. This is what pins the candidate/level split (see WEIGHTS), and
    # it is the check most likely to catch a column shift, since it ties three
    # columns across two tables together.
    for key, rows in lots.items():
        grouped: dict[int, int] = Counter()
        for _, curve_id, weight in rows:
            if curve_id not in curves:
                sys.exit(f"lot {hex8(key)} references unknown curve {hex8(curve_id)}")
            grouped[curve_id] += weight
        for curve_id, lot_weight in grouped.items():
            curve_weight = sum(weight for _, weight in curves[curve_id])
            if abs(curve_weight - lot_weight) > 2:
                sys.exit(
                    f"lot {hex8(key)} curve {hex8(curve_id)}: candidates weigh {lot_weight} "
                    f"but the curve weighs {curve_weight} — the join no longer holds"
                )
        if len({candidate for candidate, _, _ in rows}) != len(rows):
            sys.exit(f"lot {hex8(key)} lists a candidate twice — the candidate column moved")

    def window(lot_id: int) -> dict[str, dict]:
        """candidate id -> its pick weight and its (level, weight) window."""
        out = {}
        for candidate, curve_id, weight in lots[lot_id]:
            out[hex8(candidate)] = {
                "weight": weight,
                "levels": sorted(curves[curve_id], key=lambda pair: pair[0]),
            }
        return out

    rarity_counts = Counter(row[RARITY] for row in summons)
    if dict(rarity_counts) != EXPECTED_RARITY_COUNTS:
        sys.exit(
            f"summon.tbl rarity split is {dict(rarity_counts)}, expected "
            f"{EXPECTED_RARITY_COUNTS} — the rarity column moved or the roster changed"
        )

    out: dict[str, dict] = {}
    main_windows: dict[int, Counter] = defaultdict(Counter)
    bonus_windows: dict[int, Counter] = defaultdict(Counter)
    rolled_count = fixed_count = 0
    for row in summons:
        summon_id = hex8(row[SUMMON_KEY])
        if summon_id in out:
            sys.exit(f"summon id {summon_id} appears twice — the key column moved")
        rolls_main = row[CHANCE_MAIN] != EMPTY_KEY
        rolls_bonus = row[CHANCE_BONUS] != EMPTY_KEY
        # Either/or, never mixed: a summon that rolls its main trait rolls its
        # bonus too, and a fixed one fixes both. A rule keyed on `rolled` would
        # be wrong for a mixed summon, so refuse to emit one.
        if rolls_main != rolls_bonus:
            sys.exit(f"summon {summon_id} rolls one side and fixes the other — model no longer holds")
        main_lot = row[CHANCE_MAIN] if rolls_main else row[GUARANTEED_MAIN]
        bonus_lot = row[CHANCE_BONUS] if rolls_bonus else row[GUARANTEED_BONUS]
        if main_lot == EMPTY_KEY or bonus_lot == EMPTY_KEY:
            sys.exit(f"summon {summon_id} has no main-trait or bonus lot at all")
        if main_lot not in lots or bonus_lot not in lots:
            sys.exit(f"summon {summon_id} references a lot missing from summon_lot.tbl")

        tier = TIERS.get(row[RARITY])
        if tier is None:
            sys.exit(f"summon {summon_id} has unknown rarity {row[RARITY]}")
        main_traits = window(main_lot)
        bonuses = window(bonus_lot)
        if not rolls_main and (len(main_traits) != 1 or len(bonuses) != 1):
            sys.exit(f"summon {summon_id} is guaranteed but its lot has several candidates")

        out[summon_id] = {
            "tier": tier,
            "rolled": rolls_main,
            "mainTraits": main_traits,
            "bonuses": bonuses,
        }
        if rolls_main:
            rolled_count += 1
            main_windows[tier][levels_of(main_traits)] += 1
            bonus_windows[tier][levels_of(bonuses)] += 1
        else:
            fixed_count += 1

    if (rolled_count, fixed_count) != (EXPECTED_ROLLED, EXPECTED_FIXED):
        sys.exit(
            f"{rolled_count} rolled / {fixed_count} fixed summons, expected "
            f"{EXPECTED_ROLLED}/{EXPECTED_FIXED} — the lot columns moved"
        )
    for label, actual, expected in (
        ("main-trait", main_windows, EXPECTED_MAIN_WINDOWS),
        ("equip-bonus", bonus_windows, EXPECTED_BONUS_WINDOWS),
    ):
        got = {tier: dict(counts) for tier, counts in sorted(actual.items())}
        if got != expected:
            sys.exit(
                f"{label} windows are {got}, expected {expected} — do NOT relax this "
                f"guardrail; the real windows changed and the rule must be re-derived"
            )

    # Cross-table: an equip-bonus candidate must be a real summon_base_param
    # row, and must not collide with the trait id namespace.
    bonus_ids = {key for entry in out.values() for key in entry["bonuses"]}
    trait_ids = {key for entry in out.values() for key in entry["mainTraits"]}
    known_bonuses = {hex8(row[BASE_PARAM_KEY]) for row in base_params}
    unknown = bonus_ids - known_bonuses
    if unknown:
        sys.exit(f"equip bonuses {sorted(unknown)} are not in summon_base_param.tbl")
    if trait_ids & bonus_ids:
        sys.exit(f"trait and bonus ids collide: {sorted(trait_ids & bonus_ids)} — a lot column moved")

    for anchor, (tier, rolled, expected_traits) in ANCHORS.items():
        actual = out.get(anchor)
        if actual is None:
            sys.exit(f"anchor summon {anchor} missing from summon.tbl — the key column moved?")
        if (actual["tier"], actual["rolled"]) != (tier, rolled):
            sys.exit(
                f"anchor {anchor} is tier {actual['tier']} rolled={actual['rolled']}, "
                f"expected tier {tier} rolled={rolled}"
            )
        for trait, (weight, levels) in expected_traits.items():
            got = actual["mainTraits"].get(trait)
            if got is None:
                sys.exit(f"anchor {anchor} no longer offers main trait {trait}")
            if (got["weight"], got["levels"]) != (weight, levels):
                sys.exit(
                    f"anchor {anchor} trait {trait} is weight {got['weight']} "
                    f"{got['levels']}, expected weight {weight} {levels}"
                )

    out_path = root / "src-tauri" / "assets" / "summon-legality.json"
    body = ",\n".join(
        f' "{summon_id}": {json.dumps(entry, sort_keys=True, separators=(",", ":"))}'
        for summon_id, entry in sorted(out.items())
    )
    out_path.write_text("{\n" + body + "\n}\n", encoding="utf-8")

    specials = [
        (summon_id, trait)
        for summon_id, entry in sorted(out.items())
        if entry["rolled"]
        for trait, block in entry["mainTraits"].items()
        if len(block["levels"]) == 1
    ]
    tiers = ", ".join(f"{t}={sum(1 for e in out.values() if e['tier'] == t)}" for t in (1, 2, 3))
    print(f"wrote {out_path} — {len(out)} summons")
    print(f"  tiers: {tiers}")
    print(f"  {rolled_count} roll both sides, {fixed_count} have both fixed")
    print(f"  {len(trait_ids)} distinct main traits, {len(bonus_ids)} distinct equip bonuses")
    for label, windows in (("main-trait", main_windows), ("equip-bonus", bonus_windows)):
        for tier, counts in sorted(windows.items()):
            shown = ", ".join(f"{list(w)} x{n}" for w, n in sorted(counts.items()))
            print(f"  tier {tier} {label} windows: {shown}")
    print(f"  {len(specials)} single-level 'special' main-trait candidates on rolled summons:")
    for summon_id, trait in specials:
        block = out[summon_id]["mainTraits"][trait]
        total = sum(b["weight"] for b in out[summon_id]["mainTraits"].values())
        print(
            f"    {summon_id} tier {out[summon_id]['tier']} trait {trait} "
            f"level {block['levels'][0][0]} at {block['weight']}/{total}"
        )


if __name__ == "__main__":
    main()

