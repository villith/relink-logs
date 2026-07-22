# Move Main-Window column editing into quest details — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the main-window column editors from Settings and expose them inline on the quest-details page via a compact "Columns" popover next to the meter table.

**Architecture:** Extract the column add/remove/reorder logic into pure helpers + a shared `useColumnControls()` hook (out of `useSettings`). A new `<ColumnsPopover>` renders the two existing `ColumnEditor`s (Player Row + Skill Breakdown) bound to the `logs_*` store keys, and drops into the quest-details window-status toolbar. Settings keeps only the overlay editors. Persistence is unchanged (same `logs_columns` / `logs_skill_columns` store keys).

**Tech Stack:** React + TypeScript, Zustand, Mantine (`Popover`), @hello-pangea/dnd, Vitest.

**Verification commands:** `npx tsc --noEmit` · `npx vitest run` · `npm run lint`

---

## Task 1: Extract pure column helpers + `useColumnControls` hook (TDD)

**Files:**
- Create: `src/components/useColumnControls.ts`
- Test: `src/components/useColumnControls.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/useColumnControls.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { addColumn, availableColumns, removeColumn, reorderColumns } from "./useColumnControls";

describe("column helpers", () => {
  it("availableColumns excludes selected and excluded entries", () => {
    expect(availableColumns(["a", "b"], ["a", "b", "c", "name"], ["name"])).toEqual(["c"]);
  });

  it("addColumn appends only when absent (idempotent)", () => {
    expect(addColumn(["a"], "b")).toEqual(["a", "b"]);
    expect(addColumn(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("removeColumn drops the entry", () => {
    expect(removeColumn(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("reorderColumns moves an item from one index to another", () => {
    expect(reorderColumns(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/useColumnControls.test.ts`
Expected: FAIL — module/exports don't exist.

- [ ] **Step 3: Implement the hook + helpers**

Create `src/components/useColumnControls.ts`:

```ts
import { DropResult } from "@hello-pangea/dnd";
import { useShallow } from "zustand/react/shallow";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { MeterColumns, SkillColumns } from "@/types";

export type ColumnControls = {
  columns: string[];
  available: string[];
  onAdd: (column: string) => void;
  onRemove: (column: string) => void;
  onReorder: (result: DropResult) => void;
};

/** Columns from `allColumns` not already selected (and not structurally excluded,
 * e.g. the always-on Name column). */
export const availableColumns = (columns: string[], allColumns: string[], excluded: string[] = []): string[] =>
  allColumns.filter((column) => !columns.includes(column) && !excluded.includes(column));

/** Append a column if not already present (idempotent). */
export const addColumn = (columns: string[], column: string): string[] =>
  columns.includes(column) ? columns : [...columns, column];

/** Remove a column. */
export const removeColumn = (columns: string[], column: string): string[] =>
  columns.filter((item) => item !== column);

/** Move the item at `startIndex` to `endIndex`, returning a new array. */
export const reorderColumns = <T>(list: T[], startIndex: number, endIndex: number): T[] => {
  const result = Array.from(list);
  const [removed] = result.splice(startIndex, 1);
  result.splice(endIndex, 0, removed);
  return result;
};

type ColumnKey = "overlay_columns" | "overlay_skill_columns" | "logs_columns" | "logs_skill_columns";

/** Builds add/remove/reorder controllers for each persisted column list. Shared by
 * the overlay settings and the quest-details columns popover. */
export const useColumnControls = () => {
  const { overlay_columns, overlay_skill_columns, logs_columns, logs_skill_columns, setMeterSettings } =
    useMeterSettingsStore(
      useShallow((state) => ({
        overlay_columns: state.overlay_columns,
        overlay_skill_columns: state.overlay_skill_columns,
        logs_columns: state.logs_columns,
        logs_skill_columns: state.logs_skill_columns,
        setMeterSettings: state.set,
      }))
    );

  const make = (key: ColumnKey, columns: string[], allColumns: string[], excluded: string[] = []): ColumnControls => ({
    columns,
    available: availableColumns(columns, allColumns, excluded),
    onReorder: (result) => {
      if (!result.destination) return;
      setMeterSettings({
        [key]: reorderColumns(columns, result.source.index, result.destination.index),
      } as Partial<Parameters<typeof setMeterSettings>[0]>);
    },
    onAdd: (column) => {
      setMeterSettings({ [key]: addColumn(columns, column) } as Partial<Parameters<typeof setMeterSettings>[0]>);
    },
    onRemove: (column) => {
      setMeterSettings({ [key]: removeColumn(columns, column) } as Partial<Parameters<typeof setMeterSettings>[0]>);
    },
  });

  const meterColumnValues = Object.values(MeterColumns);
  const skillColumnValues = Object.values(SkillColumns);

  return {
    overlayPlayer: make("overlay_columns", overlay_columns, meterColumnValues, [MeterColumns.Name]),
    overlaySkill: make("overlay_skill_columns", overlay_skill_columns, skillColumnValues),
    logsPlayer: make("logs_columns", logs_columns, meterColumnValues, [MeterColumns.Name]),
    logsSkill: make("logs_skill_columns", logs_skill_columns, skillColumnValues),
  };
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/components/useColumnControls.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** (skip if honoring "commit only when asked").

---

## Task 2: Create the ColumnsPopover

**Files:**
- Create: `src/components/ColumnsPopover.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/ColumnsPopover.tsx`:

```tsx
import { Box, Button, Popover, Stack, Text } from "@mantine/core";
import { CaretDown, Columns } from "@phosphor-icons/react";

import { ColumnEditor } from "./ColumnEditor";
import { useColumnControls } from "./useColumnControls";

/** Inline column picker for the quest-details meter table: edits the main-window
 * player-row and skill-breakdown columns (persisted globally, all logs). Not
 * wrapped in a ScrollArea — @hello-pangea/dnd misbehaves inside transformed
 * scroll containers; the popover grows to fit instead. */
export const ColumnsPopover = () => {
  const { logsPlayer, logsSkill } = useColumnControls();

  return (
    <Popover width={320} position="bottom-end" shadow="md" withinPortal>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={<Columns size={14} />}
          rightSection={<CaretDown size={12} />}
        >
          Columns
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Box mah={460} style={{ overflowY: "auto" }}>
          <Stack gap="md">
            <Text size="xs" c="dimmed">
              Columns for the quest-details meter (applies to all logs).
            </Text>
            <ColumnEditor
              title="Player Row"
              droppableId="logs-player-columns"
              translationPrefix="ui.meter-columns"
              columns={logsPlayer.columns}
              available={logsPlayer.available}
              onAdd={logsPlayer.onAdd}
              onRemove={logsPlayer.onRemove}
              onReorder={logsPlayer.onReorder}
            />
            <ColumnEditor
              title="Skill Breakdown"
              droppableId="logs-skill-columns"
              translationPrefix="ui.skill-columns"
              columns={logsSkill.columns}
              available={logsSkill.available}
              onAdd={logsSkill.onAdd}
              onRemove={logsSkill.onRemove}
              onReorder={logsSkill.onReorder}
            />
          </Stack>
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

---

## Task 3: Wire ColumnsPopover into quest details; remove the Settings main-window section

**Files:**
- Modify: `src/pages/logs/View.tsx` (add the popover to the toolbar Group)
- Modify: `src/pages/Settings.tsx` (drop main-window editors; overlay editors from `useColumnControls`)
- Modify: `src/pages/useSettings.ts` (remove all column logic)

- [ ] **Step 1: Add the popover to `View.tsx`**

Add the import near the other `@/components` imports:

```tsx
import { ColumnsPopover } from "@/components/ColumnsPopover";
```

In the window-status `Group` (the `<Group gap="xs" align="center" wrap="nowrap" h={22}>` just above `<MemoMeterTable`), add the popover as the last child, right-aligned:

```tsx
                <Group gap="xs" align="center" wrap="nowrap" h={22}>
                  {windowActive ? (
                    <>
                      {/* …existing badge/text/reset button… */}
                    </>
                  ) : (
                    <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {t("ui.logs.window-full")} · {fullDuration}
                    </Text>
                  )}
                  <Box ml="auto">
                    <ColumnsPopover />
                  </Box>
                </Group>
```

(`Box` is already imported in `View.tsx`.)

- [ ] **Step 2: Update `Settings.tsx` — overlay editors via `useColumnControls`, drop main-window section**

Add the import:

```tsx
import { useColumnControls } from "@/components/useColumnControls";
```

Remove the four column bundles from the `useSettings()` destructure (they no longer exist there):

```tsx
    setMeterSettings,
    languages,
    handleLanguageChange,
    open_log_on_save,
    auto_check_updates,
  } = useSettings();

  const { overlayPlayer, overlaySkill } = useColumnControls();
```

Replace the entire column block (the `<Divider /> Overlay Columns …` through the last Main-Window `<ColumnEditor />`) with only the two overlay editors, now bound to the hook:

```tsx
          <Divider />
          <Text size="md" fw={700}>
            Overlay Columns
          </Text>
          <ColumnEditor
            title="Player Row"
            droppableId="overlay-player-columns"
            translationPrefix="ui.meter-columns"
            columns={overlayPlayer.columns}
            available={overlayPlayer.available}
            onAdd={overlayPlayer.onAdd}
            onRemove={overlayPlayer.onRemove}
            onReorder={overlayPlayer.onReorder}
          />
          <ColumnEditor
            title="Skill Breakdown"
            droppableId="overlay-skill-columns"
            translationPrefix="ui.skill-columns"
            columns={overlaySkill.columns}
            available={overlaySkill.available}
            onAdd={overlaySkill.onAdd}
            onRemove={overlaySkill.onRemove}
            onReorder={overlaySkill.onReorder}
          />
```

- [ ] **Step 3: Strip column logic from `useSettings.ts`**

Remove: the `reorder` helper, the `makeColumnControls` factory, the `ColumnKey` type, `meterColumnValues` / `skillColumnValues`, the four `*Columns` bundles, and the four column store reads (`overlay_columns`, `overlay_skill_columns`, `logs_columns`, `logs_skill_columns`) from both the destructure and the selector. Remove the four bundles from the returned object.

Remove now-unused imports: `MeterColumns`, `SkillColumns` from `@/types`, and `DropResult` from `@hello-pangea/dnd` (delete that import line entirely if `DropResult` was its only member).

The resulting `useSettings` returns only: `color_1..4`, `transparency`, `show_display_names`, `streamer_mode`, `show_full_values`, `use_condensed_skills`, `setMeterSettings`, `languages`, `handleLanguageChange`, `open_log_on_save`, `auto_check_updates`.

- [ ] **Step 4: Typecheck and fix unused imports**

Run: `npx tsc --noEmit`
Expected: exit 0. If `Settings.tsx` now has unused Mantine/dnd imports (e.g. leftover), remove the ones TS flags.

- [ ] **Step 5: Full test suite + lint**

Run: `npx vitest run`
Expected: all PASS.
Run: `npm run lint`
Expected: exit 0.

---

## Task 4: Manual verification (live app)

- [ ] **Step 1:** `npm run tauri dev`.
- [ ] **Step 2:** Open a log's quest details → the `[▤ Columns ▾]` button sits at the right of the window-status row. Click it: the popover shows Player Row + Skill Breakdown editors.
- [ ] **Step 3:** Add/remove/**drag-reorder** columns in the popover and confirm the table + expanded skill breakdown update live, and that the drag works inside the popover (the key risk — @hello-pangea/dnd in a portaled `Popover.Dropdown`). If drag fails, remove the `Box mah/overflow` wrapper (scroll containers break dnd) and/or set `Popover` `trapFocus={false}`.
- [ ] **Step 4:** Confirm choices persist across an app restart, and that Settings no longer shows a "Main Window Columns" section (Overlay Columns still works).

---

## Self-review notes

- **Spec coverage:** popover pattern (Task 2–3), shared hook (Task 1), Settings removal (Task 3), unchanged persistence — all covered.
- **Type consistency:** `useColumnControls()` returns `{ overlayPlayer, overlaySkill, logsPlayer, logsSkill }`, each a `ColumnControls`; `ColumnsPopover` consumes `logsPlayer`/`logsSkill`, `Settings` consumes `overlayPlayer`/`overlaySkill`. `ColumnEditor` prop names match the bundle fields.
- **Risk flagged:** dnd inside the popover — verified in Task 4 Step 3 with a documented fallback.
