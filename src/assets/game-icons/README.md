# Game UI icons

Per-sprite icons sliced out of the game's UI atlases, plus the generated maps
that connect them to the ids the app already speaks. Four families ship:

| Folder     | Files | Size             | Keyed by                                                |
| ---------- | ----- | ---------------- | ------------------------------------------------------- |
| `status/`  | 159   | 128×128, 0.9 MB  | atlas icon name (`str_000`…), via `status-map.json`     |
| `ability/` | 244   | 128×128, 6.3 MB  | character id + ability slot (`pl0900_03.png`)           |
| `sigil/`   | 52    | 128×128, 0.5 MB  | shape series 1–5 × tier 0–4 (+`_plus`, `_ex01`, `_chr`) |
| `enemy/`   | 55    | ~136×136, 1.5 MB | em id (`em7700.png`), via `enemies.json`'s hash → key   |

All palette-quantized (256 colours) by the generator; the lossless originals
live in the local `icon-export/` dump.

Lookups live in `src/statusIcon.ts`, `src/abilityIcon.ts`, `src/sigilIcon.ts`
and `src/enemyIcon.ts`; the analysis view's per-row resolution is
`src/pages/logs/view/analysis/rowIcon.ts`.

These are **extracted game assets**, © Cygames / PlatinumGames. They are not
covered by this repository's licence — fine for the app to display, not ours
to relicense. (Same treatment as `src/assets/character-icons/`.)

## How each family maps to app ids

- **status** — the frontend's currency is the numeric `statusId` (the same id
  space as `src-tauri/lang/<lang>/statuses.json` and the hook's status
  events). `system/table/status.tbl` maps each `StatusId` to an
  `IconFileNameId` such as `wkn_004`, and several statuses share one icon, so
  the files are stored once under the atlas name and `status-map.json`
  (generated, do not hand-edit) carries the id → name edge. Every id in
  `statuses.json` resolves today; `statusIcon.test.ts` keeps it that way.
  Only the `_00` sprite of each icon ships — the `_01`+ level variants (66
  icons have them, up to `_14`) stay in the local `icon-export/` dump until
  something displays stack levels.

- **ability** — the sprites are named by the game's own `AB_PL####_NN` scheme
  from `ability.tbl` (character id + equip-slot number), and
  `ability-map.json` (generated, do not hand-edit) bridges the meter's
  per-character **action ids** to them: `characterType → actionId → icon file
name`. The bridge comes from two independent streams of game data —
  `system/player/data/pl####/pl####_action.msg`, whose `ActionInfo` rows tag
  ability actions with their `abilityTag_`, plus an English-name join
  (`text.msg` `TXT_AB_*` names against ui.json `skills.<Char>` action names)
  for the variant actions the tags skip. Both resolve slot → icon through
  `ability.tbl`'s `IconFileName`, which is not the identity map (Seofon's
  upgraded slots reuse base art; Id's dragonform slots scatter, e.g.
  `AB_PL2000_02` → `2000_05`). Every disagreement between the streams is
  adjudicated by ability name and printed by the generator — the known one is
  Io's empowered Gravity Well rows carrying Gran's Decimate tag, dev
  copy-paste junk. An action with no entry is genuinely not an ability cast
  (combos, link attacks, procs). Lookups: `abilityIconUrl(char, slot)` and
  `abilityIconForAction(char, actionId)`.

- **enemy** — the em-numbered portraits packed into the SUMMON atlas: Relink's
  summons are the primal-beast bosses, so their equip-screen art doubles as
  enemy portraits for the boss roster (43 of the 134 named enemies; trash mobs
  have no art anywhere — the bestiary renders live 3D models). Keyed by em id;
  the wire `EnemyType` hash resolves through `enemies.json`'s `key` field.
  Base form (`_00_00`) only. Lookup: `enemyIconUrl(enemyType)` in
  `src/enemyIcon.ts`.

- **sigil** — `gem.tbl` has no icon column; the shape choice lives in
  `skill.tbl`, which GBFRDataTools cannot parse at game version 2.0.3 ("table
  larger than expected" — its headers are stale). So the sprites ship under
  their visual recipe (`<shape>_<tier>` plus variant suffixes) and
  `sigilIconUrl(shape, tier, {plus, ex, chr})` spells that recipe. Variants
  only exist at the tiers the game draws them at; `undefined` is data.

## Regenerating after a game patch

Everything below `icon-export/` is a local gitignored scratch dump. Needs
[GBFRDataTools](https://github.com/Nenkai/GBFRDataTools) built and
`texconv.exe` from that repo's `ImageSharp.Textures/tests/Tools/`. The two
UV/padding gotchas from `src/assets/character-icons/README.md` apply and are
already encoded in `scripts/slice-atlas.mjs`.

```sh
GAME="G:/SteamLibrary/steamapps/common/Granblue Fantasy Relink/data.i"
RAW=icon-export/raw

# 1. atlases + sprite tables (156 pairs at ui/atlas root; lang subdirs unused)
GBFRDataTools.exe extract-all -i "$GAME" -o $RAW -f "ui/atlas/" --overwrite

# 2. sprite tables -> YAML, atlases -> dds -> png (texconv writes .PNG)
for f in $RAW/ui/atlas/*.texb; do GBFRDataTools.exe b-convert -i "$f"; done
GBFRDataTools.exe tex-to-dds -i $RAW/ui/atlas     # no -o: one output per input
for f in $RAW/ui/atlas/*.dds; do texconv.exe -ft png -o $RAW/ui/atlas -y "$f"; done

# 3. the id tables (game version = the exe's ProductVersion)
for t in status ability gem gem_type item summon weapon chara chara_icon; do
  GBFRDataTools.exe extract -i "$GAME" -o $RAW -f "system/table/$t.tbl"
done
GBFRDataTools.exe tbl-to-sqlite -i $RAW/system/table -v 2.0.3 -o $RAW/tables.sqlite

# 3b. inputs for ability-map.json: per-character action tables + ability names.
# Archive paths are case-sensitive; most live under lowercase data/, a few
# under Data/ — try both, exactly one matches.
GBFRDataTools.exe extract -i "$GAME" -o $RAW -f "system/table/text/en/text.msg"
for pl in pl0000 pl0100 ... pl2900; do   # every playable id incl. pl2000
  GBFRDataTools.exe extract -i "$GAME" -o $RAW -f "system/player/data/$pl/${pl}_action.msg" ||
  GBFRDataTools.exe extract -i "$GAME" -o $RAW -f "system/player/Data/$pl/${pl}_action.msg"
done

# 4. slice the families this app uses (add more as needed)
node scripts/slice-atlas.mjs --atlas $RAW/ui/atlas/common_icon_status.PNG  --out icon-export/sliced/status
node scripts/slice-atlas.mjs --atlas $RAW/ui/atlas/common_icon_ability.PNG --out icon-export/sliced/ability
node scripts/slice-atlas.mjs --atlas $RAW/ui/atlas/common_icon_equip.PNG   --out icon-export/sliced/equip
node scripts/slice-atlas.mjs --atlas $RAW/ui/atlas/common_icon_summon.PNG  --out icon-export/sliced/summon

# 5. select + rename + regenerate the maps into src/assets/game-icons
node scripts/gen-game-icons.mjs
```

Then `npx vitest run src/statusIcon.test.ts src/abilityIcon.test.ts
src/sigilIcon.test.ts` — the tests are the coverage check: a patch that adds a
status the icons don't cover, or renames an icon id, fails there and not in
production.

## What else the dump holds

`icon-export/sliced/` also has un-shipped families cut from the same
extraction — `item` (626, keyed by `item.tbl` `IconFileName2`), `summon`
(476), `skill` (82), `lb`/`lb02`/`sboard` (mastery + limit-bonus art), `main`,
`endl-buf`/`bufcard` (Endless mode), `weapon` (blacksmith scenery; actual
weapon icons are the 4-digit sprites in `sliced/equip`). Promote one by adding
an `emitFamily` call (and a map, if its table has the edge) to
`scripts/gen-game-icons.mjs`.

`ui/fhd/atlas/...` in the archive holds **half**-resolution copies despite the
"fhd" name; `ui/atlas/...` is the full-size set this pipeline reads.
