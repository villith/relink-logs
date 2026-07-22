# Per-window default columns (overlay vs. main) — design

**Date:** 2026-07-21
**Branch:** feat/perfect-guard-stun
**Status:** approved, pending implementation plan

## Problem

The DPS meter renders columns in two places, switched by the `live` prop:

- **Overlay** (`live=true`, the `main` Tauri window) — the transparent always-on-top meter.
- **Main window** (`live=false`, the `logs` Tauri window) — log history / quest details / settings.

Today the overlay reads its columns from the settings store (customizable), while the
main window reads **hardcoded** column arrays. The two are seeded with identical column
sets, so out of the box both windows show the same (fairly wide) columns. The overlay is
space-constrained and the wide default makes it cramped; the main window has room to spare.

We want the two windows to have **independent, separately-customizable** column sets, with
the overlay defaulting to a lean set and the main window defaulting to the full set.

Terminology in this doc: **overlay** = the meter overlay (Tauri label `main`); **main
window** = the history/details window (Tauri label `logs`, route `/logs`). To avoid
colliding with the `main` Tauri label, the new store keys use the `logs_` prefix.

## Current wiring (as-is)

- **Player columns (`MeterColumns`)**
  - Overlay: `overlay_columns` from `useMeterSettingsStore`.
  - Main: a hardcoded array `[TotalDamage, DPS, TotalStunValue, StunPerSecond, SupPercentage, DamagePercentage]`,
    **duplicated** in `Table.tsx` (header) and `usePlayerRow.ts` (body cells).
- **Skill columns (`SkillColumns`)**
  - Overlay: `overlay_skill_columns` from the store.
  - Main: `DEFAULT_SKILL_COLUMNS` (types.ts, all columns), hardcoded in `SkillBreakdown.tsx`.

## Design

### 1. New skill column: SPS (stun per second)

Add `SkillColumns.StunPerSecond = "stun-per-second"`.

- **Computed in the frontend**, mirroring the existing `StunPerEligibleHit` cell (which is
  also computed in-component). Value:
  `durationSeconds > 0 ? totalStunValue / durationSeconds : 0`, rendered `toFixed(2)` with no
  unit — matching the player-row SPS presentation.
- **Why frontend, not parser:** `SkillState` is updated incrementally without knowing the
  encounter duration. A per-update parser computation would freeze a skill's rate at the
  duration of its *last* stunning hit, overstating SPS for skills that stop stunning early.
  The correct value divides by the *final* encounter duration — which the frontend already
  has at render time.
- **Duration source:** `Table` computes
  `durationSeconds = max(0, encounterState.endTime - encounterState.startTime) / 1000` and
  threads it down `PlayerRow → SkillBreakdown → SkillRow / SkillGroupRow`. This equals the
  duration the parser uses for `player.stunPerSecond` (`last_event - start`), so per-skill
  SPS sums consistently with the player's SPS, live and in logs.
- New i18n keys in `en/ui.json`: `ui.skill-columns.stun-per-second` and
  `ui.skill-columns.stun-per-second-description`.

### 2. Default column constants (`types.ts`)

| Constant | Columns |
|---|---|
| `DEFAULT_OVERLAY_COLUMNS` | `TotalDamage, DPS, StunPerSecond, DamagePercentage` |
| `DEFAULT_OVERLAY_SKILL_COLUMNS` | `Hits, TotalDamage, MinDamage, MaxDamage, AverageDamage, StunPerSecond, DamagePercentage` |
| `DEFAULT_LOGS_COLUMNS` | `TotalDamage, DPS, TotalStunValue, StunPerSecond, SupPercentage, DamagePercentage` (today's main set) |
| `DEFAULT_LOGS_SKILL_COLUMNS` | full set: `Hits, TotalDamage, MinDamage, MaxDamage, AverageDamage, TotalStunValue, StunEligibleHits, StunPerEligibleHit, StunPerSecond, Overcap, DamagePercentage` |

- The overlay player set is `name` (always-on, rendered separately) + `DMG, DPS, SPS, %`.
- `DEFAULT_LOGS_COLUMNS` keeps today's 6-column main view unchanged on upgrade (no SBA);
  SBA stays addable via the new UI.
- `DEFAULT_SKILL_COLUMNS` is renamed to `DEFAULT_LOGS_SKILL_COLUMNS` (the full set); the
  `SkillRow.test.tsx` import is updated to match.

### 3. Store (`useMeterSettingsStore`)

- Add `logs_columns: MeterColumns[]` and `logs_skill_columns: SkillColumns[]`.
- Seed all four column keys from the new `DEFAULT_*` constants (overlay keys reseed to the
  lean sets; logs keys to the full/main sets).
- **Compatibility:** existing users keep their persisted `overlay_columns` /
  `overlay_skill_columns`. The two new `logs_*` keys are absent from their persisted blob, so
  Zustand's shallow merge fills them from the defaults — no version bump, no migration. The
  existing migrate step (strips removed `damage-cap`/`overcap` from `overlay_columns`) is
  unchanged.

### 4. Wiring changes

- `Table.tsx` + `usePlayerRow.ts`: `const columns = live ? overlay_columns : logs_columns`
  (both read the same store value, removing the current duplication).
- `SkillBreakdown.tsx`: `const columns = live ? overlay_skill_columns : logs_skill_columns`.

### 5. Settings UI

Four column editors instead of two. Extract a reusable `<ColumnEditor>` component (label +
add-menu + drag/drop list + remove) and a generic list-handler factory in `useSettings`
(reorder/add/remove parameterized by the store key). Render 4× under two headings:

- **"Overlay columns"** — player + skill (existing behavior).
- **"Main window columns"** — player + skill (new).

New heading strings go in `en/ui.json` (the only hand-editable lang file).

### 6. Testing

- Frontend: extend `SkillRow.test.tsx` to cover the SPS cell, including the divide-by-zero
  (duration 0 → 0) guard. Add a store test asserting overlay and logs defaults are distinct
  sets (guards against a future copy-paste re-coupling them).
- Rust: no new tests; existing `skill_state.rs` tests stay green (SPS is frontend-only).

## Addendum (2026-07-21): main-window columns move into quest details

Follow-up UX change after the initial implementation shipped. The main-window
column editing moves **out of the Settings page** and **into the quest-details
page**, inline near the table (the pattern chart/grid UIs use), with a different
UX than the Settings drag-list.

- **Pattern:** a compact **`[▤ Columns ▾]`** button (Columns icon + text) in the
  window-status toolbar `Group` above the meter table (`View.tsx`), opening a
  Mantine `Popover` containing the two existing `ColumnEditor`s (Player Row +
  Skill Breakdown), bound to `logs_columns` / `logs_skill_columns`.
- **Shared hook:** the `makeColumnControls` factory moves out of `useSettings`
  into a reusable `useColumnControls()` hook (`src/components/useColumnControls.ts`)
  returning `overlayPlayer` / `overlaySkill` / `logsPlayer` / `logsSkill` bundles.
  Settings uses the overlay pair; the popover uses the logs pair.
- **Settings:** the "Main Window Columns" section is removed; "Overlay Columns"
  stays.
- **Persistence:** unchanged — same `logs_*` store keys (global, persisted).
  `Table` / `usePlayerRow` / `SkillBreakdown` are unaffected.

## Out of scope

- No change to how columns render individually (cell formatting untouched apart from the new
  SPS cell).
- No parser/protocol changes.
- No new player-row (`MeterColumns`) column — SPS already exists there.

## Files touched

- `src/types.ts` — SPS enum member; four default constants; rename `DEFAULT_SKILL_COLUMNS`.
- `src/stores/useMeterSettingsStore.ts` — two new keys + reseeded defaults.
- `src/components/Table.tsx`, `src/components/usePlayerRow.ts` — logs vs overlay player columns; duration prop.
- `src/components/SkillBreakdown.tsx` — logs vs overlay skill columns; duration prop.
- `src/components/SkillRow.tsx`, `src/components/SkillGroupRow.tsx` — SPS cell + duration prop.
- `src/pages/Settings.tsx`, `src/pages/useSettings.ts` — `<ColumnEditor>` extraction + 4 editors + handler factory.
- `src-tauri/lang/en/ui.json` — SPS column strings + two section headings.
- `src/components/SkillRow.test.tsx` — SPS cell tests; updated default-constant import.
