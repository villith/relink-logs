# The World (EM8300) native-arena data map — 2026-07-28

Complete inventory of what The World's own quest sets up, versus what our
Conflux World rooms provide. Built from `data.i.orig-202` extractions;
tooling and working notes in session 24a3fbfc scratchpad `worldgate/`.

## 1. The quest itself

Two quest variants share arena pa50: **40a301** (solo) and **40b301**
(online; own baseinfo/sectionlist/FSM set, same structure).

### quest/ex/40a301/baseinfo.msg — orchestration fields

| field | value | meaning |
|---|---|---|
| `enemyIds_[0]` / `enemyNum_[0]` | `164608` / `1` | **only EM8300 is registered** — EM8301 is NOT in the roster |
| `enemyIds_[1..5]` | `-1` | — |
| `isQuestStartFromBossAppear_` | `true` | boss-appear prologue flow |
| `exPlacementFilesInfo_.suffix_` | `["40a301"]` | loads `layout/pa50/placement_multi_40a301.scene.msg` |
| `fsmDataList_` | 7 layers | see below |
| `preLoadVoiceEventFileInfos_` | VT_MS72_4xxx banks per layer | story-72 voice lines |
| `startEventInfo_`/`endEventInfo_` | 0/0 | no bracketing cutscene events |

### The 7 quest FSM layers (names decode the fight structure)

| layer | name (ja) | meaning |
|---|---|---|
| 0 | メイン進行 | main progression — the orchestrator |
| 1 | ボイス演出HP判定 | voice at HP thresholds |
| 2 | デビル顕現時ボイス演出 | voice when the **Devil form manifests** (= EM8301) |
| 3 | 球体戦ボイス演出 | voice for the **orb-battle phase** |
| 4 | タロット出現時ボイス演出 | voice when **tarot cards** appear |
| 5 | OD必殺ボイス演出 | overdrive-ultimate voice |
| 6 | 奥義ボイス演出 | ougi voice |

Layer 0 nodes of note: `StartQuestPrologueAction`, **`BossAppearAction` ×2**
(distinct `mainBossUUID_` 8368956767859883644 / 7985114503207374634 — two
appearances, presumably base form and Devil form), `ChangeTargetTask`,
`OnBossDeadAction`, `ControlQuestTimerAction`, `bossEndPointIdHashs_`,
`isBossBattle_=true`. Layers 1–6 are presentation (voice cues keyed to
fight events).

**`mainBossUUID_` is an opaque binding**: the values appear nowhere in the
placement, sectionlist, baseinfo, or elsewhere in the FSM (checked u64 cf and
digit-string encodings). Resolving what they reference needs Ghidra
(BossAppearAction handler), not more file archaeology. `subBossUUID_`
= 4068758251509437051 in BOTH this quest and Conflux 84f000 → a "none"
sentinel, not a real binding.

### layout/pa50/placement_multi_40a301.scene.msg — full node tree

```
mt=11 v0=0        @ (20.2, 0, -8.7)      (unknown marker)
mt=4  v0=1        @ (0, 0, 0)            player spawn
mt=12 v0=0xa50    @ ~origin              area marker (value = area id)
mt=0 group 12779573806575358073
  └ mt=1 v0=0x8300 @ (0,0,0)             The World, base form
mt=0 group 12779573806575358073 (same hash)
  └ mt=1 v0=0x8301 @ (0.1,-0.1,0)        The World, Devil form
mt=12 'LightOnStart'     0xfff9 @ (20.2,0,-8.7)   lighting cues
mt=12 'LightOnClear'     0xfffa @ (20.2,0,-8.7)
mt=12 'LightOnBossStart' 0xfffb @ (0,0,0)
mt=12 'LightOnBossEnd'   0xfffc @ (0,0,0)
```

No warp-anchor nodes exist — scripted-move positions are NOT in the placement.

### Boss actor assets (loaded by actor id, not by quest)

- `em/em8300/` 872 files, `system/FSM/em8300/` 70, `system/behaviortree/em8300/` 15,
  `effect/savedata/em8300/` 310, lipsync banks, `system/camera/data/em8300_*.msg`
  19 camera scripts (comet, double_laser, hangedman, …).
- **EM8301 owns almost nothing** — a single `system/finishcamera/em8301/` file.
  The Devil form is a second actor id riding the em8300 asset package.
- `enemy_status_endlessmode` ships full stat curves for BOTH EM8300 and EM8301
  (and the EM8400/8401 pair) — endless-mode groundwork existed.

### Area pa50 (all present, all load fine — proven live)

`world_common_00/light/localibl/wind`, `effect/effect_common`,
`placement_ui_info`, `filter/pa50/world_00.ccomp`, `pha/pa50/*` (collision),
skycube `sky_pa50_worldst_cosmo_00*`. pa50 has NO `placement_endlessmode*`
files (one of very few areas without) — proven unnecessary for room load.

## 2. Conflux-native raid hosting: room 84f000 (vanilla Beelzebub, flawless)

- baseinfo: `isQuestStartFromBossAppear_=true`, explicit `enemyIds_[0]`=EM8200
  (one of only TWO rooms with explicit enemyIds in vanilla Conflux).
- FSM layer 0: **`BossAppearAction` with `mainBossUUID_`=6062918349335782374**
  (also not found in its placement — same opaque binding),
  `CheckReceptionState`, `bossEndPointIdHashs_=0`.
- placement: EM8200 ×2 (same id, one spawn) near origin + 8 portal-ring props.

## 3. Our five World rooms (deployed state) and the gap list

Deployed: sectionlist+FSM phaseNo→pa50; placement with EM8300 @ (0,0,-12.4)
+ EM8301 @ (0.1,-0.1,-12.4); baseinfo registers BOTH 164608 and 164609;
targetList type-3 id = 164608. Normal gate flow (no boss-appear).

| # | gap vs native | severity | note |
|---|---|---|---|
| 1 | No `BossAppearAction`/`mainBossUUID_` binding (quest AND 84f000 both have it) | **likely the phase-behavior culprit** | binding target unresolved — Ghidra or the 84f000-donor-FSM route |
| 2 | We register EM8301 in enemyIds; the quest does NOT | unknown | quest may script-spawn the Devil form; ours may spawn it as an independent mob — watch next run |
| 3 | Quest FSM layers 1–6 absent | cosmetic | no phase voice lines |
| 4 | preLoadVoice banks absent | cosmetic | silent phases |
| 5 | Lighting cues 0xfff9–fffc absent | cosmetic | no mood shifts |
| 6 | mt=11 / mt=12 0xa50 markers absent | unknown | purpose undecoded |
| 7 | Boss-appear prologue flow absent | moderate | 84f000 and the quest both use it; our gates spawn the boss as a plain mob |

## 4. Recommended next step

Convert the World rooms to the **84f000 donor pattern** (Conflux's own proven
raid hosting): donor FSM re-identified per room (recipe exists from the
84e010→pa70 clone: subcategory/index + 3 section-uuid fields via positional
scanner), `isQuestStartFromBossAppear_="true"`, keep our pa50 placement.
Open question to resolve first (one Ghidra session): what `mainBossUUID_`
references, so the binding can be pointed at our EM8300 node — or proven
irrelevant (84f000's value may bind "the placed boss" generically).

> **DONE 2026-07-28 evening — build6 deployed (live pending).** The Ghidra
> session proved `mainBossUUID_` is a self-registered handle (the appear flow
> registers the spawned boss under the FSM-declared value; any value works),
> so the donor conversion keeps 84f000's uuid verbatim. All five rooms
> converted; `enemyIds_[1]` reverted to `-1` (gap #2 resolved: match the
> quest's single-registration). Gaps #1 and #7 closed. Details in
> `world-boss-binding-ghidra-handoff.md` § RESOLUTION.
