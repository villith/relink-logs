"""Derive the summon class-hash -> display-name map for `skills.summon-classes`.

A summon body class is `XXHash32Custom("So####")`, and every equippable summon
has a `TXT_SMN_So####` entry in `src-tauri/lang/en/summons.json`. This pairs the
two so the hand-maintained map in `src-tauri/lang/en/ui.json` can name a meter
row from the class hash the hook publishes.

Tier suffixes are stripped: one class covers every tier of a summon, so
"Quakadile II" and "Quakadile III" become one row named "Quakadile".

Run from the repo root:

    python scripts/summon_class_hashes.py            # JSON on stdout
    python scripts/summon_class_hashes.py out.json   # JSON to a file
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gbfr_hash import game_xxhash32  # noqa: E402

SUMMONS = Path("src-tauri/lang/en/summons.json")
KEY = re.compile(r"^TXT_SMN_(So[0-9a-f]{4})(?:_(\d+))?$")
TIER_SUFFIX = re.compile(r"\s+(?:I{1,3}|IV|VI{0,3}|IX|X)$")


def main() -> int:
    entries = json.loads(SUMMONS.read_text(encoding="utf-8")).values()

    by_class: dict[str, dict[int, str]] = {}
    for entry in entries:
        match = KEY.match(entry["key"])
        if not match:
            print(f"skipped unrecognised key: {entry['key']}", file=sys.stderr)
            continue
        by_class.setdefault(match.group(1), {})[int(match.group(2) or 1)] = entry["text"]

    rows = []
    for summon_class, tiers in sorted(by_class.items()):
        # The lowest tier carries the cleanest name; a couple have doubled spaces.
        name = TIER_SUFFIX.sub("", tiers[min(tiers)]).strip()
        rows.append(
            ("%08x" % game_xxhash32(summon_class.encode("ascii")), summon_class, re.sub(r"\s{2,}", " ", name))
        )

    # A collision would silently merge two summons into a single row.
    seen: dict[str, str] = {}
    collisions = 0
    for class_hash, summon_class, _ in rows:
        if class_hash in seen:
            print(f"COLLISION {class_hash}: {seen[class_hash]} vs {summon_class}", file=sys.stderr)
            collisions += 1
        seen[class_hash] = summon_class

    print(f"{len(rows)} summon classes, {collisions} hash collisions", file=sys.stderr)

    text = json.dumps({class_hash: name for class_hash, _, name in rows}, indent=2, ensure_ascii=False)
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(text, encoding="utf-8")
    else:
        print(text)
    return 1 if collisions else 0


if __name__ == "__main__":
    sys.exit(main())
