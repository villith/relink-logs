#!/usr/bin/env python3
"""Generates src-tauri/assets/sigil-legality.json from the game's gem.tbl.

Feeds the build-legality rules (src-tauri/src/legality/sigils.rs): a sigil's
first trait is fixed by its item id, its second trait is either fixed by the
item id too or drawn from a lot, and a trait level is capped per sigil.

Pipeline (re-run after a game update):
  1. GBFRDataTools extract -i <data.i> -f system/table/gem.tbl -o <dir>
  2. python scripts/gen-sigil-legality.py <dir>/system/table/gem.tbl

gem.tbl is parsed RAW, never via GBFRDataTools' `tbl-to-sqlite`. That export is
provably wrong on v2.0.2 (verified by a full 1034-row diff): it puts the item id
under `PlayerReq` rather than `Key`, and its
`SkillTypeLotIdForRandom2ndSkill` column reads the wrong four bytes — 100%
mismatch, returning plausible small ints (1-5) instead of the real values
(-1, 2..7, 15, 16, 26, 27). Nothing trips a sanity check, so a generator built
on it would produce confidently-wrong cheat detection. gem.headers says as much
itself: "1.2.0 is back to normal but also not, it's a mess".

v2.0.2 layout (64-byte rows, 8-byte row-count header):
  +0x00  u32 trait 1 hash (matches traits.json keys)
  +0x04  u32 trait 2 hash (0x887AE0B0 = empty; a rolled 2nd trait uses the lot)
  +0x08  u32 the sigil item id (matches sigils.json keys)
  +0x24  i32 trait-2 lot id (-1 = this sigil takes no rolled second trait)
  +0x38  u8  "special" flag (1 = synthesis-excluded)

Output shape: { "<sigilIdHex8>": {trait1, trait2, trait2Lot, maxLevel?, special} }
`trait2Lot` keys into `trait2Lots` in transmarvel-pool.json rather than being
inlined, so each lot keeps one definition. `maxLevel` is OPTIONAL — see
MAX-LEVEL POLICY below; the Rust rule defaults to DEFAULT_MAX_LEVEL when absent.

TRAIT-2 LOT POLICY
------------------
gem.tbl's own lot column at +0x24 is the PRE-SWAP value and must NOT be used
directly. As `gen-transmarvel-tables.py` documents (live-derived 2026-07-26,
11/11 observed second traits), the game does not always roll from that row:
when the sigil's own trait1 belongs to one of the five second-trait categories
it swaps to the skill_type_lot variant that EXCLUDES that category, so a sigil
can never roll its own trait's family (ATK/HP/Crit/Stun -> 5, offense -> 6,
defense -> 7, support -> 26, utility -> 27).

The raw ids bear this out: gem.tbl yields lots 2, 3, 4, 5, 6, 7, 15, 16, 26, 27,
but only 5, 6, 7, 15, 26, 27 exist as real lots — the others (e.g. sigil
381bbe64, whose raw lot is 4 while its effective lot is 7) would resolve to
nothing and silently disable the rule.

Because the swap is a function of trait1, this generator takes the EFFECTIVE lot
per trait1 from transmarvel-pool.json — values that are already live-validated —
and applies it to every gem row carrying that trait1. Rows whose trait1 is
absent from the pool get `trait2Lot: null` and the rule stays silent for them,
which is the correct outcome: an unvalidated lot guess could falsely accuse.
We deliberately do NOT re-implement the category swap here; duplicating it
unvalidated is exactly how a wrong lot would slip in.

MAX-LEVEL POLICY
----------------
gem.tbl carries NO per-sigil level cap (every word of every row was checked
against four known caps; gem_rare.tbl, skill_level_lot.tbl, skill.tbl and
item.tbl were ruled out too). The only usable source is skill_status.tbl via
src/assets/trait-max-levels.json, but that holds COMBINED-across-copies levels,
which is why it must never be used as a cheat signal on its own (a total above
it just means redundant sigils — wasteful, not cheating).

It becomes trustworthy under one filter: a trait that is "exclusively special"
(every gem.tbl row carrying it as trait1 has the special flag set) has nothing
to stack, so its combined figure collapses to the single-sigil cap. Both ground
truths reproduce exactly: Immortal Shell = 20, War Elemental = 15 — the latter
across 7 item ids without inflating, which is what shows the filter tracks
single-sigil caps rather than totals.

Even so we only emit values ABOVE the default, because the two error directions
are not symmetric:
  - too HIGH -> the rule is more permissive and misses some cheats. Acceptable.
  - too LOW  -> the rule flags a legitimate sigil as impossible. NOT acceptable.
Emitting >15 is therefore required for correctness (omitting Immortal Shell's 20
would falsely flag a legitimate level-20 sigil), while emitting a below-default
figure (Sumo Force 5, Seven Net 6, or the un-named cac6aff2's 1) risks accusing
honest players if that figure is wrong, so those are omitted and default to 15.
A consequence worth knowing: the derived 30s and 45s may themselves be stacked
totals rather than true caps, but since they err permissive they are safe to
emit and are pending an in-game check.
"""

import json
import struct
import sys
from pathlib import Path

ROW_SIZE = 64
TRAIT1_OFFSET = 0x00
TRAIT2_OFFSET = 0x04
KEY_OFFSET = 0x08
TRAIT2_LOT_OFFSET = 0x24
SPECIAL_OFFSET = 0x38
INVALID = 0xFFFFFFFF
EMPTY_TRAIT = 0x887AE0B0
NO_LOT = -1

# The cap the Rust rule assumes when `maxLevel` is absent. Values equal to or
# below this are omitted rather than emitted; see MAX-LEVEL POLICY.
DEFAULT_MAX_LEVEL = 15

# Abort-on-mismatch guardrails. A failure here means a game patch moved the
# columns, and writing the table anyway would produce false accusations.
EXPECTED_ROWS = 1034

# item id -> (trait1, effective trait2Lot, special)
ANCHORS = {
    0x00612B10: (0x4C588C27, "6", True),  # War Elemental: rolls a 2nd from lot 6
    0x42BB0C1C: (0x57AB5B10, None, False),  # Supplementary Damage V: no 2nd
    # Raw lot 4 does not exist; its effective (post-category-swap) lot is 7.
    0x381BBE64: (0xE6CDBA9C, "7", False),
}

# (trait2 is empty, lot is -1) -> row count. The zero is the important one:
# no sigil both fixes its second trait AND rolls one, so a nonzero count there
# means the offsets moved.
EXPECTED_CROSS_TAB = {
    (True, True): 514,  # single-trait sigils
    (True, False): 285,  # rolls a second trait from a lot
    (False, True): 235,  # fixed pair, no roll
    (False, False): 0,  # impossible
}

# Traits whose cap is genuinely known to exceed the default, for reporting.
IMMORTAL_SHELL_TRAIT = 0xBF78FBFC
WAR_ELEMENTAL_TRAIT = 0x4C588C27


def hex8(value: int) -> str:
    return format(value & 0xFFFFFFFF, "08x")


def main() -> None:
    tbl_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not tbl_path or not Path(tbl_path).exists():
        sys.exit("usage: gen-sigil-legality.py <gem.tbl> (see module docstring)")

    root = Path(__file__).resolve().parent.parent
    data = Path(tbl_path).read_bytes()
    row_count = struct.unpack_from("<q", data, 0)[0]
    if 8 + row_count * ROW_SIZE != len(data):
        sys.exit(f"gem.tbl row size is no longer {ROW_SIZE} — re-derive the offsets")
    if row_count != EXPECTED_ROWS:
        sys.exit(f"gem.tbl has {row_count} rows, expected {EXPECTED_ROWS} — verify the layout")

    rows = []
    for i in range(row_count):
        offset = 8 + i * ROW_SIZE
        key = struct.unpack_from("<I", data, offset + KEY_OFFSET)[0]
        if key == INVALID:
            continue
        trait1 = struct.unpack_from("<I", data, offset + TRAIT1_OFFSET)[0]
        trait2 = struct.unpack_from("<I", data, offset + TRAIT2_OFFSET)[0]
        lot = struct.unpack_from("<i", data, offset + TRAIT2_LOT_OFFSET)[0]
        special = data[offset + SPECIAL_OFFSET] == 1
        rows.append((key, trait1, trait2, lot, special))

    cross_tab = {combo: 0 for combo in EXPECTED_CROSS_TAB}
    for _, _, trait2, lot, _ in rows:
        combo = (trait2 in (EMPTY_TRAIT, INVALID), lot == NO_LOT)
        cross_tab[combo] = cross_tab.get(combo, 0) + 1
    if cross_tab != EXPECTED_CROSS_TAB:
        sys.exit(
            f"gem.tbl cross-tab is {cross_tab}, expected {EXPECTED_CROSS_TAB} — offsets moved"
        )

    # A trait is "exclusively special" when every row carrying it as trait1 has
    # the special flag; only then does its combined max level equal one sigil's.
    rows_by_trait1: dict[int, list[bool]] = {}
    for _, trait1, _, _, special in rows:
        rows_by_trait1.setdefault(trait1, []).append(special)
    exclusively_special = {
        trait for trait, flags in rows_by_trait1.items() if flags and all(flags)
    }

    trait_max_levels = json.loads(
        (root / "src" / "assets" / "trait-max-levels.json").read_text(encoding="utf-8")
    )

    def max_level_for(trait1: int) -> int | None:
        """The per-sigil cap, or None to let the Rust rule default. Only
        above-default figures are emitted; see MAX-LEVEL POLICY."""
        if trait1 not in exclusively_special:
            return None
        level = trait_max_levels.get(hex8(trait1))
        if level is None or level <= DEFAULT_MAX_LEVEL:
            return None
        return level

    pool = json.loads(
        (root / "src" / "assets" / "transmarvel-pool.json").read_text(encoding="utf-8")
    )
    # trait1 -> effective (post-category-swap) lot, live-validated. See
    # TRAIT-2 LOT POLICY: gem.tbl's own lot column is pre-swap and unusable.
    effective_lots = {s["trait"]: s["trait2Lot"] for s in pool["sigils"]}

    out: dict[str, dict] = {}
    for key, trait1, trait2, lot, special in rows:
        # A row that rolls a second trait needs the effective lot; a row with a
        # fixed pair (or none) takes no lot at all.
        rolls_second = lot != NO_LOT
        entry = {
            "trait1": hex8(trait1),
            "trait2": None if trait2 in (EMPTY_TRAIT, INVALID) else hex8(trait2),
            "trait2Lot": effective_lots.get(hex8(trait1)) if rolls_second else None,
            "special": special,
        }
        level = max_level_for(trait1)
        if level is not None:
            entry["maxLevel"] = level
        out[hex8(key)] = entry

    for anchor, (trait1, lot, special) in ANCHORS.items():
        actual = out.get(hex8(anchor))
        if actual is None:
            sys.exit(f"anchor {hex8(anchor)} missing from gem.tbl — columns moved?")
        if actual["trait1"] != hex8(trait1):
            sys.exit(f"anchor {hex8(anchor)}.trait1 is {actual['trait1']}, expected {hex8(trait1)}")
        if actual["trait2Lot"] != lot:
            sys.exit(f"anchor {hex8(anchor)}.trait2Lot is {actual['trait2Lot']}, expected {lot}")
        if actual["special"] != special:
            sys.exit(f"anchor {hex8(anchor)}.special is {actual['special']}, expected {special}")

    # War Elemental must stay at the default (its 15 is not emitted), and
    # Immortal Shell must carry its above-default 20 or a legitimate level-20
    # sigil would be flagged as impossible.
    if WAR_ELEMENTAL_TRAIT not in exclusively_special:
        sys.exit("War Elemental is no longer exclusively special — the max-level filter broke")
    if trait_max_levels.get(hex8(WAR_ELEMENTAL_TRAIT)) != DEFAULT_MAX_LEVEL:
        sys.exit("War Elemental's max level is no longer 15 — re-check the max-level source")
    if max_level_for(IMMORTAL_SHELL_TRAIT) != 20:
        sys.exit(
            "Immortal Shell no longer derives a cap of 20 — emitting the default would "
            "falsely flag a legitimate level-20 sigil"
        )

    missing = [s["sigilId"] for s in pool["sigils"] if s["sigilId"] not in out]
    mismatched = [
        s["sigilId"]
        for s in pool["sigils"]
        if s["sigilId"] in out and out[s["sigilId"]]["trait2Lot"] != s["trait2Lot"]
    ]
    if missing or mismatched:
        sys.exit(
            f"transmarvel pool disagrees: {len(missing)} missing, "
            f"{len(mismatched)} lot mismatches — the wrong column was read"
        )

    out_path = root / "src-tauri" / "assets" / "sigil-legality.json"
    out_path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    capped = {key: e["maxLevel"] for key, e in out.items() if "maxLevel" in e}
    with_lot = sum(1 for e in out.values() if e["trait2Lot"] is not None)
    rolls = sum(1 for _, _, _, lot, _ in rows if lot != NO_LOT)
    print(f"wrote {out_path} — {len(out)} sigils")
    print(f"cross-tab verified: {EXPECTED_CROSS_TAB}")
    print(f"pool cross-check: missing 0 lot mismatches 0 ({len(pool['sigils'])} sigils)")
    print(
        f"{with_lot}/{rolls} rows that roll a second trait resolved an effective lot; "
        f"the remaining {rolls - with_lot} have no pool-validated lot and stay silent"
    )
    print(f"{len(capped)} sigils carry an above-default maxLevel:")
    for key, level in sorted(capped.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {key} = {level}")


if __name__ == "__main__":
    main()
