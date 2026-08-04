#!/usr/bin/env python3
"""Generate src-tauri/lang/<locale>/statuses.json from the game's status.tbl + text_status.msg.

The Buffs and Debuffs tables key this by decimal `StatusId` (what the hook emits
in `StatusApplyEvent.status_id`) to name an effect. Without it every row reads
"Effect 10" instead of "ATK is boosted".

Regeneration on a game update (GBFRDataTools = github.com/Nenkai/GBFRDataTools):

    GBFRDataTools.exe extract-all -i <game>/data.i -f system/table/text/ -o <tmp>
    GBFRDataTools.exe extract -i <game>/data.i -f system/table/status.tbl -o <tmp>
    GBFRDataTools.exe tbl-to-sqlite -i <tmp>/system/table -o <tmp>/status.sqlite -v <game-version>
    python scripts/gen-status-names.py <tmp>/status.sqlite <tmp>

Two text ids name each status and the table only points at one of them.
`StatusName` is the DESCRIPTION ("ATK is boosted"); swapping its `TXT_STATE_` /
`TXT_STATUS_` prefix for `TXT_STTTL_` (or `TXT_STATTL_`) gives the TITLE the game
puts on the buff icon ("ATK↑"). The title is what a table row wants, so it wins;
the description is the fallback for the handful of statuses that have one but no
title, because a long name beats a bare id.

Roughly 90 of the 168 statuses have neither. They are internal (`nayde1`,
`mspl1900_01`, and rows with no StatusName at all) and are omitted rather than
written with an empty string — the UI's own "Effect <id>" fallback is better
than a blank row, and a missing key is what triggers it.
"""

import json
import sqlite3
import sys
from pathlib import Path

import msgpack

LANG_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "lang"

# Game locale folder -> this repo's lang folder. Mirrors LocaleMap in
# GBFRDataTools' gen-langfiles so the two produce the same tree.
LOCALES = {
    "en": "en",
    "jp": "jp",
    "ko": "ko",
    "fr": "fr",
    "ge": "ge",
    "it": "it",
    "es": "es",
    "bp": "bp",
    "cs": "zh-CN",
    "ct": "zh-TW",
}

TITLE_PREFIXES = ("TXT_STTTL_", "TXT_STATTL_")
NAME_PREFIXES = ("TXT_STATE_", "TXT_STATUS_")


def read_msg(path: Path) -> dict[str, str]:
    """id_hash_ -> text_ for one .msg text table (plain MessagePack)."""
    doc = msgpack.unpackb(path.read_bytes(), raw=False, strict_map_key=False)
    rows = doc.get("rows_")
    if not rows:
        return {}
    return {row["column_"]["id_hash_"]: row["column_"]["text_"] for row in rows}


def display_name(text: dict[str, str], status_name: str) -> str:
    """The title if the game has one, else the description, else empty."""
    for name_prefix in NAME_PREFIXES:
        if not status_name.startswith(name_prefix):
            continue
        suffix = status_name[len(name_prefix) :]
        for title_prefix in TITLE_PREFIXES:
            title = text.get(title_prefix + suffix, "").strip()
            if title:
                return title
    return text.get(status_name, "").strip()


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(f"usage: {sys.argv[0]} <status.tbl sqlite db> <extracted game root>")

    db = sqlite3.connect(sys.argv[1])
    extracted = Path(sys.argv[2])
    statuses = db.execute(
        "SELECT StatusId, StatusCodeName, StatusName FROM status ORDER BY StatusId"
    ).fetchall()

    for game_locale, out_locale in LOCALES.items():
        msg_path = extracted / "system" / "table" / "text" / game_locale / "text_status.msg"
        if not msg_path.exists():
            print(f"[{game_locale}] no text_status.msg, skipped")
            continue

        text = read_msg(msg_path)
        out: dict[str, dict[str, str]] = {}
        for status_id, code_name, status_name in statuses:
            name = display_name(text, status_name or "")
            if not name:
                continue
            # `key` is the game's own code name, kept for the same reason
            # enemies.json keeps EM####: it is what makes a diff readable when
            # a patch renumbers something.
            out[str(status_id)] = {"key": code_name or status_name or "", "text": name}

        out_path = LANG_DIR / out_locale / "statuses.json"
        out_path.write_text(
            json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        print(f"[{game_locale} -> {out_locale}] wrote {len(out)} statuses to {out_path}")


if __name__ == "__main__":
    main()
