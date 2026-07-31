# Character icons

Per-character icons extracted from the game archive, named by the `Pl####` id
used as the key in `src-tauri/lang/<lang>/characters.json` — so
`characters.json["Pl1400"]` names `Pl1400.png`.

| Folder        | Files | Size    | What it is                                               |
| ------------- | ----- | ------- | -------------------------------------------------------- |
| `mini/`       | 32    | 192×255 | **Painted bust icons** — the menu icons (cropped, below) |
| `mini-small/` | 32    | 128×132 | Tighter, smaller bust of the same characters             |
| `mini02/`     | 68    | 128×128 | Close-up face crops, two expressions each (`_00`, `_01`) |
| `linklevel/`  | 35    | 216×88  | Diagonal-cut face crop from the link-level HUD           |

All RGBA with real alpha. `mini/` is almost certainly the set you want for
general UI; `linklevel/` is a HUD element and is shaped for a slanted frame,
not a square one.

`mini/` is the one family that is **not** exactly as extracted. The atlas frames
every bust on a 256×264 canvas with a different amount of transparent margin
around each one — 130×181 of art for Katalina against 222×231 for Id — and that
margin is dead width in the meter, where the icon is sized from the bar height.
`scripts/crop-character-icons.mjs` cropped all 32 to one shared 192×255 rect at
+33+5, chosen to spend a little clipping on the widest few (17px off one side of
Pl2200 and Pl2900, 1–7px on eight others) in exchange for a box a quarter
narrower for everybody. One rect rather than a per-file trim, so the characters
keep their sizes relative to each other. Re-run the script after any
re-extraction; it is idempotent and prints the App.css ratio to match.

These are **extracted game assets**, © Cygames / PlatinumGames. They are not
covered by this repository's licence. Treat them the way the generated lang
files are treated: fine for the app to display, not ours to relicense.

## Coverage

`mini/` and `mini-small/` cover the 32 ids `Pl0000`–`Pl2900` including the
`Pl0001` / `Pl0101` / `Pl1901` variants. `mini02/` adds `Pl1101` and `Pl1102`
(34 ids × 2 expressions). No family contains `Pl2000` — the id the parser
remaps to `Pl1900` for recruited Id — so fall back to `Pl1900` for it.

Ids with no `characters.json` entry (`Pl0001`, `Pl0101`, `Pl1101`, `Pl1102`,
`Pl1901`) are story/alternate variants the lang table does not name.

## Where they come from

`mini`, `mini-small` and `mini02` are all sprites packed into the single atlas
`ui/atlas/common_icon_mini.wtb` (2048², BC7). The sprite table lives in the
companion `ui/atlas/common_icon_mini.tex.texb`, which decodes to YAML with one
entry per sprite:

```yaml
- Name: cmn_mini_pl0000_1
  Rect: 0, 0, 256, 264 # destination canvas
  Padding: 54.05, 18.04, 50.03, 35.09
  Uv: 0.58447266, 0.10888672, 0.6586914, 0.21191406
```

`linklevel/` is separate — see the per-file textures under
`ui/layouts/hud/linklevel/noatlastextures/hud_lnklv_pl<NNNN>.wtb`.

### Two things that will bite you

1. **`Uv` uses a bottom-left origin.** Crop `y` from
   `(1 - v1) * height` to `(1 - v0) * height`. Taking the UVs at face value
   silently yields blank or half-overlapping sprites — it fails quietly,
   because the wrong rect is still a valid rect.
2. **`Rect`, `Uv` and `Padding` share one field order:** `(x0, y0, x1, y1)` in
   that same bottom-left space, i.e. **`(left, bottom, right, top)`**. So the
   trimmed art goes at `(Padding[0], Padding[3])` on a `Rect`-sized canvas.

   This second point is an inference, not something the format states. It is
   consistent with `Rect`/`Uv` and with `Padding[0] + crop_w + Padding[2]`
   equalling the canvas width exactly (likewise for height), and the output
   looks correctly framed. But the only sprites that could have proved it —
   the untrimmed `mini-small` set — turned out to be separately-authored art
   rather than a half-scale copy, so nothing independently confirms it. If a
   `mini/` icon ever looks ~17px low, swap to `Padding[1]` as the top margin.

   `mini-small` and `mini02` have all-zero padding, so they are unaffected
   either way.

## Regenerating after a game patch

Needs [GBFRDataTools](https://github.com/Nenkai/GBFRDataTools) built (`dotnet
build GBFRDataTools.sln -c Release`) and `texconv.exe` from that repo's
`ImageSharp.Textures/tests/Tools/`.

```sh
GAME="G:/SteamLibrary/steamapps/common/Granblue Fantasy Relink/data.i"

GBFRDataTools.exe extract -i "$GAME" -o out -f "ui/atlas/common_icon_mini.wtb"
GBFRDataTools.exe extract -i "$GAME" -o out -f "ui/atlas/common_icon_mini.tex.texb"

# sprite table -> YAML
GBFRDataTools.exe b-convert -i out/ui/atlas/common_icon_mini.tex.texb

# atlas -> .dds -> .png. Do NOT pass -o to tex-to-dds: with one texture per
# file it writes every result to that single path and you keep only the last.
GBFRDataTools.exe tex-to-dds -i out/ui/atlas
texconv.exe -ft png -o out -y out/ui/atlas/common_icon_mini.dds
```

Then slice per the YAML, honouring both gotchas above.

Note `ui/fhd/atlas/...` holds the **half**-resolution copies despite the "fhd"
name; `ui/atlas/...` is the full-size set.
