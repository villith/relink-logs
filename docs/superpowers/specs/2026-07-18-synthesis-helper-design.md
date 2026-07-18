# Synthesis Helper — Design

Date: 2026-07-18
Status: Approved (design review with Scott, this session)

## Goal

Sigil Synthesis combines two sigils into one. The result looks random but is
deterministic: for a fixed RNG state, the pair (A, B) always produces the same
result sigil, and the state changes only when a quest completes or a synthesis
is performed. The Synthesis Helper inverts this: the user describes the result
they want — trait X in slot 1, trait Y in slot 2, level 15 — and the tool
searches every pair of sigils in their inventory and lists the pairs that
produce it.

The tool lives on a new **Toolbox** page in the logs window.

## What the game does (reverse-engineered)

Source: the Smart Synthesis Reloaded-II mod (nexus 602) provided two unique
AOB signatures; both match once in game v2.0.2. Decompiled in the existing
`gbfr202fast` Ghidra DB.

- **Prospect-list generator** — `FUN_14402eda0`, entry RVA `0x402eda0`.
  Builds the preview list shown in the synthesis UI. Synthesis UI object:
  `+0x554` highlighted index, `+0x398` prospect count, `+0x3a0` prospect
  array (stride 0x24: trait1 at +0, trait2 at +8).
- **Synthesis commit** — `FUN_141ce5e80`, entry RVA `0x1ce5e80` (the mod's
  override site `0x1ce6287` is inside it). The algorithm:
  1. Read the two selected sigil UIDs from `synthCtx+0x7b4` / `+0x7b8`
     (`synthCtx` = `DAT_147c228d0`).
  2. Compute a warm-up count from the pair: trait ids of both sigils (map
     lookup keyed by FNV-1a of the UID; `0x887ae0b0` is the "no trait"
     sentinel, counted as 0), both sigil ranks, a **per-pair synthesis
     counter** (map at `sigilMgr+0x2e0`, keyed by a pair-derived sum) times
     9, plus the second UID. Take the total **mod 1000**; advance the shared
     RNG that many times.
  3. Roll level: `rand() % (w_lo + w_hi)` against weights from
     `FUN_140346080(A, B)` decides level 11 vs 15.
  4. Build the candidate trait list `FUN_140345d30(A, B)`, sort it
     (`FUN_140346150`), Fisher-Yates shuffle it with the same RNG stream.
     `candidates[0]` and `candidates[1]` become the result's trait slots —
     so slot order is predictable.
- **RNG** — `FUN_14038f310`, state at `DAT_147c23e40`. Streams are slots
  (synthesis uses slot `0x81`); state table of `0x83` u32 slots with a
  current index at `+0x20c`. Algorithm not yet decompiled — first
  implementation task.
- **Sigil manager** — `DAT_147c20940`. Holds inventory, the UID→traits map
  (`+0x37f98`), the per-pair counter map (`+0x2e0`), and the candidate/weight
  tables.
- `FUN_14079d820` is an anti-tamper checksum updater; we never write game
  memory, so it does not affect us.

Exact prediction requires the sigil **instance UIDs**, not just trait
combinations: the warm-up count hashes the UIDs, so two sigils with identical
traits are different inputs. This is why the tool reads game memory instead of
accepting manually entered sigils.

## Architecture

Three parts, all inside the existing app. The hook DLL is untouched.

### 1. Prediction engine (Rust, `src-tauri`)

A pure module: `predict(snapshot, pair) -> {trait1, trait2, level}`.
Port of the RNG and the commit algorithm above. Because it is pure, unit
tests can replay captured snapshots and known outcomes.

Search: for a query (trait1, trait2, order, level-15 required), first filter
the inventory to sigils whose traits can contribute to the requested combo,
then run `predict` over the surviving pairs. Worst case (~3000 sigils,
~4.5M pairs) is seconds of compute; the filtered case is far smaller.

### 2. State snapshot (Rust, `src-tauri`)

The Tauri backend opens the game process read-only (`ReadProcessMemory`) and
copies out: the RNG state block, the sigil inventory (UID, item id, trait
ids, levels), and the per-pair counter map. Global RVAs are resolved by
sigscanning the exe on disk (same patterns the hook uses; pelite is already
a dependency). Snapshots are user-triggered; a snapshot is a plain struct
handed to the engine.

New Tauri commands:

- `fetch_synthesis_snapshot()` → snapshot summary (game running? sigil
  count, state timestamp) or a "game not running" error.
- `search_synthesis(query)` → list of `{sigil_a, sigil_b, result}` where
  each sigil is `{uid, name_hash, trait1, trait2, level}`.

### 3. Toolbox UI (React, `src/`)

- Header: a **Toolbox** button (Wrench icon) left of Settings →
  `/logs/toolbox`.
- `Toolbox.tsx`: 300px fixed side menu (Mantine NavLink list) + tool panel.
  Routes: `/logs/toolbox` redirects to `/logs/toolbox/synthesis`; the only
  entry so far is **Synthesis Helper**.
- Synthesis Helper panel: two searchable trait selects (names from the
  existing `sigils.json` translations), an "exact order / either order"
  toggle, a "must be level 15" checkbox, a Search button, and a Refresh
  Snapshot button showing snapshot age.
- Results table: one row per pair — each source sigil rendered as
  "Name (Trait A + Trait B, lvl N)" so the user can find it in their box —
  plus the predicted result and level.
- Empty states: game not running; no pairs found.

## Result validity

A prediction holds until the RNG state changes: completing a quest or
performing any synthesis invalidates it. The results header states this and
shows when the snapshot was taken.

## Error handling

- Game not running / process open fails → friendly page state, no crash.
- Sigscan miss (game patched) → explicit "unsupported game version" error,
  same pattern as the hook's signature failures.
- Memory read races (user is in a menu mutating inventory) → snapshot reads
  are validated (counts bounded, pointers checked); a torn read returns an
  error inviting a refresh rather than wrong predictions.

## Testing and validation

1. **RNG replication**: capture the RNG state, advance it in-game (perform
   syntheses), verify our port produces the same sequence.
2. **End-to-end ground truth**: predict the result for a chosen pair, then
   actually synthesize that pair in-game and compare. Repeat across quest
   completions (seed changes) and repeated same-pair syntheses (counter
   increments).
3. **Engine unit tests** on captured snapshots (pure Rust, no game needed).
4. Frontend: Vitest for the query form / results rendering.

## Milestones

1. **RE + engine**: decompile `FUN_14038f310`, `FUN_140345d30`,
   `FUN_140346080`, `FUN_140346150`; port to Rust; validate against live
   game (steps 1–2 above). This is the risk; everything else is routine.
2. **Snapshot plumbing**: process-memory reader + the two Tauri commands.
3. **UI**: Toolbox page + Synthesis Helper panel.

Fallback if milestone 1 stalls: the tool ships listing *possible* outcomes
per pair (candidate combos without the exact pick) — same UI, weaker claim.

## Out of scope

- Multi-step planning ("synthesize C+D first, then A+C").
- Forcing results (that is the mod's job, not ours).
- Writing anything to game memory.
