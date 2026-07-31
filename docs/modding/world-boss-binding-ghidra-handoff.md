# Handoff — Ghidra investigation: Conflux boss binding for The World (EM8300)

> **SOLVED 2026-07-28 (late session) — read the "SOLVED" section at the very
> bottom first.** `mainBossUUID_` = mix64(boss placement node mUuid[1]) with
> `mix64(x): x ^= x<<13; x ^= x<<17`; build16 (corrected per-room uuids)
> deployed, live confirmation pending. The intermediate "RESOLUTION" (build6,
> self-registration theory) further down is WRONG on the central claim — kept
> only as history. The original brief is kept below for context.

2026-07-28. For an agent starting cold. Goal: make The World's full fight kit
work at the Cycle-5 Conflux leg-1 gate by understanding, in code, how the game
binds and orchestrates raid bosses — then either fix our data or prove a
data-only fix impossible.

**Read first, in order:**
1. `docs/modding/world-arena-map.md` — the complete data map (quest vs our rooms).
2. `docs/modding/conflux-unbound-handoff.md` — the wider mod, environment, working agreements.
3. Memory notes `gbfr-endlessmode-data-tables` (bottom entries, dated 07-28) and
   `gbfr-conflux-endless-mode`.
4. The project skill `reverse-engineering-signatures` — Ghidra DBs, scripts,
   sigscan harness. **The analyzed DB `gbfr202fast` exists; query it, never rebuild.**

## Current state (all live-verified except where noted)

Five Conflux rooms (84a020, 847010, 847020, 849020, 84e010) are relocated to
The World's native arena pa50 and are the only Cycle-5 leg-1 gate candidates.
Proven live: arena loads, The World (EM8300) spawns, is killable, counts for
the objective, exit portals appear and work, the run continues.

**The defect:** during scripted sequences (observed at Quickening cast) the
boss teleports away and repeatedly vanishes, returning briefly. The fight is
winnable but broken. User report, 2× observed (p600 run 25, pa50 run ~16:00).

**Deployed-but-untested mitigation:** every room placement now places BOTH
actors — EM8300 @ (0,0,-12.4) and EM8301 @ (0.1,-0.1,-12.4) — and registers
both in `enemyIds_[0..1]` ("164608","164609") with `enemyNum_` "1","1".
NOTE: the real quest registers ONLY EM8300 while placing both actors — our
deviation may spawn a second independent World; the next live run tells.

## The central mystery — your primary target

Both the quest FSM (`quest_40a301_0_ex_fsm_ingame.msg`, layer メイン進行) and
the one flawless vanilla Conflux raid room (84f000, Beelzebub) run a
**`BossAppearAction`** FSM node carrying a **`mainBossUUID_`** u64. Our five
rooms use the generic gate FSM with no boss binding at all — the prime suspect
for why scripted phases misbehave.

The uuid values resolve to NOTHING in any data file we can find (checked as
msgpack `cf` u64 and digit strings across placement, sectionlist, baseinfo,
and the whole FSM):

| where | node | mainBossUUID_ | subBossUUID_ |
|---|---|---|---|
| quest 40a301 L0, BossAppearAction #1 | | 8368956767859883644 | 4068758251509437051 |
| quest 40a301 L0, BossAppearAction #2 | | 7985114503207374634 | 4068758251509437051 |
| conflux 84f000 L0, BossAppearAction | | 6062918349335782374 | 4068758251509437051 |

`subBossUUID_` identical everywhere ⇒ a "none" sentinel. The two quest nodes
differ ⇒ likely form-1 (EM8300) vs Devil-form (EM8301) appearances.

### Q1 (blocking): what does `mainBossUUID_` reference, and what does BossAppearAction do?

Attack plan (analyzed DB `gbfr202fast`):

1. `ListSymbols.java BossAppear` — FSM node types are C++ classes; RTTI names
   survive fast analysis. Find the class/vtable.
2. `XrefsTo.java <vtable RVA>` → ctor → the node's field/reflection layout.
   Expect the *field-name strings* (`mainBossUUID_` etc.) to sit in an
   unreferenced packed string pool — string-anchored RE is a DEAD END here
   (proven for the `endless_` baseinfo family). The fields are consumed via
   reflection tables; decompile the node's create/deserialize path instead
   (same approach that cracked `createAttr` for summon identity — see memory
   `gbfr-summon-identity-ghidra`).
3. `Decompile.java` the node's execute/update virtual: what does it DO with
   the uuid? Working hypotheses to kill or confirm:
   - it looks up a spawned actor by a uuid assigned at placement-spawn time
     (then: where does an actor's uuid come from? our placement's `mUuid`
     pairs did NOT match — maybe a different derivation, e.g. hash of group
     hash + index);
   - it's a hash of an actor path/name (try XXHash32/64 of Em8300 name forms —
     but note 32-bit hashes can't fill these u64s directly);
   - it's matched against a registry the QUEST system fills from `enemyIds_`
     order (then index-based and our binding could reuse 84f000's value).
4. Cross-check with 84f000: whatever the mechanism, its value 6062918349335782374
   must resolve to its EM8200. If the resolution is positional/roster-based
   rather than content-based, cloning 84f000's FSM may Just Work for any boss.

### Q2: how does the quest spawn the Devil form (EM8301)?

The quest places EM8301 but does NOT register it in `enemyIds_`. Yet raid
bosses need registration to spawn from placement (proven: our EM8300 refused
to spawn until registered). So either the placed 8301 node is dormant until a
script activates it, or the em8300 actor itself spawns/possesses it.
Find the transition: decompile around the em8300 FSM/BT assets
(`system/FSM/em8300/`, `system/behaviortree/em8300/` — 70+15 files; the
runtime consumers are what you want, not the files), and the second
BossAppearAction. Deliverable: the exact mechanism, and whether our
"register+place both" deviation causes a double-spawn.

### Q3: what exactly does `enemyIds_` registration gate?

We know behaviorally: conflux-variant enemies spawn from placement without it;
EM8300 does not. Find the code path (actor factory / asset preload) that
consults the roster. This hardens the fix and predicts which other bosses
would need what. Entry breadcrumbs: `stage::quest::BaseInfo` vtable
`0x54ca900`, copy ctor `FUN_140608220`, `targetList_` at BaseInfo+0x480
(0x50-byte elems) — the enemyIds array is nearby in the same object.

### Q4: what breaks scripted phases without a boss binding?

The teleport-away loop at Quickening: is it (a) the boss BT waiting on a
quest-side event/actor that only BossAppearAction provides, (b) an orb-phase
relocation to a point owned by the missing binding, or (c) something else?
`isBossBattle_`, `bossEndPointIdHashs_` (quest value 13390285230413363440,
84f000 value 0) and the camera scripts `system/camera/data/em8300_*.msg` are
adjacent leads. This question is answered enough when you can say "the fix is
X" — full understanding optional.

## Leads and anchors already established

- Reception-flow dispatcher `FUN_140638690` (v2.0.2), quest_type 8 = endless;
  flow type-hash constant `0x887ae0b0` (LE bytes `b0 e0 7a 88`) — survives
  recompiles, good sigscan anchor.
- Table loader `FUN_14090f940` (all `endlessmode_*.tbl` consumers).
- The `endless_`/FSM field-name strings live in an unreferenced packed pool
  near `0x627xxxx` — do not grep-and-xref them; go through RTTI/reflection.
- FSM files carry duplicate map keys and array32/map32 headers — python
  `msgpack` tree counts undercount; byte-level positional scanning is the
  reliable way (see `worldgate/build_fix2.py` for a spans-aware parser).
- `EndlessModeQuestManager` heap object: needlescan across 5 receptions found
  NO boss ids within one pointer hop at reception time — identity resolves at
  actor spawn, not room dispatch. Don't re-walk that dead end.

## Live instrumentation available (use before spending runs)

- Hook features: `hookdiag` (reception events, `scan_u32_needles`,
  `probe_delta` in `src-hook/src/hooks/diag.rs` + `endless.rs` call sites,
  all uncommitted but in the working tree) and `filediag`
  (`src-hook/src/hooks/filediag.rs`, CreateFileW/A trace, pattern-filtered:
  quest/endless/system\table).
- Build + stage: see handoff §7 (`hook-dbg.dll` for the dev app; verify with
  `grep -a -c <label>` before staging; the DLL is locked while the game runs;
  tray → "Reload hook (dev)" works mid-game).
- A useful new probe for Q1/Q4: log the boss actor's position + FSM/BT state
  ids each second during a gate fight, and/or hook BossAppearAction's execute
  once found — one fight would then name the exact failing transition.
- Log: `%APPDATA%\gbfr-logs\gbfr-logs.txt` — grep, never cat (300+ MB).

## Working agreements (non-negotiable, from the main handoff)

- Never edit game files while the game runs; deploy via the game-closed
  watcher; verify every deployed file on disk (re-read + md5).
- The user plays the test runs and each is expensive — never spend one on a
  question offline data or instrumentation can answer. Mid-run file edits
  cannot fix an in-progress run (roster snapshots at first dispatch;
  resumes re-read placement/arena but not the roster).
- Alt+F4 mid-run resumes into the same room. The rescue recipe for a stuck
  gate: revert that room's sectionlist/FSM/baseinfo to pristine (game
  closed), resume, kill the vanilla boss. Proven live.
- State the blast radius before any change reaching outside Cycle 5.
- Do not commit `docs/superpowers/**`; `docs/modding/` is untracked notes.
  Never write fork names in code or comments. CHANGELOG.md is humans-only.

## Environment quick reference

- Game: `G:\SteamLibrary\steamapps\common\Granblue Fantasy Relink` (v2.0.2).
- Ghidra 12.1.2 at `C:\ghidra\ghidra_12.1.2_PUBLIC`; project
  `C:\Users\Scott\ghidra-projects\gbfr`; DBs `gbfr202lean` (import-only) and
  `gbfr202fast` (analyzed: decompiler, xrefs, RTTI). Scripts in
  `.claude/skills/reverse-engineering-signatures/ghidra/`.
- GBFRDataTools: `C:\Users\Scott\Projects\GBFRDataTools\...\GBFRDataTools.exe`
  (never push that repo). Pristine extractions: `-i <game>\data.i.orig-202`.
- Working tree + backups: session 24a3fbfc scratchpad `worldgate/`
  (`candidates.md`, `coords.md`, `pa50-support.md`, `NOTES.md`, builders
  `build_poc.py`/`build_phase3.py`/`build_fix2.py` [spans-aware msgpack
  parser], deploys, and `backup/{deployed*,data.i.bak-*}` for full revert).
- Nuclear revert: copy `data.i.orig-202` over `data.i` (loose files go inert).

## Success criteria

1. `mainBossUUID_` semantics documented (what it references, how it resolves).
2. A concrete change — data (FSM graft / donor-FSM conversion / uuid rewrite)
   or minimal hook assist — that makes The World's scripted phases play out
   correctly at the gate, deployed and user-confirmed in a live run.
3. The EM8301 double-registration question resolved (keep or revert
   `enemyIds_[1]`).
4. Findings recorded in `gbfr-endlessmode-data-tables` memory + the two
   handoff docs updated; dead ends listed so they are not re-walked.

---

# RESOLUTION — 2026-07-28 evening session

## Q1 ANSWER: `mainBossUUID_` is a self-registered handle, not a data reference

Full mechanism chain (all from `gbfr202fast` decompiles):

1. **`BT::BossAppearAction`** (vtable RVA `0x5930ff8`, ctor `FUN_141de7690`) is
   the FSM node class. Full field set (from the quest FSM binary): `guid_,
   parentGuid_, category_, subcategory_, index_, progressIndex_, progressHash_,
   mainBossUUID_, subBossUUID_, mainBossFSM_, subBossFSM_`. The two string
   fields were previously unknown; both are EMPTY in the quest and in 84f000.
2. The BT node is a **factory**: vtable slot 9 (`FUN_141de8520`) constructs a
   separate **`stage::quest::BossAppearAction`** (vtable `0x5c7ae68`), copying
   uuid/string fields, and queues it via `FUN_1431f11f0` into a per-quest
   registry keyed by the packed triple (category<<20 | subcategory<<12 | index —
   same encoding as the reception `raw`) and the node's `progressHash_`.
3. The quest action's execute (`FUN_1431f86b0`): writes `mainBossUUID_` to
   **activeflow+0x320**, `mainBossFSM_` to +0x328, `subBossUUID_` to +0x348,
   `subBossFSM_` to +0x350 (active flow = manager `DAT_147c54830`+0x210 — the
   same slot known from the endless RE), sets flow+0xf1=1, requests the
   boss-appear flow state (0xe).
4. The state-0xe driver (`FUN_141fd3bb0`) **WAITS — returns 0xe — until
   `FUN_141f7e8f0(flow+0x320)` resolves the uuid to an actor**, then fires the
   FSM event **`boss_appear_event_default`** (or the `mainBossFSM_` string if
   nonempty) at the actor via `FUN_140b45dc0(actor, "enemy", name)`, sets up
   the appear camera (flow+0x4d0 = an appear-POINT uuid resolved through the
   same map; actor transform at +0x170/+0x184), audio (`SE_ListenerPreset`
   RTPC), boss telop, then transitions to state 0xf.
5. `FUN_141f7e8f0` = generic **"find scene object by u64 uuid"**: iterates the
   scene-manager list (`DAT_147ab3150`+0x20 then +0x60 circular list), each
   elem+0x30 holds an `unordered_map<u64, u32 slot>` (buckets +0x98, mask
   +0xb0, end +0x88; entry key at +0x28, value u32 at +0x30) indexing an actor
   array at holder+0xf0. **Full u64 equality**; used by 9 flow functions.

**Why the uuid resolves to nothing in data — and why that's fine:**

- `0x6ED0D3556E7ECF2A` (one of the quest's two values) is shared **verbatim by
  ~40 different raid-quest FSMs** (40a314 Beelzebub, 40a309 Versa, 40a313
  Lucilius, whole 408xxx/409xxx/40axxx/40bxxx families) whose placements and
  bosses all differ — proven by decompressing and grepping every
  system/quest/layout chunk in the archive. A shared value cannot reference
  per-quest data.
- Those quests' placement boss nodes carry a template-identical `mUuid[1]` =
  `0xcab6133901cf8f2a` (placements are template copies too).
- FSM uuid vs placement `mUuid[1]` share exactly the **low 14 bits** (editor
  object id; high 50 bits = save-timestamp-ish, drift on re-save). This is an
  authoring artifact with NO runtime role.
- **Decisive elimination:** 84f000's uuid `0x5423D01DB25B63E6` full-matches
  neither of its two placement node uuids, the driver *blocks* until resolve
  succeeds, and 84f000 is live-proven flawless — so at runtime an entry keyed
  by the FSM's exact value exists — so **the flow registers the spawned boss
  actor under the FSM-declared value (via flow+0x320)**. Any value works as
  long as the appear flow drives the spawn. (The insert site itself was not
  pinpointed — a `[reg+0x320]` sweep found 531 generic hits, 7 flow-region
  candidates all turned out resolve-side or unrelated — but its existence and
  key-source are forced by the above.)
- `subBossUUID_` `0x387722129228D27B` = "none" sentinel everywhere. The appear
  driver has a special case for actor-type 0x27400 (EM7400) — irrelevant.
- `deadEventFSMName_` ("boss_dead_event_em8200_endlessmode" in 84f000, EMPTY
  in the quest) is fired at the boss on death; generic defaults exist
  (`enemy_boss_appear_event_default` / `enemy_boss_dead_event_default` in
  `system/FSM/enemy/`). No em8300 endlessmode variants exist anywhere.

## Q2 verdict (partial)

The quest registers ONLY EM8300; the Devil form (EM8301) is tied to the second
BossAppearAction (its uuid is editor-paired to the EM8301 placement node, and
under the self-registration model its appear step spawns/registers the second
actor). Our fix2 double-registration deviated from both working references —
**reverted**: `enemyIds_[1]` back to `-1`, `enemyNum_[1]` to `0`; both actors
stay PLACED (matches the quest exactly). Devil-form manifestation under the
donor clone (which has only ONE BossAppearAction) is a live watch item; if it
fails, next step is grafting a second BossAppearAction node into the clone.

## THE FIX — build6, DEPLOYED 2026-07-28 evening (live pending)

All five World rooms converted to the **84f000 donor FSM** (the flawless
conflux raid-hosting pattern):

- FSM = pristine 84f000 layer-0, re-identified per room via positional msgpack
  scanner: `subcategory_` 79 to room's (x30), `index_` 0 to room's (x30), the
  3 section uuid fields (`uniqueIdHash_`/`pointUniqueIdHash_`/
  `portalUniqueIdHash_`) to the room's own sectionlist uuid, `phaseNo_`
  cd 0x0a70 to 0x0a50, `deadEventFSMName_` to empty (-35 B).
  `mainBossUUID_`/`subBossUUID_`/both FSM strings kept verbatim
  (value-agnostic per Q1).
  Room identities used: 84a020=8/74/32 uuid 9412190963011223775,
  847010=8/71/16 and 847020=8/71/32 (shared vanilla uuid
  12406843886080264828), 849020=8/73/32 uuid 17672322020260268107,
  84e010=8/78/16 uuid 6341602828482590276.
- baseinfo: `isQuestStartFromBossAppear_` "false" to "true", enemyIds reverted
  to single registration (see Q2). Placements untouched (fix2 state: EM8300 +
  EM8301 both placed @ (0,0,-12.4)/(0.1,-0.1,-12.4)).
- Deployed game-closed; every file md5-verified on disk; `add-external-files`
  rebuild (data.i size unchanged — all paths already external, only sizes
  updated); chunk-1 relocation audit PASS (enemy_status_chaos md5 stable).
- Build + deploy scripts and pre-deploy backups: session c23c0770 scratchpad
  (`build6.py`, `deploy_build6.py`, `build6/`, `build6_backup/` incl.
  `data.i.bak-pre-build6`).

**Live watch list for the next fresh C5 run:**
1. Leg-1 gate: boss-appear prologue plays (fade + appear cinematic), The World
   spawns via the appear flow.
2. Scripted phases — Quickening teleport/vanish loop gone? Orb phase? Tarot?
3. Devil form manifests or not (single BossAppearAction).
4. **Exit portal appears and works** — the donor is the loc-54 FINAL room;
   it has `ClearEndlessModeQuest`+`CheckEndlessModeClear` so continuation
   should work at leg-1, but the donor lacks the gate FSMs'
   `CheckEndlessModeDifficulty`/`FinishEndlessModeExBossFlow`/
   `NavMeshSwitchAction` nodes — reward/flow differences possible. If the room
   soft-locks: Alt+F4, revert that room's FSM+baseinfo from `build6_backup/`
   (or pristine), resume, kill the vanilla-flow boss (rescue recipe, proven
   live).

## New dead ends (do not re-walk)

- Deriving the FSM uuid from placement `mUuid` pairs: halves, xor, sum,
  byte-swaps, FNV-1a64 (all orders), digit strings — all disproven; and the
  low-14-bit correlation is authoring-only.
- Whole-archive scan: the uuids exist ONLY in quest FSM BossAppearAction nodes
  (and are per-quest-unique only for 40a301/40b301; the rest share the
  template value).
- Scanning for `[reg+0x320]` to find the registration insert: too generic (531
  hits); the 7 unknown flow-region readers are resolve-side/cleanup.

## New tooling facts

- Archive chunks with **ZSize == Size are stored RAW** (not LZ4) in data.N —
  a whole-archive grep = iterate `debug/chunks.txt`, seek data.N, lz4.block
  when compressed, plain bytes otherwise (~3.5 GB for system/quest/layout).
- sigscan truncates dumped matches (~32) but keeps counting — never grep its
  match list for completeness; scan the exe in python (PE section map) instead.
- Ghidra headless runs hold the project lock — one at a time.

## build7 — crash fix (2026-07-28, later that evening)

**First build6 live result: CRASH while loading into the leg-1 gate portal**
(room 849020; WER: AV in the exe, fault RVA 0x1fd62a5, read of address 0x140;
minidump parse confirmed the null pointer; hook log confirmed reception
0x849020 + our FSM/placement opened right before).

Root cause (systematic-debugging session): the faulting code is the
boss-appear CINEMATIC state handler (`FUN_141fd5c70`, right after the appear
driver) polling `player[0] (DAT_147036860) -> vfunc(vt+0x4c0) -> +0x140` for
event timing with no null guard on the component. The component was null
because of a donor leftover the build6 re-identification missed:
**`BeginSection.controllers_`** — it references **PlacementController objects
of the room's placement scene by uuid** and must match the room's sectionlist.
The donor block (count 1, objectId 12959122195672179686 = an 84f000/pa70
placement object) dangled in our rooms, whose sectionlists/placements carry
their OWN controllers (84a020: 5, 847010/847020: 4 each, 849020/84e010: 3
each). A full BeginSection field-diff vs the rooms' previous FSMs showed
controllers_ was the ONLY unintended difference.

**Fix (build7, deployed + md5-verified + chunk audit PASS):** splice each
room's own controllers_ map (verbatim from its pre-build6 FSM, asserted equal
to its sectionlist's controller ids) into the donor clone. No other change.
Backups: `build7_backup/` (+ data.i.bak-pre-build7) in session c23c0770
scratchpad.

**Donor-clone recipe update — the re-identification checklist is now:**
subcategory_ ×30, index_ ×30, 3 section-uuid fields, phaseNo_,
deadEventFSMName_, **and BeginSection.controllers_ (per-room, from the room's
sectionlist)**. Any FSM field that names placement objects must be re-pointed
at the destination room's objects.

Note for the crashed run: resumes re-dispatch from files, so relaunching and
resuming should load the gate with the fixed FSM (roster was already correct).

## Crash #2 (resume) + build8 — 2026-07-28, ~17:08

**Event:** loading the save again crashed immediately. WER: SAME fault RVA
`0x1fd62a5`, AV **read at 0x140**. Minidump registers: `rcx/rbx/rdi/r12/r14/r15
= 0`, **`r8 = 0x849020`** (our room's stage id) — so the crash is in our gate.

**Fault mechanism now EXACTLY confirmed** (matches the decompile of
`FUN_141fd5c70`, the appear-cinematic state handler, line for line):

```c
if (DAT_147036860 == 0) { lVar13 = 0; }              // local player slot 0
else { lVar13 = (**(code**)(*DAT_147036860 + 0x4c0))(); }
if (*(longlong *)(lVar13 + 0x140) == 0) { ...        // <-- AV: read [0 + 0x140]
```

`DAT_147036860` (player[0]) is NULL when the appear-cinematic state polls it,
so `lVar13` is 0 and the `+0x140` field read faults. The handler has no null
guard on that path. So the crash = **the boss-appear cinematic running while
the local player actor does not exist**.

**Two confounds, both real:**

1. **The save is a resume into the already-broken room.** Previously proven
   live (07-28 ~15:50): a mid-run Alt+F4 resumes into the SAME room, the room
   re-dispatches from files, **but roster/section state is cached in the run
   save from first dispatch** — a disk fix did NOT take effect in an
   already-stuck run. So this resume is NOT a valid test of build7, and this
   particular save may be unrecoverable by forward fixes. The proven escape is
   the rescue recipe: revert that one room to pristine (game closed), resume,
   kill the vanilla boss, run continues.
2. **The clone was still incomplete.** A full recursive baseinfo diff vs
   84f000 (the only field-complete reference) found our rooms still lacked the
   rest of the appear package:
   - `fsmDataList_` declared only layer 0, but the donor MAIN layer's
     `StartFsm` nodes launch layers **1 and 3** (`fsmDataNo_` 1 and 3, with
     `fsmProgressHash_` 0x8414ff732c03a6a5 / 0xf1b41415f2a8cf86 matching those
     layers' `progressHash_`). Those layer FSM files did not exist for our
     rooms at all.
   - `preLoadQuestFSMFileInfos_` empty (donor: 2 entries).
   - `preLoadVoiceEventFileInfos_` empty (donor: VT_MS72 banks).

**build8 (deployed, md5-verified, chunk audit PASS, +224 B index / 15 new
externals all confirmed registered):** per room, clone donor layers 1/2/3
(re-identify `subcategory_`/`index_` only — layers carry no uuids, phaseNo, or
controllers), and splice the donor's `fsmDataList_`, `preLoadQuestFSMFileInfos_`
and `preLoadVoiceEventFileInfos_` values verbatim into the room baseinfo.
Verified: each layer's `progressHash_` matches its `fsmDataList_` `hash_`;
roster/appear flag untouched. Backups: `build8_backup/` (+
`data.i.bak-pre-build8`).

**Status: build8 is a HYPOTHESIS-DRIVEN fix, not a proven one.** The fault
mechanism is certain; "missing layers/preloads is why player[0] was null" is
the leading explanation (it is the only remaining structural difference from
84f000, which runs this exact flow flawlessly) but is unproven. It can only be
validated on a **FRESH Cycle-5 run** — a resume cannot validate it.

**Donor-clone checklist (final):** subcategory_ ×N, index_ ×N, 3 section-uuid
fields, phaseNo_, deadEventFSMName_, BeginSection.controllers_, **ALL fsmData
layers the MAIN layer's StartFsm nodes reference + baseinfo fsmDataList_ +
preLoadQuestFSMFileInfos_ + preLoadVoiceEventFileInfos_**. Rule of thumb: diff
the whole baseinfo against the donor's, not just the fields you meant to change.

## build8 FAILED — donor-clone approach ABANDONED, phase3 reverted (2026-07-28 ~18:00)

**Fresh-run result:** a fresh C5 run on the full build7+build8 stack crashed at
the leg-1 gate (room 847020 this time) — SAME fault RVA `0x1fd62a5`, AV read of
`0x140`. Reading the minidump's captured memory (Memory64List stream) proved
`DAT_147036860` (player[0]) == 0 at the fault: the appear-cinematic state
really does run with NO local player actor, even on a fresh portal entry.
Three fixes at one site → stop patching, question the architecture.

**Root cause of the architecture failure — the donor FSM references its home
room's environment at a level re-identification can't reach.** Full u64 audit
of the deployed FSM vs the room's own files found four dangling donor refs:

1. `SetRespawnPoint.objectId_ = 7583234192454736166` → a `memberType_=11`
   point object in **`layout/pa70/placement.scene.msg` — the AREA BASE
   placement**. pa50 has NO base placement file at all (verified against the
   archive listing), so this reference is UNFIXABLE by value substitution
   without injecting a new placement object.
2. `SendSignal 11150099123443249221` + `RecvSignal 6984184111789428292` = a
   handshake with the donor room placement's **PlacementController
   `operationDetails_` program** — decoded: detail1 waits for the FSM's signal
   (`statusOption_`), fires `action_=2` on `actionOption_ =
   16746844830288290790` = the GROUP node wrapping the room's boss actors
   (i.e. this is the **boss-group activation flow**), detail2 then `action_=4`
   emits the confirm signal the FSM's RecvSignal waits on. Our rooms'
   controllers carry their own programs with different signal values.
3. `SendSignal 919518117116113863` resolves NOWHERE found (donor room
   placement, pa70 base, pa70 area-generic all negative).
4. (Eliminated suspects: `subPhaseNo_=0` is CORRECT for pa50 — quest 40a301
   uses 0; controllers_ (build7) and layers/preloads (build8) were real
   defects but not the crash cause.)

Quest 40a301 (native pa50 boss-appear, works) has NO SetRespawnPoint and all
its FSM references resolve inside `placement_multi_40a301` — each boss-appear
implementation is wired to its own placement environment.

**Deployed state now: all 5 World rooms reverted to the phase3-proven flow**
(FSM0 from build6_backup; baseinfo = pre-build8 + `isQuestStartFromBossAppear_`
→ false; 847020's NATIVE layer-1 FSM (3083 B — vanilla declares fsmDataList
count=2 for this room, unique among the five) restored over the donor clone;
leftover donor layer files undeclared → inert). This config is live-proven:
The World spawns, is killable, portals work; only the scripted-phase
vanish/teleport defect remains. Scripts + backups: session 6bc95afe scratchpad
(`revert_phase3.py`, `build8state_backup/`).

**Next approach (Path B): graft ONLY a `BossAppearAction` node into the
working phase3 FSMs.** Rationale: quest 40a301 fires its SECOND
BossAppearAction MID-battle — players alive, no appear flag, no
SetRespawnPoint, no placement handshake — proving the appear flow (state 0xe
resolve → self-register binding → `boss_appear_event` at the actor, per Q1)
works when requested mid-flow. Grafting after section start with the flag
false lets players spawn normally (proven) and then binds the boss. Open
design points: graft parent/order in the room FSM graph, node byte-insertion
(+array header bump — same technique as the placement enemy duplication),
whether one action suffices or the Devil form needs the second one.

**New tooling facts:** minidump virtual-address reader =
`read_dump_mem.py` (session 6bc95afe scratchpad) — full-memory WER dumps
contain the exe globals; the game writer encodes EMPTY arrays as array32
`dd 00 00 00 00` (never fixarray `90`) — byte-level asserts must use that form.

## build9 — the appear-GRAFT (Path B), built 2026-07-28 evening (deploy pending)

**FSM file format decoded** (enables all of this): the file root is a map32 of
`FSMNode` (states) + `Transition` entries (the state-machine skeleton) followed
by action/condition nodes bound to states via `parentGuid_`; parent-0/-1 nodes
are transition conditions referenced by `conditionGuids_`. Transition
`toNodeGuid_`/`fromNodeGuid_` are INVERTED vs execution — read to⇒from to get
the exec graph. States don't list children (`tailIndexOfChildNodeGuids_` is an
editor artifact); runtime attaches by parentGuid_, so **a node can be appended
at end-of-file with only a root-count bump**.

**84f000's decoded exec head:** BeginSection → StartFsm(layers) →
SendSignal(activate boss group) → **BossAppearAction (own state, only action)**
→ (reception/camera conds) → respawn-point state → RecvSignal(activation
confirmed) → fight. So the appear action arms the binding AFTER the spawn
request is sent, BEFORE spawn confirm — while the spawn is in flight. Every
room FSM has the same shape with an EMPTY state right after its activation
state = the graft slot. Per-room handshake signals are derivable from the
room placement's controller `operationDetails_` (statusOption_ = FSM→ctl
activate signal; action_=4 actionOption_ = ctl→FSM confirm).

**build9 =** donor's 194-byte BossAppearAction root entry (guid 1034477611 —
unused in all 5 room FSMs; mainBossUUID_ 6062918349335782374 verbatim,
value-agnostic per Q1; progressHash_ 3223066133838547431 identical in donor
and all rooms) appended to each phase3 FSM with parentGuid_ → the empty
post-activation state, subcategory_/index_ → the room's. Same-size field
patches; root map32 count +1; +194 B per file. NOTHING else changes: appear
flag stays false (players spawn normally — the crash class is structurally
impossible), no SetRespawnPoint, no donor signals, no layers, no baseinfo/
sectionlist/placement edits. Precedent that a mid-flow appear works: quest
40a301 fires its SECOND BossAppearAction mid-battle.

Graft parents: 84a020→372114857, 847010→871927645, 847020→411059305,
849020→1923636070, 84e010→317720473.

**Live watch (fresh C5 run):** (1) gate loads, players + The World spawn
(if the appear DRIVER blocks on uuid resolve because the normal-path spawn
never registers under the FSM uuid, the room soft-locks at the objective/
portal — rescue = revert that room's FSM from `graft_backup/`, resume);
(2) appear cinematic/telop plays?; (3) **Quickening vanish loop gone?** —
the whole point; (4) Devil form; (5) exit portal (should be unaffected —
room flow untouched).

Scripts: session 6bc95afe scratchpad — `build_graft.py` (asserts: live==
build6_backup base, plan states exist, signal on expected state, guid unique,
post-build reparse+decode+field checks), `deploy_graft.py`, `graft_build/`,
`graft_backup/` after deploy.

## Builds 9–15 — the graft chain works but REGISTRATION never happens. NEXT AGENT: Ghidra.

All tested same-day on the harness save (stuck fresh C5 run at the 849020
leg-1 gate; resumes re-dispatch from files, roster cached WITH The World
registered — every build below was tested by deploy-game-closed + resume,
zero fresh runs spent). Live flow probe = `appear_probe` in
`src-hook/src/hooks/endless.rs` (uncommitted, feature `hookdiag`; staged in
`src-tauri/hook-dbg.dll`): samples `[mgr+0x210]` flow at 1 Hz — `+0x320`
main-uuid, `+0x348` sub, `+0x4d0` appear-point, bytes `+0xe8..0xf7`, u32s
+0x18/+0x20/+0x28.

| build | change | user-visible | probe |
|---|---|---|---|
| 9 | BossAppearAction in post-activation state, flag false | HP bar, boss never appears, timer 0:00, NO crash | uuid written, +0xf1=1, point=0, frozen |
| 10 | mainBossUUID_ low14 := room EM8300 placement node id | identical | identical (new uuid visible) |
| 11 | + baseinfo isQuestStartFromBossAppear_=true | BLACK screen + quest-start sting, no crash | **main=0 — graft never executed** (FSM parked at camera gate) |
| 12 | graft re-parented pre-gate (post-scene-ready state) | same black | main written, +0xf1=1, point=0, frozen |
| 13 | + StartQuestPrologueAction QUEST_PROLOGUE_0001 | **Beelzebub-quest intro PLAYED**, then black | same terminal state |
| 14 | prologueId → QUEST_PROLOGUE_0002 | **The World's intro PLAYED**, then black | same |
| 15 | + copy of room's activation SendSignal pre-gate, order appear→send→prologue | same | same: main=0x5423d01db25b6462, point=0x0, f0xe8=`00010100…0001…`, s18/s20/s28 = d957d117/d95ce7b4/d95886c4 forever |

**Facts established:**
- The FSM appends/grafts work mechanically (nodes attach by parentGuid_, run
  on state entry, prologue action verifiably plays its cinematic in an EX
  room, prologueId_ selects the intro asset: 0001=Beelzebub quest,
  0002=The World quest).
- The room FSM runs during the flag-true appear-hold only up to its
  IsPlayableCamera/CheckReceptionState conditions (849020: the SECOND
  transition; per-room extraction in `room_graph.py` output) — anything
  needed by the appear flow must execute before that gate.
- flag=true does NOT itself spawn/register the roster boss. The prologue does
  NOT register. uuid-before-spawn-request ordering (build15) does NOT
  register. **Nothing data-side we tried triggers the scene-map insert that
  the state-0xe driver's resolve (`FUN_141f7e8f0`, FULL u64 equality on
  `flow+0x320`) waits for.**
- Q1's low-14 observation is authoring-only after all (build10 disproved the
  runtime-lookup reading; the full-u64 resolve stands).
- build6–8 donor-clone crash evidence is now ambiguous: FUN_141fd5c70 (the
  crash site, "cinematic state") may run INDEPENDENTLY of resolve — do not
  assume resolve ever succeeded in builds 6–8.
- The player-null crash class is gone with flag=true + room-coherent FSM (no
  donor SetRespawnPoint/signals) — black-hold instead of crash, always
  recoverable by Alt+F4.

**Sharp questions for Ghidra (`gbfr202fast`, scripts in
`.claude/skills/reverse-engineering-signatures/ghidra/`):**
1. Decompile `FUN_141fd3bb0` (state-0xe driver) COMPLETELY: the exact wait
   predicate (is it only resolve(flow+0x320)? what breaks the wait?), where
   the real flow-state id lives (probe u32s at +0x18/20/28 look like hashes,
   not state ids — find the byte the driver returns into).
2. Find the scene-object-map INSERT that registers the boss actor under the
   FSM uuid: who writes an entry with key == [flow+0x320]? Angles: (a) map
   layout writers — the holder's +0x88/+0x98/+0xb0/+0xf0 addressing in a
   STORE context; (b) readers of flow `+0xf1`/`+0x320` in enemy-spawn
   completion paths (enemy actor factory / group-activation spawn); (c)
   decompile what 84f000's flow does between prologue end and camera release.
3. If the insert has an un-cloneable precondition, evaluate the **hook-assist
   workaround**: detour `FUN_141f7e8f0` — when the key equals the graft uuid
   and the real lookup misses, locate the EM8300 actor and return it (fake
   the resolve). The hook already injects and has the module base; this may
   be the fastest unblock, at the cost of needing the hook installed for the
   mod to work.
4. Confirm what FUN_141fd5c70 actually is (state id, entry conditions) to
   settle the build6–8 interpretation.

**Current deployed state (2026-07-28 ~20:00):** FSMs = build15
(`graft6_build/`: phase3 base + BossAppearAction[re-keyed uuid] + activation
SendSignal copy + StartQuestPrologueAction 0002, all in the post-scene-ready
state); baseinfos = flag TRUE (build11); placements = dual-actor
EM8300+EM8301; harness save still stuck at the 849020 gate (black screen on
resume, Alt+F4 out, no crash).

**To make the game playable for the user** (if they want to play before the
next session): revert the 5 FSMs to phase3 (`graft_backup/` in session
6bc95afe scratchpad = pristine phase3 copies) AND flip the flags back
(`deploy_build11.py revert`), then `add-external-files` (FSM sizes changed) +
chunk audit — this returns to the proven phase3 state (World spawns visibly,
fight works, Quickening vanish glitch present) and also un-sticks the save.
All deploy scripts in session 6bc95afe scratchpad follow the same
game-closed/backup/md5/chunk-audit pattern — copy one.

**Build/probe quick reference:** hook rebuild =
`cargo build --release -p hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist,hook/eject`,
stage `target/release/hook.dll` → `src-tauri/hook-dbg.dll` (game closed).
Probe output: grep `%APPDATA%\gbfr-logs\gbfr-logs.txt` for `ev=appear_flow`
/ `ev=appear_map` (never cat — 400+ MB). The `appear_map` scene-map walker's
layout guesses are WRONG (walks 1 scene, 2 nodes, no u64 keys) — fix it from
the real `FUN_141f7e8f0` decompile if map visibility is wanted; the flow
sampler is reliable.

---

# SOLVED — 2026-07-28 late session: `mainBossUUID_` = mix64(placement mUuid[1]); build16 deployed

The Ghidra pass the previous section asked for was run (session 436260b1;
decompile batches in its scratchpad, `batch1.c`–`batch7.c`). Every open
question fell. **The prior session's central conclusion ("self-registered
handle, any value works") was WRONG** — do not build on it.

## The binding, exactly

- The scene-object map (`DAT_147ab3150+0x20 → +0x60` list, per-scene holder at
  elem+0x30) is a **placement-object registry**: it maps
  `mix64(node mUuid[1]) → runtime placement-object instance`, populated at
  placement-scene load. `mix64(x): x ^= x<<13; x ^= x<<17` (mod 2^64) — found
  in `FUN_143aa1580` (a per-type controller handler computing the key from a
  data u64 before the map walk).
- **`mainBossUUID_` = mix64(mUuid[1] of the boss placement NODE)** (the
  `mt=1` enemy node, not the group). Verified exact on all four ground
  truths: template pair (`mix64(0xcab6133901cf8f2a) == 0x6ED0D3556E7ECF2A`),
  quest 40a301 EM8300 node → BAA#2 uuid, quest EM8301 node → **BAA#1** uuid
  (the FIRST BossAppearAction binds the DEVIL node — Q2 is mechanical now),
  84f000 EM8200 node #1 → its BAA uuid.
- The resolver `FUN_141f7e8f0(uuid)` finds the placement object and returns
  its **spawned actor** (vfunc+0x80 handle → validated via `DAT_1470214e8`
  tables → actor = `*(handle.p20+0x70)`). So resolve succeeds only once the
  node's actor is spawned. No runtime key insert exists; builds 9–15 failed
  because the grafted uuid (donor value / donor-high-bits+low14 re-key)
  **references no object in our rooms** — mix64 differs even when low 14
  bits match (shifts ≥13 preserve only the low 13/14 bits — that was the
  "authoring artifact" correlation all along).

## The flow state machine (decompiled, batch1–4)

The flow is **`stage::quest::ReceptionQuestFlow`** (RTTI-named lambdas in
`FUN_141fdad70` = `updateWaitStartEvent`). Current-state u32 at
**flow+0x2d8**; the appear request `FUN_141f7e810` writes 0xe there directly.
States seen: 9 = WaitStartEvent, 0xc/0xd = in-game, 0xe = appear driver
(`FUN_141fd3bb0`), 0xf = appear cinematic (`FUN_141fd5c70`, the build6–8
crash site — dispatched from an unrecovered jumptable, pdata-only xrefs).

- **BossAppearAction execute (`FUN_1431f86b0`)**: ALWAYS arms flow+0x320/348
  uuids + flow+0xf1=1. Then requests state 0xe ONLY if: quest re-appear
  shortcut (`FUN_141f7e720` — quest ids 0x40xxxx only, checks record+0x11e +
  flow+0xf4≥2; always false for 0x84xxxx rooms) OR flow+0xf8, ELSE if
  quest-record byte **+0x22 == 0** (for quest_type 8; **+0x22 is the runtime
  copy of `isQuestStartFromBossAppear_`** — reader `FUN_141f7ea40`) AND
  current state ∈ {0xc,0xd}. I.e. flag=false ⇒ the action itself can fire a
  MID-GAME appear; flag=true ⇒ the action only arms.
- **Flag=true startup path**: WaitStartEvent(9) → `FUN_141f7ea40` true →
  waits for flow+0xf1 (the FSM must run the action during the hold!) → 3-tick
  countdown via flow+0x794 (prep fade/audio at 0, request at 1) → state 0xe.
- **State-0xe driver waits** (any can hold forever, returning 0xe): (a) boss
  telop block, gated `*(int*)(DAT_147c54810+4)==3`, needs a telop id from the
  map at flow+0x768 (unresolved risk for our rooms); (b) `DAT_147032d90+0x28`
  bit0; (c) `FUN_141f93920` = resolve(main uuid) + actor readiness
  (`FUN_140b461f0`) + sub-uuid readiness (sentinel `0x387722129228D27B` with
  empty subBossFSM_ string ⇒ ready). Then fires `boss_appear_event_default`
  (or mainBossFSM_) at the actor via `FUN_140b45dc0(actor,"enemy",name)`,
  camera (appear-point uuid flow+0x4d0==0 ⇒ falls back to the boss actor's
  own transform — safe), transitions toward 0xf.

## Builds 9–15 reinterpreted

- build9/10 (flag=false, graft post-activation): action armed +0xf1 while the
  flow was NOT yet in 0xc/0xd → request silently dropped; armed flag made the
  spawning boss held/hidden → HP bar + invisible boss, forever.
- build11 (flag=true, graft post-camera-gate): reception held in state 9
  waiting for +0xf1; FSM parked at the camera gate before the graft →
  deadlock → black screen. (The camera-gate conditions pass only in-game.)
- builds 12–15 (flag=true, graft pre-gate): armed → countdown → state 0xe →
  **resolve of a nonexistent key waited forever**. The frozen probe hashes at
  +0x18/20/28 were never the state field (that's +0x2d8, unsampled then).

## build16 — DEPLOYED 2026-07-28 late evening (live pending)

Exactly build15 with each room's grafted `mainBossUUID_` rewritten to
mix64(that room's EM8300 node mUuid[1]) — same-size cf-u64 swap, loose files
only, data.i untouched, md5-verified, game closed. Values (from the LIVE
deployed pa50 placements):

| room | was (build15 re-key) | now | = mix64(of) |
|---|---|---|---|
| 84a020 | 0x5423d01db25b461b | 0x91bdef638c47661b | 0xff4d8f9700b2061b |
| 847010 | 0x5423d01db25b4cda | 0xfc86257e21468cda | 0x872694b60169ccda |
| 847020 | 0x5423d01db25b5934 | 0xd6ce40c7001f1934 | 0x161c440301519934 |
| 849020 | 0x5423d01db25b6462 | 0x45dd3b04a41f2462 | 0x7cefe2b800576462 |
| 84e010 | 0x5423d01db25b674f | 0x2529b44aa35a874f | 0xbf522fe6012d674f |

EM8301-node mix64 values (for a future second BossAppearAction, Devil form):
84a020 10040870781541620575, 847010 18196272569165065435, 847020
15478380193837300021, 849020 5034244850663097443, 84e010
2677869697921673040. Scripts/backups: session 436260b1 scratchpad
(`build16.py`, `deploy_build16.py`, `build16/`, `build16_backup/`;
`verify_mix.py`; Ghidra logs `ghidra_batch*.log`, decompiles `batch*.c`).

**Probe upgraded + staged** (`src-tauri/hook-dbg.dll`, game-closed swap done):
`appear_flow` now samples flow+0x2d8 (state), +0x794 (countdown), +0x700..702
(driver latches), quest id +0x40; `appear_map` walker fixed to the real
resolver addressing (inner list +0x60 indirection, value-array stride 0x10)
and logs per-entry key + object type tag (+0x158) + world position (+0x170)
+ vtable RVA — map keys are now directly correlatable to placement nodes.

**Expected sequence on the harness save (849020) or a fresh C5 leg-1 gate:**
reception 9 → FSM pre-gate: arm (build16 uuid) → SendSignal (boss group
activation) → prologue 0002 (The World intro) → countdown → state 0xe →
resolve SUCCEEDS once the boss spawns → appear event + camera + telop →
0xf cinematic → fight, WITH the flow⇄boss binding that the scripted phases
(Quickening/orb) presumably need.

**Watch list:** (1) does the appear play and the boss spawn visible?
(2) if black screen again, the probe now pinpoints the wait: state stuck at
9 ⇒ arming/FSM problem; 0xe + our key ABSENT from `appear_map` ⇒ placement
node didn't register (unexpected); 0xe + key present ⇒ actor never spawned
(controller didn't act pre-gate) or the TELOP block (latches +0x700/701
still 0); (3) crash at RVA 0x1fd62a5 again ⇒ we reached 0xf with player[0]
null — then flip to the flag=false MID-GAME appear variant: parent the graft
behind a CheckReceptionState(0xc/0xd)-style condition so execute fires
in-game (quest 40a301's own 2nd-appear precedent; players guaranteed
present); (4) Devil form behavior; (5) Quickening vanish loop — the point of
it all.

**Rescue** unchanged: revert the 5 FSMs from `build16_backup/` (or phase3
via `graft_backup/` + `deploy_build11.py revert` for the flags), game
closed.

## build16 LIVE RESULT (2026-07-28 ~20:50, 849020 harness resume): HUGE progress, one hang left

User-visible: **The World intro (prologue 0002) plays, players spawn in the
pa50 arena** — then camera locked, no UI, boss not seen. Probe (upgraded
walker, 150 s):

- Scene map CONFIRMS the derivation live: scene0 keys = our build16 uuid →
  tag 0x301 @ (0,0,-12.4) (EM8300 node), the EM8301 node under exactly the
  precomputed mix64, player-spawn point tag 0x304. `appear_map` walker works.
- Flow: state 6 → 9 → (arm+0xe inside one tick) → **0xf, frozen 150 s**.
  Driver latches +0x700/701 = 01/01 (telop passed), resolve succeeded.

**State machine corrected (dispatcher found and decompiled):** the per-state
dispatch is a jumptable switch in the flow's update virtual — vtable slot 2:
quest `FUN_141fcec30`, endless `FUN_141fe5ee0` (0x1fe5ee0–0x1fe8ddd; Ghidra
had no refs — find such call sites by scanning .text for `e8 rel32`, NOT
XrefsTo). Mapping (endless): 0xe→FUN_141fd3bb0 (driver), **0xf→FUN_141fdc370
(wait-appear-event)**, 0x10→FUN_141fd5c70 (the old "cinematic"/crash fn —
misattributed before), 0x11→FUN_141fd7550, 0x12→FUN_141fea3c0. Case 0xf
remaps return 0x2b specially.

**The hang, exactly (FUN_141fdc370 decompiled = batch12.c):** state 0xf
returns 0xf until the BOSS ACTOR's FSM-event bookkeeping at
`actor+0x19b8/+0x19c0` clears: queue empty → completion, or the current
event entry (map at `*(q_e)-0x78`, key u32 node+0x20, value node+0x68,
**status int at value+0x38 == 2**) → completion. Completion fires
`multi_em8400/em7700/em1600_force_wait` (special-cased) or
`multi_boss_force_wait` at OTHER main-tier actors, `core_sys_appearev_out`,
returns 0x2b. There is also a SKIP path: `flow+0xeb` set →
"core_sys_appearev_skip_fadeout" → return 0x34 (the cutscene-skip system —
setBossAppearEventSkipInfo lambdas; worth trying the skip button while
stuck).

**What the appear event actually is:** `FUN_140b45dc0(actor, "enemy", name)`
runs the overlay FSM file `system/fsm/enemy/enemy_boss_appear_event_default_
fsm_ingame.msg` (3.7 KB, decoded): MotionPlayAction motionIdName_ **"9000"**
→ MotionEndCondition → "9001", plus a `QuestParameterCondition
boss_appear_skip` branch (quest 40a301 does NOT set it — it has only
CheckQuestParameter nodes; em7700 and em8000_hl have their own appear-event
FSM variants). **em8300 HAS em8300_9000.mot** (+seq effect/flags/se) — the
quest plays it — so the stall is NOT a missing motion. Eliminated:
preLoadQuestFSMFileInfos_ (empty names_ in BOTH 84f000 and 40a301),
startEventInfo_ (0 in both).

**Remaining hypothesis space:** (a) the event was fired (t≈3, during the
prologue movie) at an actor not yet able to accept it → never enqueued →
queue state never completes; (b) enqueued but the actor is dormant/held
(spawned with +0xf1 armed) and never processes it. **Probe upgraded to
discriminate:** `sample_boss` in appear_probe resolves the boss actor
exactly like FUN_141f7e8f0 (map → placement obj → vfunc slot 0x10 handle →
validation tables `DAT_1470214e8` +0x20/+0x48 → actor = *(a+0x70)) and logs
`ev=appear_boss`: actor/type/handle-flags, q_b/q_e, current event hash,
and each map entry's status. Built; staged via game-close watcher (or tray
→ "Reload hook (dev)"). ONE resume into the stuck gate names the exact
failure mode.

**Fix directions ranked:** (1) whatever the probe implicates (activation
ordering — 84f000 execs SendSignal BEFORE BossAppearAction; our graft order
is appear→send — or event refire); (2) hook-assist: refire
`FUN_140b45dc0(actor,"enemy","boss_appear_event_default")` when 0xf has
been stuck >N s; (3) set the `boss_appear_skip` quest parameter (needs a
Set-action node — NOT present in quest 40a301's FSM; vocabulary unverified)
to skip the motion but keep the binding; (4) flag=false + mid-game appear
(execute's own request path needs flow state 0xc/0xd + record+0x22==0 —
the quest's Devil-form precedent) so the room plays normally even if the
appear stalls.

## Second wave same evening — probe verdict, skip bounce, crash fact, build17

- **Probe verdict (`appear_boss`, stuck 849020 resume):** boss actor EXISTS
  (tid 0xd7ba6d4a), the appear event IS enqueued — one entry, key/cur_hash
  0x387121, **status 0 forever** — the actor never processes its FSM-event
  queue. Dormant/event-dead actor, not a delivery failure.
- **Skip-path experiment:** wrote `flow+0xeb=1` EXTERNALLY (python ctypes
  OpenProcess/RPM/WPM — script pattern in this session's transcript; verify
  chain mgr(base+0x7c54830)→flow(+0x210)→type 0x887ae0b0/state/uuid before
  writing). Flow took state 0x34 for ~1 s then **bounced back to 0xf**: the
  skip lambdas ALSO need the actor to process the force-complete. A dead
  actor defeats the skip path too.
- **Hot-reload crash fact:** re-injecting the hook into a session sitting in
  the stuck state crashed the game — AV inside hook-dbg.dll RVA 0x8e66c =
  `movaps [rsp+0x30],xmm7` stack-misalignment fault (WER reports read of
  0xffffffffffffffff) ~immediately after LoadLibrary. Injecting while the
  game hammers the hooked reception dispatcher every frame is racy. **Only
  inject at fresh game launch for now.** Also: after a failed inject the
  app's check_and_perform_hook loop EXITS — restart the dev app to get
  injection back.
- **Ordering insight → build17 (deployed via game-close watcher):** 84f000
  issues the activation (spawn request) BEFORE arming; build15/16 armed
  FIRST (a deliberate build15 choice justified by the now-disproven
  self-registration theory). build9's "dormant" observation doesn't
  contradict send-first (its uuid was unresolvable; the hide was
  ceremony-scoped). Hypothesis: spawn-requested-while-armed ⇒ event-dead
  actor. build17 = byte-level span swap in the 5 deployed FSMs so the graft
  order is SendSignal → BossAppearAction → prologue (same size, loose swap,
  scripts `build17.py`/`deploy_build17.py` + `build17_backup/` in session
  436260b1 scratchpad). **Watch:** intro plays → boss MATERIALIZES (motion
  9000) → camera/UI released → fight. If 0xf hangs again, fall back to
  flag=false + BAA in the build9 wait-state slot with the CORRECT uuid
  (= graft_build FSMs + uuid patch + flag revert): normal room start,
  mid-game appear per the quest's Devil-form pattern. Auto-skip stays in
  the probe (fires once after 20 stuck ticks; harmless bounce if the actor
  is dead).

## build17 FAILED (2026-07-28 ~21:40 live) — same-state ordering is NOT the discriminator. STOPPED HERE.

Resume into the 849020 gate on build17: identical hang. Probe: state 0xf
frozen, appear event still at **status 0** on the same actor
(tid 0xd7ba6d4a, cur_hash 0x387121); at 20 stuck ticks the probe's one-shot
auto-skip fired (`ev=appear_skip`) — user saw the short black fade — and the
flow bounced 0x34 → 0xf exactly like the external write. **Send-before-arm
within one FSM state does NOT wake the actor.** Either same-state actions
don't execute in file order, or the arm still lands before the spawn REQUEST
is processed (both nodes run the same tick), or dormancy isn't keyed on
request-vs-arm ordering at all. What actually differs from 84f000 remains:
(a) its send and arm sit in DIFFERENT states (≥1 tick apart), (b) em8200 vs
em8300 actor packages (em8300 has appear/appearfatequest BTs, em8200 has
none), (c) unknown actor-side wake mechanism.

**Deployed state at stop:** FSMs = build17 (flag TRUE, graft order
send→appear→prologue, correct mix64 uuids); placements dual-actor; baseinfos
= build11 flag-true. Harness save stuck at the 849020 gate (appear-hold
black-ish screen; Alt+F4 recoverable, NO crash). The room is NOT currently
playable — to give the user a playable game, either deploy the fallback
below or revert to phase3 (`graft_backup/` FSMs via the pattern in
"To make the game playable" §Builds 9–15, + `deploy_build11.py revert` for
the flags, + build16-value uuids are then irrelevant).

**Next agent — ranked options (all groundwork done):**
1. **flag=false + mid-game appear (Devil-form pattern, UNTESTED with the
   correct uuid):** baseinfos flag→false (`deploy_build11.py revert`), FSMs
   = build9 graft_build (BAA in the empty wait-state, entered right after
   activation) with mainBossUUID_ patched to the build16 mix64 values (the
   graft6→16 uuid patch logic in `build16.py` applies; spans identical).
   Key open question it answers: with flow in-game (0xc/0xd — the
   CheckReceptionState gate seems to sit BEFORE the wait state, so entry
   may already be in-game) the execute's own request fires against an
   AWAKE, visible boss — the appear then behaves like the quest's
   mid-battle Devil appear. If the request drops (state not yet 0xc/0xd at
   entry), nothing breaks: phase3 behavior (fight works, binding armed but
   ceremony never runs — Quickening test still possible? NO: resolve-side
   binding requires the appear chain to have run for some flow fields, but
   +0x320 armed alone may satisfy the scripted-phase resolves — ALSO worth
   observing).
2. **Find the actor wake mechanism in Ghidra:** what makes an enemy actor
   process FSM events; who suspends it during boss-appear spawn; how
   84f000/em8200 differs. Entry points: the spawn path reading flow+0xf1;
   `FUN_140b45dc0` (event enqueue — find the consumer that pops the queue
   at `actor+0x19b8` and what gates it); `FUN_141f8ddb0`/`FUN_141fdd5d0`
   (driver/0xf calls on the actor). The dispatchers are found by scanning
   .text for `e8 rel32` call sites (Ghidra has NO refs for them).
3. **Hook-assist wake:** once (2) names the suspended bit, the probe (which
   already resolves the actor) flips it — or force-completes the event
   entry (status→2 write is available but untested and skips the
   materialization).

**Session tooling added (436260b1):** `appear_boss` probe (actor resolve via
vfunc slot 0x10 + validation tables + event-queue dump), one-shot auto-skip
(20 stuck ticks → flow+0xeb=1), `start_if_active` (probe attaches on hook
load if an endless flow is live — needed after mid-game reloads, which are
currently UNSAFE anyway), external unstick script (ctypes WPM, verify-then-
write). Hook staged at `src-tauri/hook-dbg.dll`; inject at FRESH LAUNCH
only, and restart the dev app after any failed inject (its inject loop
exits).
