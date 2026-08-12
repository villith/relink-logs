#!/usr/bin/env python3
"""Generate src/assets/action-input-map.json — per-character action id ->
input buttons, read from the engine's own combo-branch graph.

Each `system/player/data/pl####/pl####_action.msg` record (MessagePack with
DUPLICATE map keys — a plain dict silently keeps only the last record) carries
combo-branch edges: branchXAtk_/_Hold_/_Just_ name the action the X (basic /
left) input leads to from this state, branchYAtk_* the Y (special / right)
input. An action TARGETED by an X edge is a left-input move; by a Y edge,
right; a `derivedId_` variant inherits its base action's buttons. Actions no
edge targets (charge releases, stance entries, the launcher) are simply
absent — absence of an edge is not evidence of a button.

The asset is the engine layer `gen-attack-groups-from-buttons.mjs` gives
precedence over the manual family buttons (Scott's ruling, 2026-08-10).
`scripts/analyze-action-inputs.py` reports the same reading against the
manual map without writing anything.

## Running it

    GBFRDataTools.exe extract -i <game>/data.i -f system/player/data/pl0000/pl0000_action.msg -o <tmp>
    ... (one per character pl0000-pl2900; lowercase 'data' — the filelist's
    capital-D spelling does not hash to a file in the archive)
    python scripts/gen-action-input-map.py <tmp>/system/player/data

Requires `pip install msgpack`. Output is Prettier-stable (LF, two-space
indent, inline button arrays), keyed by character then numeric action id.
"""

import glob
import os
import sys
from collections import defaultdict

import msgpack

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "src", "assets", "action-input-map.json")

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
    changed = True
    while changed:
        changed = False
        for rec in records:
            action, base = int(rec["id_"]), int(rec.get("derivedId_", 0))
            if base > 0 and buttons[base] - buttons[action]:
                buttons[action] |= buttons[base]
                changed = True
    return buttons


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <extracted system/player/data dir>")

    characters = {}
    for path in sorted(glob.glob(os.path.join(sys.argv[1], "pl*", "pl*_action.msg"))):
        character = os.path.basename(path).split("_")[0]
        buttons = attribute(load_records(path))
        resolved = {action: sorted(bs) for action, bs in buttons.items() if bs}
        if resolved:
            characters[character] = resolved

    lines = [
        "{",
        '  "version": "2.0.4",',
        '  "provenance": "Engine combo-branch graph (pl####_action.msg branchX/YAtk edges, derivedId inheritance).'
        ' Regenerate with scripts/gen-action-input-map.py; see its docstring.",',
        '  "characters": {',
    ]
    for index, (character, resolved) in enumerate(sorted(characters.items())):
        lines.append(f'    "{character}": {{')
        actions = sorted(resolved.items())
        for action_index, (action, buttons) in enumerate(actions):
            comma = "," if action_index < len(actions) - 1 else ""
            rendered = ", ".join(f'"{b}"' for b in buttons)
            lines.append(f'      "{action}": [{rendered}]{comma}')
        lines.append("    }" + ("," if index < len(characters) - 1 else ""))
    lines += ["  }", "}"]

    with open(OUT_PATH, "w", encoding="utf8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")
    total = sum(len(resolved) for resolved in characters.values())
    print(f"wrote {OUT_PATH}: {len(characters)} characters, {total} actions")


if __name__ == "__main__":
    main()
