# Conflux (Endless) Runs — Design Spec

**Date:** 2026-07-11
**Branch:** `fix/xpac`
**Status:** Approved (design direction), remaining decisions delegated for autonomous implementation.

## Goal

Represent Conflux (Endless) roguelike runs in GBFR Logs. A **run** is a sequence of
**rooms**; each room is a distinct combat with its own damage meter (reusing the existing
per-encounter save mechanic). Runs appear grouped in a dedicated "Conflux" tab in the logs
window. A run row expands to reveal its room breakdown, per-room damage-meter summaries, and
the buffs (Conflux upgrades) acquired in each room.

## Background & constraints

- **Endless mode is single-player.** Buffs are never attributed to a specific player.
- The Conflux hooks currently in `src-hook/src/hooks/endless.rs` and the block in
  `quest.rs` are **`hookdiag`-only diagnostics** — they log to a file and emit no protocol
  messages. The run/room/run-end/buff signals have been *decoded* from those diagnostics.
  This feature promotes them to real, always-on hooks that emit `protocol::Message`s.
- The parser already **cuts off and saves an encounter per quest** on `on_area_enter_event`
  / `on_quest_complete_event` (one row per encounter in the `logs` table). Each Conflux room
  is an isolated quest load, so a room maps directly onto this existing save-per-encounter
  mechanic.
- Wire format between hook and parser is **bincode** (`protocol` crate). Adding new `Message`
  variants is backward-safe. The parser's on-disk `Encounter` (CBOR+zstd) and the `logs` DB
  schema must stay backward-compatible; DB changes are **append-only migrations**.

## Signals (hook layer)

Four diagnostic hooks are promoted to real emitters. Each still uses its existing,
sigscan-verified v2.0.2 signature; only the body changes from `diag::ev!` logging to
`tx.send(Message::…)`.

| Signal | Source hook | New `Message` | Fires when |
|---|---|---|---|
| Run start | `OnReceptionFlowDispatchHook` (`FUN_140638690`, quest_type 8) | `ConfluxRunStart` | reception flow slot transitions **to** an EndlessMode flow |
| Room enter | `OnLoadQuestHook` (`on_load_quest_state`), when reception-flow indicates in-run | `ConfluxRoomEnter { quest_id }` | each room load inside a run |
| Run end | `OnEndlessMgrDtorHook` (`EndlessModeQuestManager` dtor) | `ConfluxRunEnd` | run concludes (reward/exit) |
| Buff acquired | `OnEndlessBuffInstallHook` (`ExPlayerEndlessModeBuff::onInstall`) | `ConfluxBuffAcquired { buff_id }` | a Conflux upgrade installs |

Notes:
- All four hooks remain **observe-only pass-throughs** — args are forwarded unchanged to the
  original function (a dropped arg crashed hooks on v2.0.2). We add a `tx.send` before/after
  the passthrough; we never alter behaviour.
- Because the promoted hooks now need `event::Tx`, their `new()` gains a `tx` parameter (like
  `OnQuestCompleteHook`), and `setup_hooks` passes `tx.clone()`.
- The `hookdiag` diagnostic bodies are preserved under `#[cfg(feature = "hookdiag")]` where
  still useful; the real emission is unconditional.
- **Buff-ID reliability is the known risk.** `onInstall` may fire repeatedly during RNG init.
  The parser dedups buff IDs per run. If clean IDs prove impossible to capture, the buff
  display degrades gracefully (empty buff lists) while rooms + grouping + meters still work.

## Data model

### `runs` table (new, append-only migration)

```
runs (
  id            INTEGER PRIMARY KEY,
  start_time    INTEGER NOT NULL,   -- ms since epoch, run start
  end_time      INTEGER,            -- ms since epoch, run end (null until ended)
  duration      INTEGER,            -- ms, sum-ish/end-start (null until ended)
  room_count    INTEGER NOT NULL DEFAULT 0,
  completed     BOOLEAN,            -- null=in progress, true/false at end
  buffs         TEXT                -- JSON: [{ "roomIndex": u32, "buffIds": [u32,...] }]
)
```

Buffs are stored as JSON on the run row (single-player, run-scoped, small) rather than a
third table. `roomIndex` is the room active when each buff installed → per-room deltas.

### `logs` table (existing) — new columns (append-only migration)

```
ALTER TABLE logs ADD COLUMN run_id     INTEGER;   -- FK to runs.id, null for normal quests
ALTER TABLE logs ADD COLUMN room_index INTEGER;   -- 0-based order within the run, null otherwise
```

A room is a normal `logs` row (full encounter, individually viewable/deletable) tagged with
its `run_id` + `room_index`. Non-Conflux quests keep both columns null and are unchanged.

### Run identity ownership

The **parser** owns run identity; the hook only sends signals.
- On `ConfluxRunStart`: insert a `runs` row (start_time = now, room_count 0), store the new
  `runs.id` as the parser's `active_run_id` and reset `active_room_index = 0` and the buff
  accumulator.
- On `ConfluxRoomEnter`: behave like `on_area_enter_event` — stop & save the previous room's
  encounter (stamped with `active_run_id` + `active_room_index`), increment room_count and
  `active_room_index`, start a fresh encounter.
- On `ConfluxBuffAcquired`: append `buff_id` (dedup per run) to the buff accumulator, tagged
  with `active_room_index`.
- On `ConfluxRunEnd`: save the final room, write end_time/duration/completed/buffs JSON to the
  `runs` row, clear `active_run_id`, and emit a `conflux-run-saved` Tauri event.
- Defensive: if `ConfluxRoomEnter`/buff arrives with no `active_run_id` (missed the start),
  they are ignored for run purposes and the room saves as a normal encounter (run_id null).

## Backend surface (Tauri)

- **New command `fetch_conflux_runs(page: Option<u32>) -> ConfluxSearchResult`**: paginated
  runs, newest first, each with its nested room summaries (id, room_index, primary_target,
  duration, total_damage, quest_id, completed) and parsed buff deltas. Room summaries come
  from the `logs` rows where `run_id = ?` ordered by `room_index`; total_damage per room is
  read from the room's stored encounter (or a cheap summary column — see plan).
- **Room "View" reuses the existing** `fetch_encounter_state(id)` + `/logs/:id` route — no new
  per-room view.
- Register `fetch_conflux_runs` in `generate_handler!`.
- Wire the four new `Message` variants in `connect_and_run_parser`'s match to their parser
  handlers.

## Frontend

- **New route `/logs/conflux`** + a "Conflux" `NavLink` in `src/pages/Logs.tsx` (Flag/again
  icon from `@phosphor-icons/react`).
- **`src/pages/logs/ConfluxIndex.tsx`** + **`useConfluxIndex.tsx`** (companion hook, matching
  the `Index.tsx`/`useIndex.tsx` pattern): a Mantine `Table` of runs. Each run row shows run
  start date, a "Conflux Run" label, total duration, a `×N rooms` badge, and overall outcome
  ✓/✗, with a `▸` chevron. Expanding reveals inline sub-rows: one per room (room #, primary
  target, duration, a compact damage summary, a "View" button → `/logs/:id`) followed by a
  per-room **buff delta** list (buff names via i18n, raw ID if untranslated).
- Refresh the run list on the `conflux-run-saved` Tauri event (mirrors `encounter-saved` in
  `useIndex`).
- **Types** in `src/types.ts`: `ConfluxRun`, `ConfluxRoom`, `ConfluxBuffDelta`,
  `ConfluxSearchResult` mirroring the Rust serde (camelCase).
- Buff name translation: `t('conflux-buffs:${buffId}', String(buffId))` fallback to raw ID.

## Testing strategy

- **Parser (Rust, TDD):** unit tests on the `v1::Parser` for the run lifecycle:
  run-start creates active run; room-enter saves prior room stamped with run_id/room_index and
  increments; buff-acquired accumulates under the active room and dedups; run-end finalizes the
  run row (duration/completed/buffs). Tests operate on parser state + an in-memory sqlite
  connection (the parser already takes a `Connection`).
- **Protocol:** covered transitively; adding variants is compile-checked.
- **DB migrations:** a test that `setup_db` runs cleanly to latest on a fresh + on an existing
  (pre-runs) database, and that `runs`/new columns exist.
- **Frontend:** the existing Vitest setup covers utils; the Conflux UI is verified by the user
  running the app against a live game (per project convention — no Rust-side integration
  harness).
- **Manual/live:** user drives a Conflux run in-game to confirm signals fire and rooms group.

## Out of scope

- Live in-overlay per-run display in the transparent Meter window (this feature targets the
  logs history window). The existing live meter still shows the current room's encounter.
- Buff→player attribution (single-player, N/A).
- A separate per-room detail page (rooms reuse `/logs/:id`).
