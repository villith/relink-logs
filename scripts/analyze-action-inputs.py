#!/usr/bin/env python3
"""Report action -> input button from the engine's own combo-branch graph,
audited against src/assets/action-button-map.json (the manual layer).

## What the engine data says

Every `system/player/data/pl####/pl####_action.msg` (MessagePack, with
DUPLICATE map keys — decode with an object_pairs_hook, a plain dict keeps only
the last record) carries per-action combo-branch edges:

    branchXAtk_ / branchXAtk_Hold_ / branchXAtk_Just_   X = basic  = left
    branchYAtk_ / branchYAtk_Hold_ / branchYAtk_Just_   Y = special = right

An action TARGETED by an X edge is executed by the X input; by a Y edge, the
Y input. `derivedId_` variants (the damage-limit-type / skillboard-judgment
copies) inherit the base action's buttons. `branchAtkHit_` is an on-hit
auto-branch, not an input, and is ignored.

Actions with NO incoming edge are reported unknown, not guessed — they are
systematically the charge-RELEASE moves (Eustace's grades, Io's Stargaze),
stance-entered strings, and the universal air launcher 400, which the branch
graph never targets because they start from holds/stances, not from a combo
step. Absence of an edge is not evidence of a button.

## Run

    GBFRDataTools.exe extract -i <game>/data.i -f system/player/data/pl0000/pl0000_action.msg -o <dir>
    ... (one per character; lowercase 'data' — the capital-D filelist spelling
    does not hash to a file in the archive)
    python scripts/analyze-action-inputs.py <dir>/system/player/data [report.json]

Requires `pip install msgpack`. Read-only: prints the audit and optionally
writes the JSON report; it never touches the assets. Banking engine-derived
buttons into the coverage is a separate decision — this report disagrees with
several `source:"scott"` families (see the contradicted section), so the
merge semantics need a human ruling, not a generator run.
"""

import glob
import json
import os
import sys
from collections import defaultdict

import msgpack

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

X_FIELDS = ["branchXAtk_", "branchXAtk_Hold_", "branchXAtk_Just_"]
Y_FIELDS = ["branchYAtk_", "branchYAtk_Hold_", "branchYAtk_Just_"]


def load_records(path):
    with open(path, "rb") as handle:
        data = msgpack.unpack(handle, strict_map_key=False, object_pairs_hook=lambda pairs: pairs)
    return [dict(value) for _, value in data]


def attribute(records):
    """action id -> set of buttons ('left' for X, 'right' for Y)."""
    buttons = defaultdict(set)
    for rec in records:
        for field, button in [(f, "left") for f in X_FIELDS] + [(f, "right") for f in Y_FIELDS]:
            target = int(rec.get(field, -1))
            if target >= 0:
                buttons[target].add(button)
    # derivedId_ closure, to a fixpoint: variants inherit the base's buttons.
    changed = True
    while changed:
        changed = False
        for rec in records:
            action, base = int(rec["id_"]), int(rec.get("derivedId_", 0))
            if base > 0 and buttons[base] - buttons[action]:
                buttons[action] |= buttons[base]
                changed = True
    return buttons


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(f"usage: {sys.argv[0]} <extracted system/player/data dir> [report.json]")
    gamedata = sys.argv[1]

    with open(os.path.join(ROOT, "src", "assets", "action-button-map.json"), encoding="utf8") as handle:
        button_map = json.load(handle)

    report = {"validated": [], "contradicted": [], "proposals": [], "unknown": []}
    for path in sorted(glob.glob(os.path.join(gamedata, "pl*", "pl*_action.msg"))):
        character = os.path.basename(path).split("_")[0]
        entry = button_map["characters"].get(character)
        if entry is None:
            continue
        buttons = attribute(load_records(path))

        for family in entry["families"]:
            per_action = {action: sorted(buttons.get(action, set())) for action in family["ids"]}
            derived = sorted({b for bs in per_action.values() for b in bs})
            claimed = family.get("button")
            line = {
                "character": character,
                "family": family["name"],
                "source": family.get("source"),
                "claimed": claimed,
                "engine": derived,
                "perAction": per_action,
            }
            if not derived:
                report["unknown"].append(line)
            elif claimed is None:
                report["proposals"].append(line)
            elif derived == [claimed]:
                report["validated"].append(line)
            else:
                report["contradicted"].append(line)

    for kind in ["contradicted", "proposals", "unknown", "validated"]:
        rows = report[kind]
        print(f"\n== {kind} ({len(rows)}) ==")
        for row in rows:
            per = " ".join(f"{a}:{''.join(b) or '-'}" for a, b in row["perAction"].items())
            print(
                f"  {row['character']} {row['family']!r} [{row['source']}] "
                f"claimed={row['claimed']} engine={row['engine']}  {per}"
            )

    if len(sys.argv) == 3:
        with open(sys.argv[2], "w", encoding="utf8") as handle:
            json.dump(report, handle, indent=1, ensure_ascii=False)
        print(f"\nwrote {sys.argv[2]}")


if __name__ == "__main__":
    main()
