# Handoff — Conflux "Unbound" mod (GBFR: Relink, Endless Ragnarok v2.0.2)

Last updated 2026-07-28. Written for an agent picking this up cold.

Durable background lives in the memory notes `gbfr-endlessmode-data-tables` and
`gbfr-conflux-endless-mode`. **Read both before touching anything.**

Follow-on docs in this directory: `world-arena-map.md` (The World native-arena
data inventory) and `world-boss-binding-ghidra-handoff.md` (the active Ghidra
investigation into BossAppearAction/mainBossUUID_ boss binding).

`<scratchpad>` below always means
`C:\Users\Scott\AppData\Local\Temp\claude\C--Users-Scott-Projects-gbfr-logs\4598cb29-8afd-4d76-bfa2-ad64be566f4e\scratchpad`
(contents listed in §6).

---

## 1. Goal

The Conflux roguelike mode is internally codenamed **EndlessMode**. The shipped game caps it
at five finite "Cycles" (Cycle 5 = levels 210–230), but the data files define enemy stat
curves to **level 500** — abandoned scaling groundwork. The user wants that range enabled,
the mode made significantly harder, and the result packaged as a public Reloaded-II mod.

Everything so far is **data-only**: loose files under `<game>/data/` plus a rebuilt `data.i`
index. No code mods.

## 2. Current state

Deployed to the user's game and confirmed working in a live run:

| Change | File | Detail |
|---|---|---|
| Cycle 5 levels 400 / 450 / 500 | `system/table/endlessmode_difficulty.tbl` | Cycle 5 row (Key `26810EEA`): `EnemyMinLevel=400`, `Unk6=50`, `EnemyMaxLevel=500`. Level 400 observed live. |
| Boss swap, 13 rooms | `layout/<area>/placement_endlessmode_<room>.scene.msg` | Beelzebub observed live in room 84e010. See §4. |
| Stat curve, levels 310–500 | `system/table/enemy_status_endlessmode.tbl` | Per enemy: anchor = its max Hp/Attack at level ≤300; HP ×3/×6/×12 and Attack ×3/×5/×8 at 400/450/500. **CONFIRMED live for trash (f32-exact); boss gates bypass it — see Task 1.** |
| Global enemy tuning ×1.25 | `system/table/endlessmode_enemy_adjust.tbl` | Columns `Unk2`, `Unk3` ×1.25. Applies to **all** cycles, not just 5. |
| **v1.8 (2026-07-28 12:52, live pending):** gate-boss band | `enemy_status_endlessmode.tbl` rows 250–300 | All 166 keys: `Hp=anchor×6÷0.81`, `Atk=anchor_atk×5÷0.81` → gates land on the leg-2 targets (Beelzebub gate 9.38B). See Task 1. |
| **v1.8:** arena-safe boss placement | 3 placement scenes reverted to pristine | 84e010→EM0500, 84f010→EM1806, 84f000→EM8200 (Beelzebub native pa70). See Task 2. |

> **2026-07-28 ~14:30 SUPERSEDED IN PART — "World native arena" project.** The user
> rejected foreign-arena bosses entirely; new goal: **the leg-1 boss gate is always The
> World (EM8300) in his native pa50 arena**, everything else vanilla. Tasks 2–4 below are
> superseded (kept for context); Task 1's stat work stays live. Deployed same day (all
> verified on disk, +16 B index): 84a020 relocated in place to pa50 (sectionlist phaseNo
> "1536"→"2640", FSM phaseNo_ cd0600→cd0a50, NEW `layout/pa50/placement_endlessmode_84a020
> .scene.msg` with both enemies →0x8300 and origin-centered coordinates grafted from the
> pa50 quest + 84f000 geometry), 10 v1.7 placements + 15 gate baseinfos reverted to
> pristine (84e010's task34 pa70-clone kept, per user). **KEY DECODES:** the gate lottery
> is NOT loc-banded — `areaSubCategory_` bit 12/13/14 = leg-1/leg-2/leg-3 gate pool
> (leg-1 pool: 846020, 846030, 847010, 847020, 849020, 84a020, 84e010); placement
> coordinates are area-specific world positions (pa50 and pa70 are origin-centered);
> subPhaseHash 528045455 is shared by p600/pa70/pa50 so 84a020 needed no change. Spec:
> `docs/superpowers/specs/2026-07-28-world-native-arena-leg1-gate-design.md`; working
> notes + backups: session 24a3fbfc scratchpad `worldgate/` (candidates.md, coords.md,
> pa50-support.md, NOTES.md; revert = `backup/deployed/` + `backup/data.i.bak-pre-poc`).
> **Phase 3 DEPLOYED same day ~15:00 (live pending), user skipped PoC gating:** all five
> SIMPLE leg-1 rooms (84a020, 847010, 847020, 849020, 84e010) relocated to pa50 + EM8300
> (p400 pair also needed subPhaseHash → "528045455"); the two COMPLEX p300 rooms
> (846020/846030, multi-encounter placements) dropped from Cycle 5 instead
> (`newModeDifficulty_` "20"→"04", C3 kept — leading-zero parse unverified, watch it).
> 84e010's task34 pa70-Beelzebub clone was removed (pristine-rebuilt). **Every Cycle-5
> first boss gate is now The World in pa50**; lower cycles can also draw the World rooms
> (masks untouched, user-accepted). data.i = 13,549,993 (+16, then +64); chunk-1 audit
> passed both rebuilds. Backups: worldgate/backup/{deployed,deployed-phase3,
> data.i.bak-pre-poc,data.i.bak-pre-phase3}.
> **First live result + fix (same day ~15:4x):** pa50 arena loads, player spawns, but NO
> boss — root cause: pristine `enemyIds_[0]` is `-1`, and a RAID boss named only in the
> placement silently fails to spawn. The placement picks identity, but raid bosses must
> also be DECLARED in `enemyIds_`/`enemyNum_` (vanilla corroboration: 84f000, the only
> raid-boss room, is one of only two rooms with explicit enemyIds_). `targetList` type-3
> `id_` is the Defeat-objective target and must match too. Fix staged for all 5 World
> rooms (enemyIds_[0]="164608", enemyNum_[0]="1", t3 id_="164608"), auto-deploys via
> watcher when the game closes. This CORRECTS §8's "enemyIds_ dead end" — it is not an
> identity selector, but it IS the spawn-registration list.

Two problems remain open, both from the same live run:

1. ~~Beelzebub's HP read ~1.3B at level 400, but the deployed curve specifies 4.69B.~~
   **SOLVED 2026-07-28 from stored logs (no run spent)** — the curve is live for trash,
   but boss-gate rooms bypass the leg level and read the **@250 row × 0.81** instead.
   See Task 1 for the finding and the fix.
2. Beelzebub warped **out of bounds** casting Smothered Mate in a foreign arena (Task 2).

**Reverted, do not reintroduce:** padding `endlessmode_set_portal` legs from 5 to 8 phases.
It creates a portal with no destination room — an invisible portal that soft-locks the run.
Run length is bounded by the `lotterylocation_` graph, not by `set_portal`.

## 3. Verified mechanics

Every claim below is live-verified or checked against every room in the data.

**Level per leg.** `level(leg N) = EnemyMinLevel + Unk6 × (N−1)`, constant within a leg. No
runtime clamp; `EnemyMaxLevel` is display metadata. Exceeding the stat table's top breakpoint
(500) makes interpolation fall back to the **level-1** row — legs of 210/500/790 spawned
level-1 enemies in leg 3. Invariant: `EnemyMinLevel + Unk6 × 2 ≤ 500`.

**Only Hp and Attack scale with level, game-wide.** The whole `enemy_status_*` family
(easy/hard/extrem/chaos/endlessmode) shares that two-column schema, both int64. Attack rates,
cooldowns and aggression live in per-enemy behavior trees, and level never touches them.

**Rooms are mini-quests** at `quest/ex/<stageid>/baseinfo.msg` (MessagePack). The `endless_`
block holds `newAreaCategory_` (4 = boss room), `newModeDifficulty_` (cycle **bitmask**,
16 = Cycle 5), `lotterylocation_` (slot in the run graph), `enemyIds_[0..5]`, `enemyNum_[]`
and `overwriteStatusAndReward_[]`.

**The spawned enemy comes from the placement scene, not the baseinfo:**

```
layout/<area>/placement_endlessmode_<room>.scene.msg
  └─ PlacementInfo (memberType_ == 1)
       └─ values_[0] = RAW EM id        // 0x500 = EM0500, 0x1900 = EM1900
```

Note the encoding: **raw**, with no `0x20000` offset (baseinfo ids carry one). Verified on
21/21 boss rooms — each holds exactly its vanilla boss, and 84f000 holds EM8200 twice.

**A room's arena is its `phaseNo`, read as hex.** `2304 = 0x900` → `layout/p900`;
`2672 = 0xa70` → `layout/pa70`. Verified on 78 of 79 Conflux rooms; the lone exception,
8a8002, files its placement under a different folder than its phase. `stagename.tbl`
corroborates this — its `PhaseId` column holds the same values (`00000150` ↔ p150).
`phaseNo` appears in two files that must agree:

| field | file |
|---|---|
| `SectionList[0].Section.phaseNo` | `quest/ex/<room>/sectionlist.msg` |
| `BeginSection.phaseNo_` | `system/fsm/quest/quest_<room>_0_ex_fsm_ingame.msg` |

The identity triple category/subcategory/index matches across the FSM, the sectionlist and
baseinfo's `category_`/`subCategory_`/`serialNumber_` (84e010 = 8/78/16 in p900;
84f000 = 8/79/0 in pa70).

**Native arenas** of the four swap bosses, traced through each boss's own quest
(`quest/ex/<id>` → `exPlacementFilesInfo_.suffix_` → `layout/<area>/placement_multi_<suffix>`):

| boss | native quest | native area | Conflux room in that area? |
|---|---|---|---|
| Beelzebub EM8200 | 40a314 / 40b314 | **pa70** | **yes — 84f000 (loc 54)** |
| The World EM8300 | 40a301 / 40b301 | pa50 | no |
| Bahamut Versa EM7600 | 40a309 / 40b309 | p701 | no |
| Lucilius EM7700 | 40a313 / 40b313 | p730 | no |

Conflux uses only p101, p150, p300, p400, p450, p502, p600, p900, pa20, pa30, pa70.

**Boss ids:** Bahamut Versa EM7600, The World EM8300, Beelzebub EM8200, Lucilius EM7700.
Vanilla Conflux gate bosses are "Conflux/Convergent" *variants* (`TXT_EM####_NN` name rows),
e.g. Conflux Rock Golem EM1500, Convergent Sequestration EM7300. Resolve any EM id to a name
through `src-tauri/lang/en/enemies.json`, whose keys are actor hashes and whose values carry
`{"key": "EM1500", "text": "Rock Golem"}`.

## 4. What is deployed, room by room

v1.7 patched `values_[0]` in 13 of the 16 Cycle-5 gate rooms. Rooms 843000, 843020 and 849000
own no placement scene, so they still serve vanilla bosses (Task 4).

| rooms | area | boss now |
|---|---|---|
| 846000, 846020, 846030 | p300 | Bahamut Versa EM7600 |
| 847010, 847020 | p400 | The World EM8300 |
| 849020 | p502 | The World EM8300 |
| 84a000, 84a005, 84a010, 84a020 | p600 | The World EM8300 |
| 84e010 | p900 | ~~Beelzebub EM8200~~ reverted to vanilla EM0500 (v1.8 — OOB warp) |
| 84f010 | pa30 | ~~Beelzebub EM8200~~ reverted to vanilla EM1806 (v1.8) |
| 84f000 | pa70 | ~~Lucilius EM7700~~ reverted to vanilla Beelzebub EM8200 (v1.8 — native arena) |

Rooms 846030 and 84a010 keep a second, unpatched enemy (EM7300 and EM2300), so those gates
may field a companion alongside the new boss.

Backups: `<scratchpad>/placemod_v17/` holds the patched scenes; the pristine originals come
from the archive (§6). Baseinfo backups live in `<scratchpad>/bossmod_v15/backup/` and
`<scratchpad>/control_v16/backup/`.

---

# The plan

Tasks run in priority order. Task 1 blocks the release, because it may mean the difficulty
curve has never applied. Each task states its own acceptance test.

**Every task that writes to `<game>/data/` or `data.i` must run with the game closed.** Use
the watcher pattern in §7. Verify on disk after every deploy; never assume a copy landed.

---

### Task 1 — ~~Determine whether the stat curve reaches runtime~~ RESOLVED 2026-07-28

**Answer: a fourth case none of the discriminator rows predicted.** Solved by decoding the
dev app's `logs.db` (it lives at `src-tauri/logs.db`, next to the running exe — NOT AppData)
with `cargo run -p gbfr-logs --example hp_pools -- --db <copy> --log <id>`, then f32-matching
the per-target max-HP values against both stat tables:

- **Trash mobs: the curve IS live and levels DO resolve at 400.** Observed max HP =
  `f32(cur@400 × 1.25)` bit-exact for EM0701/EM0101/EM0001 across runs 22/23; run 24 shows
  ×1.3125 = 1.25 × **1.05** (per-run package/curse modifiers exist and multiply enemy HP).
  Delivery was never broken; `endlessmode_enemy_adjust` Unk2 is confirmed a live HP multiplier.
- **Boss-gate rooms bypass the leg level.** All three observed gate bosses (runs 18/22/23:
  EM0501, EM0500, EM0102) have max HP = **`f32(table@250 row) × 0.81f`, bit-exact in f32
  arithmetic** for all three. 250 = vanilla Cycle 5's final-leg level, but it is NOT derivable
  from the deployed difficulty row (400/50/500) — it is code-side (not in
  `endlessmode_constant` or the package table; no level field in the gate baseinfos). Gates do
  not get the ×1.25 adjust on top (0.81 is the total multiplier).
- This fully explains the user's "~1.3B Beelzebub": predicted `f32(EM8200@250)×0.81f` =
  **1,266,703,360**.

**VALIDATED 12:52:** run 24's Beelzebub encounter saved as log 662 — max HP
**1,266,703,232**, within one f32 ulp of the prediction (4th independent enemy). Three of the
four datapoints are bit-exact under a **sequential ×0.9 ×0.9 f32 chain** (two stacked 10%
cuts), which is the best-fit op order; 0.81 is the right number for fix math either way.
The run's ×1.05 package modifier did **not** apply to the gate — gates see no run modifiers.
Bonus: `last_current` was 398M (31% HP left) — the fight was abandoned, consistent with the
out-of-bounds warp (Task 2).

**SECOND DISCOVERY 13:30 (run 25, log 665) — gates read the ARCHIVE copy, loose files can
never fix them.** With the v1.8 loose band live, The World (v1.7-swapped into 84a020, p600)
spawned at level 400 with max HP **380,010,976** = `f32(EM8300's ORIGINAL @250 row × 0.81)`
— while the same session's trash read the loose modded curve (`cur@400 × 1.3125`,
values that exist only in the loose file). Two different loads of the same table. The other
five `enemy_status_*` tables and every loose file (all int/float/string encodings) were
swept: the values exist **only** in `enemy_status_endlessmode`'s @250 band. Mechanism:
`data.i`'s `CachedChunkIndices` lists chunks 0–6 as **boot-preloaded**, and the whole
`enemy_status_*` family lives in **chunk 1** — the gate-boss stat path reads the preloaded
archive chunk. (Also learned: the tool's `add-external-files` *removes* a registered file's
archive index entry — `RemoveArchiveFile` — so the loose override is total for index-based
reads; the preload path doesn't go through per-file index entries.)

**ARCHIVE PATCH DEPLOYED 13:40 (v1.9, live pending) — chunk relocation.** Recipe, fully
verified offline then on disk:
1. From the *original* index's debug listings (`list-files` writes `<gamedir>/debug/`):
   the tbl = chunk 1, DecOffset 0x9A270, FileSize 0x3D6B8; chunk 1 = data.0 @ 0xAF3BC1,
   ZSize 0x54F201, USize 0x12C7334 (LZ4 block).
2. Decompress chunk 1 (python `lz4.block`), verify the tbl region byte==pristine, splice in
   the new tbl (same size), recompress (`mode='high_compression'`, `store_size=False` —
   4,401,920 B, smaller than original), roundtrip-check.
3. Append 7 pad bytes + new chunk to the end of `data.0` (new offset 0x2102E30, 16-aligned;
   original bytes untouched — revert = truncate `data.0` to 34,614,825).
4. Patch the chunk-1 struct **in place** in `data.i` (FlatBuffers structs are inline: the
   24-byte record `(u64 FileOffset)(u32 Size)(u32 UncompSize)…` at file offset 116840,
   found by its unique old-value byte pattern) → new offset + new size. Chunk *index*
   unchanged, so `CachedChunkIndices` still covers it.
5. Verify: re-decompress from `data.0` at the new offset (region == new tbl, neighbours
   byte-identical), and tool-extract a chunk-mate (`enemy_status_chaos.tbl`) through the
   patched index — md5 equal to the pre-patch extraction.
The deployed tbl content = v1.8 band **plus EM8300's rows normalized to the uniform
11,583,936,000 / 972,222** (his endless anchor is tiny, 469M — anchor×6 would have left The
World gates at 2.8B). Loose copy updated to the identical content. Backups:
`<scratchpad2>/archpatch/data.i.bak-pre-archpatch`, staged artifacts in
`<scratchpad2>/archpatch/`.

**Expected next run:** gate bosses ≈ **9.38B HP** (band row × 0.81; Versa 12.4B) with
~787K attack. If a gate still shows an orig-derived value, the gate source is a third copy
and needs the hookdiag needlescan treatment — but the preload theory fits all evidence.

**Run 25 note (corrected twice):** The World's 84a020 fight was killed in 67s. I first
wrongly inferred "foreign-arena-safe" from the completed kill; the user then confirmed the
opposite — **The World DID have issues in the foreign arena** (user report, 13:5x), joining
Beelzebub (out-of-bounds in p900) as arena-sensitive. **Per the user's explicit decision,
The World stays deployed anyway — do not revert those rooms without being asked.** General
rule now in memory: a completed kill in the parser log never establishes behavioral safety;
gameplay behavior is user-confirmed or UNVERIFIED. Versa and Lucilius remain untested in
foreign arenas.

**The fix (now the real Task 1 work):** rewrite the **230–300 band** of
`enemy_status_endlessmode` for the boss/raid enemies to `target ÷ 0.81`. Cycle 4 caps at
level 220, so rows ≥230 leak into no other cycle; with legs at 400/450/500 the band is
otherwise dead — only the gate lookup reads it. Cover the whole band, not just @250, so the
fix survives the level source being cycle- or slot-dependent. Scale Attack in the same rows
(gates currently hit with @250 attack ≈ vanilla, which is why they feel soft in both
directions). Note the 07-11 vanilla logs (Beelzebub kills ≈745M) do NOT fit @250×0.81, so the
gate level probably varies per cycle — irrelevant for the Cycle-5 fix, but do not "fix"
other cycles' gates blind.

- [x] Step 1–3: exact numbers recovered from stored logs; discriminator superseded.
- [x] **Step 4: recorded** in `gbfr-endlessmode-data-tables` (2026-07-28 entry).
- [ ] **Step 5: confirm run 24's Beelzebub HP** against the two predictions above when the
      encounter saves.
- [x] **Step 6: DEPLOYED 2026-07-28 12:52** (game closed, md5-verified on disk; pre-deploy
      backups in `gatefix/predeploy-backup/`). Only the live gate check remains. BUILT AND STAGED
      2026-07-28 at `<scratchpad2>/gatefix/` (`<scratchpad2>` =
      `C:\Users\Scott\AppData\Local\Temp\claude\C--Users-Scott-Projects-gbfr-logs\0cebe932-f8b4-43e9-b82a-c02bcb62f534\scratchpad`):
      rows **250–300** (not 230/240 — the 07-11 vanilla Beelzebub kills ≈744M ≈ @240×0.5,
      so Cycle-4 gates may read @240; left untouched) set for **all 166 keys** to
      `Hp = anchor×6 ÷ 0.81`, `Attack = anchor_atk×5 ÷ 0.81` (the v1.3 leg-2 targets after
      the gate's ×0.81; Beelzebub gate → 9.38B HP / 787.5K atk). Same byte size (251,576),
      round-trip verified, content-swap only — no `add-external-files` needed.
      `gatefix/watch_only.sh` (running in background) fires when the game closes or a new
      encounter saves; the deploy itself is done by hand (copy `gatefix/out/…tbl` over the
      game's loose file, back up the old one, md5-compare after).

**Acceptance:** a Cycle-5 gate boss shows the rewritten HP (×0.81 of the new @250 row) on the
meter.

---

### Task 2 — Put each boss in an arena where its mechanics work

**Why:** Beelzebub warped out of bounds casting Smothered Mate in p900. Arena-scripted moves
reference points that exist only in the boss's native arena.

The minimal, low-risk fix moves Beelzebub to the one Conflux room in his native pa70 (84f000)
and gives the mismatched rooms a boss that Conflux already hosts. EM7300 (Convergent
Sequestration) natively runs in p300 and is raid-scale.

- [ ] **Step 1: Decide the assignment.** Suggested, conservative:

| room | area | assign | reason |
|---|---|---|---|
| 84f000 | pa70 | Beelzebub EM8200 | native arena; vanilla already puts him here |
| 84e010 | p900 | revert to vanilla EM0500, or test one boss at a time | no native raid boss in p900 |
| 84f010 | pa30 | revert to vanilla EM1806 | no native raid boss in pa30 |

Versa, The World and Lucilius stay deployed only if the user accepts that arena-scripted moves
may misbehave. Test them one at a time and record each result; a boss with no scripted warp may
be fine in a foreign arena.

- [x] **Step 2: STAGED 2026-07-28** at `<scratchpad2>/task2rev/` — the three pristine
      placement scenes extracted from `data.i.orig-202` (extract works against the original
      index even though the paths are external in the live one). Verified byte-for-byte:
      same sizes, and `values_[0]` reads EM0500 / EM1806 / EM8200×2 vs the deployed
      EM8200 / EM8200 / EM7700×2. Lucilius is dropped from the run for now (no native
      Conflux arena).

- [x] **Step 3: DEPLOYED 2026-07-28 12:52** together with Task 1's band table — all three
      files md5-verified on disk after copy; backups in `<scratchpad2>/gatefix/predeploy-backup/`.

- [ ] **Step 4: One live run.** Expect: 84e010 → Quakadile, 84f010 → Evyl Blackwyrm,
      84f000 (final slot) → Beelzebub in his native arena with no out-of-bounds warp; any
      leg-1 gate boss ≈ its new band HP (e.g. vanilla-boss gates now multi-billion). Versa
      and The World remain deployed in the p300–p600 rooms; if one warps out of bounds
      mid-run, that room needs the same revert treatment.

**Acceptance:** a boss fight in a swapped room completes with no out-of-bounds warp.

---

### Task 3 — Relocate a room to a foreign arena (proof of concept)

**Why:** this is the only way to field Versa, The World or Lucilius with working mechanics, and
it also opens up arena variety generally. Attempt it only after Task 2 succeeds.

Two `phaseNo` edits alone produce a broken room. The game resolves the placement as
`layout/<newarea>/placement_endlessmode_<room>.scene.msg`, which will not exist in the
destination, and the FSM's `ClearEndlessModeQuest.portalUniqueIdHash_` must name a uuid present
in that placement. In both rooms inspected it equals the section's own `uniqueIdHash`. A portal
that resolves to nothing is what soft-locked the `set_portal` experiment and forced the user to
kill the game.

The safe recipe **clones a room that already lives in the target area.** Prove it on
84e010 → pa70, whose donor (84f000) is known-good. **BUILT AND DEPLOYED 2026-07-28 13:14**
(artifacts in `<scratchpad2>/task34build/`, mirroring the game-data tree):

- [x] **Step 1: donor placement copied verbatim** to
      `layout/pa70/placement_endlessmode_84e010.scene.msg`. **Correction to the earlier
      model:** the section uuid appears **nowhere in the placement binary** (checked u64
      BE/LE and string forms) — `portalUniqueIdHash_` binds the FSM to the *sectionlist*
      section, not to a placement object, so the placement needs no uuid patch. It keeps the
      donor's EM8200 ×2 rows and entity uuids, which the cloned FSM's
      `entityUniqueIdHash_`/`npcUniqueIdHash_` references expect.

- [x] **Step 2: donor FSM layer 0 copied and re-identified** as
      `quest_84e010_0_ex_fsm_ingame.msg`, using a positional msgpack scanner (blind byte
      replace has false positives; the game's writer also emits duplicate keys, so
      python-msgpack tree counts undercount): `subcategory_` 79→78 (30×), `index_` 0→16
      (30×), and the 3 section-uuid fields (`uniqueIdHash_`, `pointUniqueIdHash_`,
      `portalUniqueIdHash_`) rewritten from the donor's to **84e010's own uuid**
      (6341602828482590276) — so the clone cannot collide with the real 84f000 when both
      rooms appear in one run. Donor layers 1–3 were **not** copied: they are
      【EV_SND】voice/BGM presentation only, and 84e010's `fsmDataList_` requests only
      suffix "0" anyway.

- [x] **Step 3: `sectionlist.msg` phaseNo "2304"→"2672"** (values are msgpack *fixstr*
      digit strings here, not uint16 — same length, same size). The copied FSM already
      carries 2672.

- [x] **Step 4: `lotterylocation_` stays 50.** Additionally
      `isQuestStartFromBossAppear_` was set "false"→"true" (1 byte shorter, re-registered)
      because the donor FSM is built around the boss-appear prologue
      (BossAppearAction/CheckQuestPrologueRunning); baseinfo `enemyIds_[0]` stays "164352"
      (EM8200), which is what the boss-appear path is believed to read.

- [x] **Step 5: `add-external-files` rebuild** — new `data.i` active 13:14 (13,549,913 B;
      +16 B over previous = exactly one new external entry: 8-byte path-hash + 8-byte
      size, which is as much registration proof as the tooling gives — `list-files` only
      prints archive-internal paths). Pre-rebuild index backed up at
      `<scratchpad2>/data.i.bak-pre-task34`.

- [ ] **Step 6: One live run, with an exit plan.** Warn the user that a broken portal
      soft-locks the run and the recovery is killing the game. Room 84e010 sits at loc 50
      (late-run), so the leg-1 gate checks (Tasks 1/2) complete before the risky room can
      appear. Confirm the room loads the **pa70** arena, **Beelzebub** spawns (boss-appear
      style, like the finale), Smothered Mate does **not** warp out of bounds, and **the
      exit portal appears after the kill**.

**Acceptance:** room 84e010 loads the pa70 arena and the run continues past it.

**If it fails:** revert with `data.i.orig-202` (§6) and record which of the three
elements — placement, FSM, phaseNo — was missing.

---

### Task 4 — Cover the three rooms with no placement scene

Rooms 843000, 843020 and 849000 are Cycle-5 gates but own no
`placement_endlessmode_<room>.scene.msg`, so §4's mechanism cannot reach them and they still
serve vanilla bosses (EM7200 Furycane, EM1805, EM7100 Vulkan Bolla).

- [x] **Step 1: RESOLVED 2026-07-28.** Their baseinfos reference
      `exPlacementFilesInfo_.suffix_ = ["<room>", "additional"]` like every other room — but
      `placement_endlessmode_843000/843020/849000.scene.msg` exists **nowhere in the
      archive** (checked all `layout/*/`). The game tolerates the missing file. The bare
      per-area `layout/<area>/placement_endlessmode.scene.msg` (196KB p101 / 394KB p502)
      is area-wide trash/prop placement and contains **none** of the three rooms' vanilla
      bosses (no EM7200/EM1805/EM7100 ids). Their FSMs name no enemy (`grep em[0-9]{4}`
      empty; only 84f000's FSM names `em8200_endlessmode`). 843000/849000 have a second FSM
      layer, but it's 【EV_SND】 presentation. Elimination leaves **`enemyIds_` fallback as
      the only data-side candidate** for scene-less rooms.

- [x] **Step 2: n/a** — no shared donor scene carries these bosses; no blast radius.

- [x] **Step 3: DIAGNOSTIC DEPLOYED 13:14.** Rotated the three rooms' `enemyIds_[0]` (and
      the correlated `targetList_` id — both carried stale v1.4 values EM7600/EM8300, which
      risked foreign-arena warps if the fallback works) among the **arena-roaming Convergent
      trio**, each ≠ its vanilla boss: 843000 "161280"→"160000" (EM7100; vanilla EM7200),
      843020 "161280"→"160512" (EM7300; vanilla EM1805), 849000 "164608"→"160256" (EM7200;
      vanilla EM7100). Same-length fixstr swaps. The trio appears across many arenas in
      vanilla runs (07-11 logs), so **either outcome is safe**: swapped boss ⇒ `enemyIds_`
      IS authoritative for scene-less rooms (Task 4 then fully solvable); vanilla boss ⇒
      spawn source is code-side, record it and close.

**Acceptance (updated):** the next run that draws loc 8, 9 or 35 answers the mechanism; the
doc records the outcome. Difficulty-wise the three rooms are already covered by the Task-1
gate band (their bosses' 250–300 rows are buffed like everyone else's).

---

### Task 5 — Refresh and ship the Reloaded-II package

Do this last, once Tasks 1–3 settle.

- [ ] **Step 1: Rebuild the package payload from the game tree,** which is now the source of
      truth. It must contain the four tables plus the patched placement scenes; the currently
      packaged baseinfos are obsolete no-ops and should be dropped.

- [ ] **Step 2: Keep the layout** that Nenkai's data mods use:

```
<ModId>/ModConfig.json                     ModDependencies: ["gbfrelink.utility.manager"]
<ModId>/README.md                          + PluginData.GitHubDependencies block
<ModId>/GBFR/data/<path as inside data.i>  the replacement files
```

- [ ] **Step 3: Split the `enemy_adjust` ×1.25 change into an optional mod,** since it leaks
      into Cycles 1–4.

- [ ] **Step 4: Add a `Preview.png`** and bump the version.

Staging lives at `F:\Downloads\gbfrelink.conflux.unbound-1.0.0\`. Reference mods are extracted
in `F:\Downloads` (`gbfrelink.qol.noswearfilter`, `gbfrelink.perfect.overmasteries`). The
user's Downloads folder is **F:\Downloads**, not `C:\Users\Scott\Downloads`.

**Acceptance:** a zip installs through Reloaded-II and reproduces the deployed behaviour.

---

## 5. Editing these files

`.scene.msg` and `baseinfo.msg` are MessagePack, but **python-msgpack does not round-trip them
byte-identically** — the game's writer is non-minimal. Always byte-patch in place and re-parse
to verify; never re-encode a whole file.

The scene writer emits **array32 (`dd`) and map32 (`df`)** headers, not the fixed forms. A
patcher that assumes fixarray/fixmap finds nothing and reports success. This walker handles
both:

```python
def skip_array_hdr(b, i):
    h = b[i]
    if 0x90 <= h <= 0x9f: return i + 1      # fixarray
    if h == 0xdc: return i + 3              # array16
    if h == 0xdd: return i + 5              # array32
    return None

def skip_map_hdr(b, i):
    h = b[i]
    if 0x80 <= h <= 0x8f: return i + 1      # fixmap
    if h == 0xde: return i + 3              # map16
    if h == 0xdf: return i + 5              # map32
    return None

# values_[0] lives at: b'\xa7values_' + <array hdr> + <map hdr> + b'\xa7Element' + <int>
```

Enemy ids ≥ 256 encode as uint16 (`cd XX XX`), so swaps between them keep the file size. Always
assert the size is unchanged **and** re-parse with `msgpack.unpackb` before deploying.

Same size is **not** sufficient on its own: a file that was never loose before must still be
registered with `add-external-files`, regardless of size.

## 6. Environment and toolchain

- Game: `G:\SteamLibrary\steamapps\common\Granblue Fantasy Relink` (v2.0.2 / Endless Ragnarok).
- **GBFRDataTools CLI** (Nenkai's, with local additions):
  `C:\Users\Scott\Projects\GBFRDataTools\GBFRDataTools\bin\Release\net10.0\GBFRDataTools.exe`.
  That repo has its own CLAUDE.md, and you must **never push it**.
  - `extract -i <data.i> -o <dir> -f <path-in-archive>` — errors with "This file is external,
    it is already extracted" when the path is already a loose file; read the loose file instead.
  - `tbl-to-sqlite -i <dir> -o <db> -v 2.0.2` and `sqlite-to-tbl -i <db> -o <dir> -v 2.0.2`.
    Round-trip is byte-exact for tables — verify that before deploying.
  - `add-external-files -i data.i -o data.i.new` — registers loose `data/` files. It writes a
    new file; move it over `data.i` yourself.
  - `filelist.txt` (19 MB, next to the exe) lists every archive path. Grep it to find a file's
    real location before extracting.
- **Revert everything:** copy `G:\...\Granblue Fantasy Relink\data.i.orig-202` over `data.i`.
  Loose files then become inert. Steam's "verify integrity" also restores it.
- **This session's scratchpad:**
  `C:\Users\Scott\AppData\Local\Temp\claude\C--Users-Scott-Projects-gbfr-logs\4598cb29-8afd-4d76-bfa2-ad64be566f4e\scratchpad`
  - `placemod_v17/` — the deployed patched placement scenes
  - `bossmod_v15/backup/`, `control_v16/backup/` — baseinfo backups
  - `roomdata/` — extracted placement scenes and room FSMs
  - `cur.sqlite` / `orig.sqlite` — deployed vs pristine `enemy_status_endlessmode`
  - `stage.sqlite` — `stagename.tbl`
  - `deploy_placement.py`, `deploy_control.py` — deploy-and-verify scripts

## 7. Hook instrumentation

Only needed for RE. The mod itself does not require the app.

Build, forcing the relink that Cargo skips:

```sh
rm -f target/release/hook.dll target/release/deps/hook.dll && touch src-hook/src/lib.rs
cargo build --release -p hook --features hook/console,hook/hookdiag,hook/eject
cp -f target/release/hook.dll src-tauri/hook-dbg.dll
grep -a -c needlescan src-tauri/hook-dbg.dll      # verify every expected label BEFORE staging
```

- The **dev** app injects `src-tauri/hook-dbg.dll` from the repo; `C:\Program Files\GBFR Logs\`
  matters only for the installed app and needs an elevated copy. Staging the wrong one costs a
  capture.
- The injected DLL is locked while the game runs. Close the game, or use tray → "Reload hook
  (dev)", which works mid-run.
- Log: `%APPDATA%\gbfr-logs\gbfr-logs.txt`. Hundreds of MB — always grep, never cat, and
  remember old sessions' lines look identical to current ones.
- Useful labels: `ev=endless_reception` (one per room; `raw=` is the stage id),
  `ev=file_open` (filediag), `ev=needlescan` / `ev=scanstats` (boss-identity scan).

**Uncommitted diagnostic code in the working tree:** `src-hook/src/hooks/filediag.rs` (new,
untracked) plus `scan_u32_needles` and `scan_u32_needles_deep` in `diag.rs` and their call
sites in `endless.rs`. All are `hookdiag`-gated and compile to nothing in release. Keep them —
they are the instruments for the next game patch. `docs/modding/` is also untracked.

**Deploy while the game is closed.** This watcher deploys the moment the user exits:

```sh
until ! tasklist //FI "IMAGENAME eq granblue_fantasy_relink.exe" 2>/dev/null | grep -qi granblue; do
  sleep 20
done
python <scratchpad>/deploy_placement.py
```

## 8. Dead ends — do not repeat

- **`enemyIds_` in baseinfo.** Patched in all 16 gate rooms; four runs served vanilla bosses.
- **`targetList_[type_==3].id_`.** Correlates with the vanilla boss 5/5 and is a reliable
  read-only indicator, but writing it changes nothing. Disproven live at 84a020.
- **`endlessmode_lot`.** The buff lottery, not rooms. Its keys are not `XXHash32Custom` of
  `Em####`, room ids or `quest_<id>` forms, and its location column tops out at 16.
- **`endlessmode_enemy_adjust`'s 53 keys** are not enemy-id hashes either.
- **Placement `mName` hashes.** Each room's unique hashes were tested against
  `XXHash32Custom` of ~45 name forms (`Em####`, `em####`, `boss_*`, `endless_*`) — no matches.
  The hashes are genuinely opaque; the enemy is in `values_`.
- **Room FSMs and sectionlists.** Generic nodes; only 84f000's FSM names an enemy.
- **The shared `placement_endlessmode_additional.scene.msg`** per area — trash-mob slots.
- **Scanning `EndlessModeQuestManager` for the boss id.** `scan_u32_needles_deep` swept the
  whole 0x64000 object plus one pointer hop, for all 29 boss ids in both encodings, across
  five receptions including three boss gates: zero hits. The identity resolves later, at
  actor spawn, not at room dispatch.
- **String-anchored RE on the `endless_` field names.** `enemyIds_[{0}]`, `isFirstLottery_`
  and friends sit in an unreferenced packed string pool near `0x627xxxx`; nothing references
  them, because they are consumed through reflection tables.

Kept RE breadcrumbs: `stage::quest::BaseInfo` vtable at `0x54ca900` (default ctor
`FUN_140be5610`, copy ctor `FUN_140608220`; the `targetList_` vector sits at BaseInfo+0x480
with 0x50-byte elements). The analyzed Ghidra DB `gbfr202fast` exists for v2.0.2 — query it,
do not rebuild it (see the `reverse-engineering-signatures` skill).

## 9. Working agreements

- **Never edit game files while the game runs.** Rooms load data live and the DLL is locked.
- **Verify every edit on disk after deploying** by re-reading the deployed file, not the source.
- **The user plays the test runs, and each one is expensive.** Never spend a run on a guess.
  Prefer instrumentation that answers the question in a single room, as filediag did, or a
  control experiment that tests the premise, as the objective-label swap did.
- **State the blast radius before writing** anything that affects rooms outside Cycle 5.
- **Do not commit specs or plans** under `docs/superpowers/`; they are gitignored working notes.
- Changelog entries are written by humans. Never create or edit them.
