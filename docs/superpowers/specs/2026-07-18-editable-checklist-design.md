# Editable Build Checklist — Design

**Date:** 2026-07-18
**Status:** Approved

## Goal

Let users customize the Builds-tab checklist (currently hardcoded in
`src/utils.ts`) from the Settings tab: adjust required levels, enable/disable
entries, and add/remove entries. The default criteria move into a bundled
`.json` file.

## Current state

- `BUILD_CHECKLIST` (12 entries) and `AI_CHECKLIST` (1 entry) are hardcoded
  `ChecklistEntry[]` constants in `src/utils.ts`. An entry is
  `{ ids: number[], level: number }` — trait-id hashes whose levels sum toward
  a required level; `ids[0]` provides the display name.
- `src/pages/logs/View.tsx` renders them in the Builds tab via
  `ChecklistEntryRow`, using `checklistLevel` / `checklistStatus` from utils.
- The Computed rows (sigil-category counts, `SIGIL_CATEGORY_TARGET`) are a
  separate mechanism and are **out of scope** — they stay hardcoded.
- Settings persist via Zustand `persist` to localStorage
  (`useMeterSettingsStore`, `withStorageDOMEvents` for cross-window sync).
- Trait names come from the i18next `traits` namespace, loaded at runtime from
  `src-tauri/lang/<lang>/traits.json`.

## Design

### 1. Default-criteria JSON

New `src/assets/checklist-default.json`:

```json
{
  "build": [
    { "ids": ["4c588c27"], "level": 15 },
    { "ids": ["dc584f60", "0151cf9e", "3b71af12", "aefeb1bc", "fff8cf64"], "level": 65 }
  ],
  "ai": [{ "ids": ["a8a3163b"], "level": 15 }]
}
```

- Ids are lowercase 8-char hex strings — the same form as the lang-file keys,
  so the file is human-readable and hand-editable.
- The `BUILD_CHECKLIST` / `AI_CHECKLIST` constants are deleted from
  `utils.ts`. A loader converts hex strings to numeric ids
  (`parseInt(id, 16)`); the existing `ChecklistEntry` type and the
  `checklistLevel` / `checklistStatus` helpers are unchanged.

### 2. Checklist store

New `src/stores/useChecklistStore.ts` — Zustand + `persist`, storage key
`checklist-settings`, wired through the existing `withStorageDOMEvents`.

```ts
type ChecklistSetting = { ids: number[]; level: number; enabled: boolean };
type ChecklistGroup = "build" | "ai";

interface ChecklistState {
  build: ChecklistSetting[];
  ai: ChecklistSetting[];
  setLevel(group: ChecklistGroup, firstId: number, level: number): void;
  toggle(group: ChecklistGroup, firstId: number): void;
  remove(group: ChecklistGroup, firstId: number): void;
  add(group: ChecklistGroup, traitId: number, level: number): void;
  reset(): void;
}
```

- Initial state: the bundled JSON with `enabled: true` on every entry.
- Entries are keyed by `ids[0]` (unique within a group). `add` creates
  single-id entries and rejects a trait already present in the group;
  multi-id groups (the DMG Cap stack) exist only via defaults and keep their
  grouped ids through level edits/toggles.
- `reset()` restores both groups to the bundled defaults.
- Persisted edits are a full snapshot: after a user edits, future changes to
  the shipped defaults do not auto-merge (accepted trade-off; Reset picks
  them up).

### 3. View.tsx consumption

The Builds-tab checklist cell reads `build` and `ai` from the store, filters
each to `enabled`, and renders exactly as today (same row component, status
icons, source tooltips, alphabetical-by-name sort). A group whose entries are
all disabled (or removed) hides that group's header. The Computed rows are
untouched.

### 4. Settings UI

New `Fieldset` legend "Checklist" in `src/pages/Settings.tsx` below the meter
settings, with the logic in `useSettings.ts` (or a small companion hook)
following the page's existing pattern. Contents:

- Two sections, matching the display groups: **Sigils** (`build`) and **AI**
  (`ai`).
- One row per entry: enabled `Checkbox` · trait name (`translateTraitId`) ·
  `NumberInput` for the required level (min 1, clamped integer) · remove
  `ActionIcon`.
- Per section, an "Add trait" searchable `Select` listing all traits from the
  loaded i18next `traits` bundle, name-sorted, minus traits already in the
  group. Selecting adds the entry at level 15, enabled.
- A "Reset to defaults" `Button` at the bottom restoring both groups.

New `ui.json` strings (en; other languages fall back): section legend, add
placeholder, reset label.

### 5. Testing

- Vitest: store logic (default seeding, `setLevel`/`toggle`/`remove`,
  duplicate-`add` rejection, `reset`) and the hex→numeric loader.
- Manual: Settings edits reflect immediately in an open log's Builds tab;
  values survive an app restart.

## Out of scope

- Computed sigil-category rows (targets stay hardcoded).
- Authoring multi-id groups in the UI.
- Exporting/importing checklist files or an on-disk user JSON.
- Migrating/merging shipped default changes into existing user edits.
