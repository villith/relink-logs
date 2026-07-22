# Per-window default columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the overlay and the main (logs) window independent, separately-customizable column sets — overlay defaults lean, main defaults full — and add a new frontend-computed "SPS" (stun-per-second) skill-breakdown column.

**Architecture:** The skill breakdown already switches columns on the `live` prop. We move the main window's currently-hardcoded column arrays into the settings store (`logs_columns` / `logs_skill_columns`), reseed the overlay defaults to lean sets, add a `SkillColumns.StunPerSecond` column computed in-component from the encounter duration (threaded `Table → PlayerRow → SkillBreakdown → rows`), and extract a reusable `<ColumnEditor>` so Settings can expose all four column sets.

**Tech Stack:** React + TypeScript, Zustand (persisted store), Mantine UI, @hello-pangea/dnd, Vitest, i18next.

**Verification commands (run from repo root):**
- Typecheck: `npx tsc --noEmit`
- Tests (single file): `npx vitest run src/components/SkillRow.test.tsx`
- Tests (all): `npx vitest run`
- Never use `npm run test` (watch mode never exits).

---

## Task 1: Add the SPS (stun-per-second) skill column

**Files:**
- Modify: `src/types.ts` (add `SkillColumns.StunPerSecond`)
- Modify: `src-tauri/lang/en/ui.json` (add `stun-per-second` strings under `skill-columns`)
- Modify: `src/components/SkillRow.tsx` (add `durationSeconds` prop + SPS cell)
- Modify: `src/components/SkillGroupRow.tsx` (add `durationSeconds` prop + SPS cell + pass to nested row)
- Modify: `src/components/SkillBreakdown.tsx` (thread `durationSeconds`)
- Modify: `src/components/PlayerRow.tsx` (thread `durationSeconds`)
- Modify: `src/components/Table.tsx` (compute `durationSeconds` from encounter, pass down)
- Test: `src/components/SkillRow.test.tsx`

- [ ] **Step 1: Add the enum member**

In `src/types.ts`, in `enum SkillColumns`, add after `StunPerEligibleHit`:

```ts
  StunPerEligibleHit = "stun-per-hit",
  StunPerSecond = "stun-per-second",
  Overcap = "overcap",
```

- [ ] **Step 2: Add i18n strings**

In `src-tauri/lang/en/ui.json`, in the `"skill-columns"` object, add after the `stun-per-hit-description` line:

```json
      "stun-per-hit": "Stun/Hit",
      "stun-per-hit-description": "Average Stun Per Stunning Hit",
      "stun-per-second": "SPS",
      "stun-per-second-description": "Stun Per Second",
      "overcap": "Overcap",
```

- [ ] **Step 3: Write the failing test**

In `src/components/SkillRow.test.tsx`, change the `renderRow` helper to accept a duration, and add two SPS tests. Replace the `renderRow` definition:

```tsx
const renderRow = (
  skill: ComputedSkillState,
  columns: SkillColumns[] = DEFAULT_SKILL_COLUMNS,
  durationSeconds = 0
) =>
  render(
    <MantineProvider>
      <table>
        <tbody>
          <SkillRow
            characterType="Pl0000"
            skill={skill}
            color="#ff0000"
            columns={columns}
            durationSeconds={durationSeconds}
            live
          />
        </tbody>
      </table>
    </MantineProvider>
  );
```

Add these tests inside the `describe("SkillRow", …)` block:

```tsx
  /** SPS is stun contributed over the whole encounter duration (totalStunValue /
   * durationSeconds), rendered to two decimals like the player-row SPS. */
  it("renders stun-per-second over the encounter duration", () => {
    const { container } = renderRow(
      makeSkill({ actionType: "PerfectGuard", totalStunValue: 300 }),
      [SkillColumns.StunPerSecond],
      60
    );

    const cells = container.querySelectorAll("td");
    expect(cells[1].textContent).toBe("5.00"); // 300 / 60
  });

  /** No duration (or no stun) leaves the SPS cell blank rather than "0.00", so the
   * breakdown stays clean for the many rows that never stunned. */
  it("leaves stun-per-second blank with no duration", () => {
    const { container } = renderRow(
      makeSkill({ actionType: "PerfectGuard", totalStunValue: 300 }),
      [SkillColumns.StunPerSecond],
      0
    );

    const cells = container.querySelectorAll("td");
    expect(cells[1].textContent).toBe("");
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/components/SkillRow.test.tsx`
Expected: FAIL — `SkillRow` has no `durationSeconds` prop and no `StunPerSecond` case, so the SPS cell renders nothing / the prop is a type error.

- [ ] **Step 5: Implement the SPS cell in SkillRow**

In `src/components/SkillRow.tsx`, add `durationSeconds` to the props type:

```tsx
export type SkillRowProps = {
  characterType: CharacterType;
  skill: ComputedSkillState;
  color: string;
  /** The value columns to render, in order (after the Skill name column). */
  columns: SkillColumns[];
  /** Encounter duration in seconds, for the stun-per-second column. */
  durationSeconds?: number;
  nested?: boolean;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};
```

Destructure it (default 0):

```tsx
export const SkillRow = ({ characterType, skill, color, columns, durationSeconds = 0, nested, live }: SkillRowProps) => {
```

Add a case in `renderCell` (before `case SkillColumns.Overcap:`):

```tsx
      case SkillColumns.StunPerSecond: {
        const sps = durationSeconds > 0 ? (skill.totalStunValue ?? 0) / durationSeconds : 0;
        return (
          <td key={column} className="text-center row-data">
            {sps > 0 ? sps.toFixed(2) : ""}
          </td>
        );
      }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/components/SkillRow.test.tsx`
Expected: all tests PASS. The pre-existing tests still use the unchanged `DEFAULT_SKILL_COLUMNS` (10 columns — SPS is not added to any default set until Task 2), so their cell indices are unaffected; the two new SPS tests pass with the new cell.

- [ ] **Step 7: Thread `durationSeconds` through the group row, breakdown, player row, and table**

In `src/components/SkillGroupRow.tsx`:

Add to `SkillRowProps` (this file's local props type):

```tsx
  /** The value columns to render, in order (after the Skill name column). */
  columns: SkillColumns[];
  /** Encounter duration in seconds, for the stun-per-second column. */
  durationSeconds?: number;
```

Destructure it:

```tsx
export const SkillGroupRow = ({ characterType, group, color, columns, durationSeconds = 0, live }: SkillRowProps) => {
```

Add the SPS case in this file's `renderCell` (before `case SkillColumns.Overcap:`):

```tsx
      case SkillColumns.StunPerSecond: {
        const sps = durationSeconds > 0 ? (group.totalStunValue ?? 0) / durationSeconds : 0;
        return (
          <td key={column} className="text-center row-data">
            {sps > 0 ? sps.toFixed(2) : ""}
          </td>
        );
      }
```

Pass it to the nested `SkillRow` (in the `sortedSkills.map`):

```tsx
          <SkillRow
            key={`${skill.childCharacterType}-${getSkillName(characterType, skill)}`}
            characterType={characterType}
            skill={skill}
            color={color}
            columns={columns}
            durationSeconds={durationSeconds}
            nested
            live={live}
          />
```

In `src/components/SkillBreakdown.tsx`, add `durationSeconds` to `SkillBreakdownProps`:

```tsx
export type SkillBreakdownProps = {
  player: ComputedPlayerState;
  color: string;
  /** Encounter duration in seconds, for the stun-per-second column. */
  durationSeconds?: number;
  /** Live overlay rows skip the per-enemy tooltip (quest view only). */
  live?: boolean;
};
```

Thread it through `renderSkillRow` and the component. Change the `renderSkillRow` signature and both JSX returns to accept and forward `durationSeconds`:

```tsx
const renderSkillRow = (
  characterType: CharacterType,
  skillData: ComputedSkillState | ComputedSkillGroup,
  color: string,
  columns: SkillColumns[],
  durationSeconds: number,
  live?: boolean
) => {
```

In the `SkillGroupRow` return add `durationSeconds={durationSeconds}`, and in the `SkillRow` return add `durationSeconds={durationSeconds}`.

Change the component signature and the `.map` call:

```tsx
export const SkillBreakdown = ({ player, color, durationSeconds = 0, live }: SkillBreakdownProps) => {
```

```tsx
            {skills.map((skill) => renderSkillRow(player.characterType, skill, color, columns, durationSeconds, live))}
```

In `src/components/PlayerRow.tsx`, add `durationSeconds` to the props and pass it to `SkillBreakdown`:

```tsx
export const PlayerRow = ({
  live = false,
  player,
  partyData,
  durationSeconds = 0,
}: {
  live?: boolean;
  player: ComputedPlayerState;
  partyData: Array<PlayerData | null>;
  durationSeconds?: number;
}) => {
```

```tsx
      {isOpen && <SkillBreakdown player={player} color={color} durationSeconds={durationSeconds} live={live} />}
```

In `src/components/Table.tsx`, compute the duration from the encounter and pass it to each `PlayerRow`. After the `players` filtering (just before `const toggleSort`), add:

```tsx
  // Encounter duration in seconds — the same span (last damage − first damage)
  // the parser divides by for player.stunPerSecond, so per-skill SPS stays
  // consistent with the player row. Live: grows with the fight. Logs: fixed.
  const durationSeconds = Math.max(0, encounterState.endTime - encounterState.startTime) / 1000;
```

Update the `PlayerRow` render:

```tsx
        {players.map((player) => (
          <PlayerRow
            live={live}
            key={player.index}
            player={player}
            partyData={partyData}
            durationSeconds={durationSeconds}
          />
        ))}
```

- [ ] **Step 8: Run the full SkillRow test file to verify it passes**

Run: `npx vitest run src/components/SkillRow.test.tsx`
Expected: all tests PASS (SPS tests + the pre-existing tests, which still use `DEFAULT_SKILL_COLUMNS` — unchanged until Task 2).

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src-tauri/lang/en/ui.json src/components/SkillRow.tsx src/components/SkillGroupRow.tsx src/components/SkillBreakdown.tsx src/components/PlayerRow.tsx src/components/Table.tsx src/components/SkillRow.test.tsx
git commit -m "feat(ui): add stun-per-second (SPS) skill-breakdown column"
```

---

## Task 2: Split defaults and give the main window its own store-backed columns

**Files:**
- Modify: `src/types.ts` (four default constants; rename `DEFAULT_SKILL_COLUMNS`)
- Modify: `src/stores/useMeterSettingsStore.ts` (new keys + reseeded defaults)
- Modify: `src/components/SkillBreakdown.tsx` (logs vs overlay skill columns)
- Modify: `src/components/Table.tsx` (logs vs overlay player columns)
- Modify: `src/components/usePlayerRow.ts` (logs vs overlay player columns)
- Modify: `src/components/SkillRow.test.tsx` (rename import + fix shifted indices)
- Test: `src/types.test.ts` (new)

- [ ] **Step 1: Replace the default constant in `types.ts`**

In `src/types.ts`, replace the existing `DEFAULT_SKILL_COLUMNS` block (the `export const DEFAULT_SKILL_COLUMNS: SkillColumns[] = [ … ];`) with four constants. The lean overlay sets omit the low-value columns; the logs sets are the full sets. Note `StunPerSecond` is included in both skill sets and in the logs player set.

```ts
/** Overlay (live meter) default player columns — lean, to fit the narrow window.
 * The Name column is always shown and is not part of this list. */
export const DEFAULT_OVERLAY_COLUMNS: MeterColumns[] = [
  MeterColumns.TotalDamage,
  MeterColumns.DPS,
  MeterColumns.StunPerSecond,
  MeterColumns.DamagePercentage,
];

/** Main-window (logs / quest-details) default player columns — the full set. */
export const DEFAULT_LOGS_COLUMNS: MeterColumns[] = [
  MeterColumns.TotalDamage,
  MeterColumns.DPS,
  MeterColumns.TotalStunValue,
  MeterColumns.StunPerSecond,
  MeterColumns.SupPercentage,
  MeterColumns.DamagePercentage,
];

/** Overlay (live meter) default skill-breakdown columns — lean. */
export const DEFAULT_OVERLAY_SKILL_COLUMNS: SkillColumns[] = [
  SkillColumns.Hits,
  SkillColumns.TotalDamage,
  SkillColumns.MinDamage,
  SkillColumns.MaxDamage,
  SkillColumns.AverageDamage,
  SkillColumns.StunPerSecond,
  SkillColumns.DamagePercentage,
];

/** Main-window (logs / quest-details) default skill-breakdown columns — the full
 * set. Also the non-customizable fallback used by the logs detail view. */
export const DEFAULT_LOGS_SKILL_COLUMNS: SkillColumns[] = [
  SkillColumns.Hits,
  SkillColumns.TotalDamage,
  SkillColumns.MinDamage,
  SkillColumns.MaxDamage,
  SkillColumns.AverageDamage,
  SkillColumns.TotalStunValue,
  SkillColumns.StunEligibleHits,
  SkillColumns.StunPerEligibleHit,
  SkillColumns.StunPerSecond,
  SkillColumns.Overcap,
  SkillColumns.DamagePercentage,
];
```

- [ ] **Step 2: Write the failing distinctness test**

Create `src/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOGS_COLUMNS,
  DEFAULT_LOGS_SKILL_COLUMNS,
  DEFAULT_OVERLAY_COLUMNS,
  DEFAULT_OVERLAY_SKILL_COLUMNS,
} from "@/types";

describe("default column sets", () => {
  it("overlay and logs player defaults are distinct", () => {
    expect(DEFAULT_OVERLAY_COLUMNS).not.toEqual(DEFAULT_LOGS_COLUMNS);
  });

  it("overlay and logs skill defaults are distinct", () => {
    expect(DEFAULT_OVERLAY_SKILL_COLUMNS).not.toEqual(DEFAULT_LOGS_SKILL_COLUMNS);
  });

  it("the lean overlay skill set is a strict subset of the full logs set", () => {
    for (const column of DEFAULT_OVERLAY_SKILL_COLUMNS) {
      expect(DEFAULT_LOGS_SKILL_COLUMNS).toContain(column);
    }
    expect(DEFAULT_OVERLAY_SKILL_COLUMNS.length).toBeLessThan(DEFAULT_LOGS_SKILL_COLUMNS.length);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/types.test.ts`
Expected: FAIL — the four constants don't exist yet if Step 1 wasn't saved; if Step 1 is saved it should PASS. (If it passes here, that's fine — proceed.)

- [ ] **Step 4: Add the new store state**

In `src/stores/useMeterSettingsStore.ts`:

Update the import:

```ts
import {
  DEFAULT_LOGS_COLUMNS,
  DEFAULT_LOGS_SKILL_COLUMNS,
  DEFAULT_OVERLAY_COLUMNS,
  DEFAULT_OVERLAY_SKILL_COLUMNS,
  MeterColumns,
  SkillColumns,
} from "@/types";
```

Add to the `MeterSettings` interface, after `overlay_skill_columns`:

```ts
  /** Customizable skill-breakdown value columns for the live overlay. */
  overlay_skill_columns: SkillColumns[];
  /** Customizable player columns for the main (logs) window. */
  logs_columns: MeterColumns[];
  /** Customizable skill-breakdown value columns for the main (logs) window. */
  logs_skill_columns: SkillColumns[];
```

Replace the `overlay_columns` / `overlay_skill_columns` seed values in `DEFAULT_METER_SETTINGS` and add the two logs keys:

```ts
  overlay_columns: [...DEFAULT_OVERLAY_COLUMNS],
  overlay_skill_columns: [...DEFAULT_OVERLAY_SKILL_COLUMNS],
  logs_columns: [...DEFAULT_LOGS_COLUMNS],
  logs_skill_columns: [...DEFAULT_LOGS_SKILL_COLUMNS],
```

(The `MeterColumns` import is still used by the migrate step; keep it.)

- [ ] **Step 5: Point the non-live render paths at the logs store values**

In `src/components/SkillBreakdown.tsx`, update the import and the `columns` line:

```ts
import {
  CharacterType,
  ComputedPlayerState,
  ComputedSkillGroup,
  ComputedSkillState,
  SkillColumns,
} from "@/types";
```

```tsx
  const { overlaySkillColumns, logsSkillColumns } = useMeterSettingsStore(
    useShallow((state) => ({
      overlaySkillColumns: state.overlay_skill_columns,
      logsSkillColumns: state.logs_skill_columns,
    }))
  );

  // The overlay honours the user's overlay columns; the logs view honours the
  // (separately-defaulted) logs columns.
  const columns = live ? overlaySkillColumns : logsSkillColumns;
```

(Remove the now-unused `DEFAULT_SKILL_COLUMNS` import.)

In `src/components/Table.tsx`, add `logs_columns` to the store selector and use it:

```tsx
  const { streamerMode, show_full_values, overlay_columns, logs_columns } = useMeterSettingsStore(
    useShallow((state) => ({
      useCondensedSkills: state.use_condensed_skills,
      streamerMode: state.streamer_mode,
      show_full_values: state.show_full_values,
      overlay_columns: state.overlay_columns,
      logs_columns: state.logs_columns,
    }))
  );
```

Replace the hardcoded `columns` array:

```tsx
  // If the meter is live, show the overlay columns; otherwise the logs columns.
  const columns = live ? overlay_columns : logs_columns;
```

In `src/components/usePlayerRow.ts`, add `logs_columns` to the store selector and use it:

```ts
  const { color_1, color_2, color_3, color_4, show_display_names, show_full_values, overlay_columns, logs_columns } =
    useMeterSettingsStore(
      useShallow((state) => ({
        color_1: state.color_1,
        color_2: state.color_2,
        color_3: state.color_3,
        color_4: state.color_4,
        show_display_names: state.show_display_names,
        show_full_values: state.show_full_values,
        overlay_columns: state.overlay_columns,
        logs_columns: state.logs_columns,
      }))
    );
```

Replace the hardcoded `columns` array:

```ts
  const columns = live ? overlay_columns : logs_columns;
```

- [ ] **Step 6: Fix the SkillRow tests for the renamed constant and shifted indices**

In `src/components/SkillRow.test.tsx`, update the import:

```ts
import { ComputedSkillState, DEFAULT_LOGS_SKILL_COLUMNS, SkillColumns } from "@/types";
```

Update the `renderRow` default parameter:

```tsx
const renderRow = (
  skill: ComputedSkillState,
  columns: SkillColumns[] = DEFAULT_LOGS_SKILL_COLUMNS,
  durationSeconds = 0
) =>
```

The full logs skill set is now 11 value columns in this order: `Hits, Total, Min, Max, Avg, Stun, StunHits, Stun/Hit, SPS, Overcap, %`. Update the two affected tests.

Quickening test — extend the dash loop to 11 and fix the comment:

```tsx
  it("renders a Perfect Guard (Quickening) row as hits plus dashes", () => {
    const { container } = renderRow(makeSkill({ actionType: "PerfectGuardQuickening", hits: 1 }));

    const cells = container.querySelectorAll("td");
    expect(cells[0].textContent).toBe("Perfect Guard (Quickening)");
    expect(cells[1].textContent).toBe("1");
    // total, min, max, avg, stun, stun-hits, stun/hit, SPS, cap%, %
    for (let i = 2; i <= 11; i++) {
      expect(cells[i].textContent).toBe("-");
    }
  });
```

Normal-rendering test — the damage-% column moved from index 10 to 11 (SPS inserted at 9):

```tsx
  it("keeps normal value rendering for other rows", () => {
    const { container } = renderRow(makeSkill({ actionType: "PerfectGuard", hits: 2, totalStunValue: 927 }));

    const cells = container.querySelectorAll("td");
    expect(cells[0].textContent).toBe("Perfect Guard");
    expect(cells[1].textContent).toBe("2");
    expect(cells[2].textContent).toBe("0");
    expect(cells[6].textContent).toBe("927"); // total stun value
    expect(cells[7].textContent).toBe(""); // stun hits: none stunned (stunEligibleHits 0)
    expect(cells[8].textContent).toBe(""); // stun/hit: blank with no eligible hits
    expect(cells[9].textContent).toBe(""); // SPS: blank (no duration passed)
    expect(cells[11].textContent).toBe("0%"); // damage %
  });
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/components/SkillRow.test.tsx src/types.test.ts`
Expected: all PASS.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. (If `DEFAULT_SKILL_COLUMNS` is still referenced anywhere, TS will flag it — search with `grep -rn DEFAULT_SKILL_COLUMNS src` and fix any stragglers to `DEFAULT_LOGS_SKILL_COLUMNS`.)

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/types.test.ts src/stores/useMeterSettingsStore.ts src/components/SkillBreakdown.tsx src/components/Table.tsx src/components/usePlayerRow.ts src/components/SkillRow.test.tsx
git commit -m "feat(ui): separate overlay and main-window default column sets"
```

---

## Task 3: Reusable ColumnEditor + four editors in Settings

**Files:**
- Create: `src/components/ColumnEditor.tsx`
- Modify: `src/pages/useSettings.ts` (generic per-key column controls for all four sets)
- Modify: `src/pages/Settings.tsx` (render four `<ColumnEditor>`s under two headings)

- [ ] **Step 1: Create the ColumnEditor component**

Create `src/components/ColumnEditor.tsx`:

```tsx
import { DragDropContext, Draggable, Droppable, DropResult } from "@hello-pangea/dnd";
import { ActionIcon, Box, Button, Flex, Menu, Stack, Text } from "@mantine/core";
import { DotsSixVertical } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

export type ColumnEditorProps = {
  /** Heading shown above the editor, e.g. "Player Row". */
  title: string;
  /** Unique dnd droppable id (must differ across editors on the page). */
  droppableId: string;
  /** i18n key prefix for column labels, e.g. "ui.meter-columns" or "ui.skill-columns". */
  translationPrefix: string;
  /** The currently-selected columns, in display order. */
  columns: string[];
  /** Columns not yet selected, offered in the "Add column" menu. */
  available: string[];
  onAdd: (column: string) => void;
  onRemove: (column: string) => void;
  onReorder: (result: DropResult) => void;
};

/** A drag-to-reorder / add / remove editor for one ordered column list. Shared by
 * the overlay and main-window column settings. */
export const ColumnEditor = ({
  title,
  droppableId,
  translationPrefix,
  columns,
  available,
  onAdd,
  onRemove,
  onReorder,
}: ColumnEditorProps) => {
  const { t } = useTranslation();
  const label = (column: string) => `${t(`${translationPrefix}.${column}`)} - ${t(`${translationPrefix}.${column}-description`)}`;

  return (
    <Stack gap="xs">
      <Text size="sm">{title}</Text>
      <Menu shadow="md" trigger="hover" openDelay={100} closeDelay={400}>
        <Menu.Target>
          <Button>Add column</Button>
        </Menu.Target>
        <Menu.Dropdown>
          {available.map((item) => (
            <Menu.Item key={item} onClick={() => onAdd(item)}>
              {label(item)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <DragDropContext onDragEnd={onReorder}>
        <Droppable droppableId={droppableId}>
          {(droppableProvided) => (
            <Stack ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
              {columns.map((item, index) => (
                <Draggable key={item} draggableId={`${droppableId}-${item}`} index={index}>
                  {(draggableProvided) => (
                    <Box
                      bg="var(--mantine-color-dark-8)"
                      display="flex"
                      p={10}
                      ref={draggableProvided.innerRef}
                      {...draggableProvided.draggableProps}
                      {...draggableProvided.dragHandleProps}
                    >
                      <Flex align="center" flex={1}>
                        <DotsSixVertical size={16} style={{ cursor: "grab", marginRight: "0.5em" }} />
                        {label(item)}
                      </Flex>
                      <Flex align="center">
                        <ActionIcon
                          aria-label="Remove column"
                          variant="transparent"
                          color="gray"
                          onClick={() => onRemove(item)}
                        >
                          x
                        </ActionIcon>
                      </Flex>
                    </Box>
                  )}
                </Draggable>
              ))}
              {droppableProvided.placeholder}
            </Stack>
          )}
        </Droppable>
      </DragDropContext>
    </Stack>
  );
};
```

- [ ] **Step 2: Replace the column handlers in `useSettings.ts` with a generic factory**

In `src/pages/useSettings.ts`, add `logs_columns` and `logs_skill_columns` to the destructured store state and the selector (alongside the existing `overlay_columns` / `overlay_skill_columns`):

```ts
    overlay_columns,
    overlay_skill_columns,
    logs_columns,
    logs_skill_columns,
```

```ts
    overlay_columns: state.overlay_columns,
    overlay_skill_columns: state.overlay_skill_columns,
    logs_columns: state.logs_columns,
    logs_skill_columns: state.logs_skill_columns,
```

Replace everything from `const handleReorderOverlayColumns` down to (and including) the `availableSkillColumns` definition with a single factory and four control bundles:

```ts
  type ColumnKey = "overlay_columns" | "overlay_skill_columns" | "logs_columns" | "logs_skill_columns";

  const makeColumnControls = (key: ColumnKey, columns: string[], allColumns: string[], excluded: string[] = []) => ({
    columns,
    available: allColumns.filter((column) => !columns.includes(column) && !excluded.includes(column)),
    onReorder: (result: DropResult) => {
      if (!result.destination) return;
      const items = reorder(columns, result.source.index, result.destination.index);
      setMeterSettings({ [key]: items } as Partial<Parameters<typeof setMeterSettings>[0]>);
    },
    onAdd: (column: string) => {
      if (columns.includes(column)) return;
      setMeterSettings({ [key]: [...columns, column] } as Partial<Parameters<typeof setMeterSettings>[0]>);
    },
    onRemove: (column: string) => {
      setMeterSettings({ [key]: columns.filter((item) => item !== column) } as Partial<
        Parameters<typeof setMeterSettings>[0]
      >);
    },
  });

  const meterColumnValues = Object.values(MeterColumns);
  const skillColumnValues = Object.values(SkillColumns);

  const overlayPlayerColumns = makeColumnControls("overlay_columns", overlay_columns, meterColumnValues, [
    MeterColumns.Name,
  ]);
  const overlaySkillColumns = makeColumnControls("overlay_skill_columns", overlay_skill_columns, skillColumnValues);
  const logsPlayerColumns = makeColumnControls("logs_columns", logs_columns, meterColumnValues, [MeterColumns.Name]);
  const logsSkillColumns = makeColumnControls("logs_skill_columns", logs_skill_columns, skillColumnValues);
```

Add the import for `DropResult` (already imported) and ensure `MeterColumns, SkillColumns` are imported (they are). Update the returned object: remove the old column exports (`overlay_columns`, `availableOverlayColumns`, `handleReorderOverlayColumns`, `addOverlayColumn`, `removeOverlayColumn`, `overlay_skill_columns`, `availableSkillColumns`, `handleReorderSkillColumns`, `addSkillColumn`, `removeSkillColumn`) and return the four bundles instead:

```ts
    overlayPlayerColumns,
    overlaySkillColumns,
    logsPlayerColumns,
    logsSkillColumns,
```

(Keep all the non-column returns — `color_*`, `transparency`, `languages`, `handleLanguageChange`, `open_log_on_save`, `auto_check_updates`, `setMeterSettings`, etc.)

- [ ] **Step 3: Render the four editors in `Settings.tsx`**

In `src/pages/Settings.tsx`, add the import:

```tsx
import { ColumnEditor } from "@/components/ColumnEditor";
```

Update the `useSettings()` destructure to pull the four bundles instead of the old column fields:

```tsx
  const {
    overlayPlayerColumns,
    overlaySkillColumns,
    logsPlayerColumns,
    logsSkillColumns,
    // …keep the other destructured values already used below…
  } = useSettings();
```

Replace the whole column-settings block (from the `<Divider />` before `Customize Overlay Meter Columns` through the closing `</DragDropContext>` of the skill-columns section) with:

```tsx
          <Divider />
          <Text size="md" fw={700}>
            Overlay Columns
          </Text>
          <ColumnEditor
            title="Player Row"
            droppableId="overlay-player-columns"
            translationPrefix="ui.meter-columns"
            columns={overlayPlayerColumns.columns}
            available={overlayPlayerColumns.available}
            onAdd={overlayPlayerColumns.onAdd}
            onRemove={overlayPlayerColumns.onRemove}
            onReorder={overlayPlayerColumns.onReorder}
          />
          <ColumnEditor
            title="Skill Breakdown"
            droppableId="overlay-skill-columns"
            translationPrefix="ui.skill-columns"
            columns={overlaySkillColumns.columns}
            available={overlaySkillColumns.available}
            onAdd={overlaySkillColumns.onAdd}
            onRemove={overlaySkillColumns.onRemove}
            onReorder={overlaySkillColumns.onReorder}
          />
          <Divider />
          <Text size="md" fw={700}>
            Main Window Columns
          </Text>
          <ColumnEditor
            title="Player Row"
            droppableId="logs-player-columns"
            translationPrefix="ui.meter-columns"
            columns={logsPlayerColumns.columns}
            available={logsPlayerColumns.available}
            onAdd={logsPlayerColumns.onAdd}
            onRemove={logsPlayerColumns.onRemove}
            onReorder={logsPlayerColumns.onReorder}
          />
          <ColumnEditor
            title="Skill Breakdown"
            droppableId="logs-skill-columns"
            translationPrefix="ui.skill-columns"
            columns={logsSkillColumns.columns}
            available={logsSkillColumns.available}
            onAdd={logsSkillColumns.onAdd}
            onRemove={logsSkillColumns.onRemove}
            onReorder={logsSkillColumns.onReorder}
          />
```

Remove now-unused imports from `Settings.tsx` if they are no longer referenced elsewhere in the file (`DragDropContext`, `Draggable`, `Droppable`, `DotsSixVertical`, and possibly `Box`, `Menu`, `ActionIcon`, `Flex`). Only remove ones the typecheck flags as unused — the checklist section lower in the file may still use some.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. Fix any unused-import errors it reports in `Settings.tsx`.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/ColumnEditor.tsx src/pages/useSettings.ts src/pages/Settings.tsx
git commit -m "feat(ui): customizable columns for the main window via shared ColumnEditor"
```

---

## Task 4: Manual verification (live app)

**Files:** none (runtime verification).

- [ ] **Step 1: Build & run**

Run: `npm run tauri dev` (rebuilds the Rust backend — needed because Task 1's earlier width fix touched the allowlist in a prior commit; this task only needs the frontend, but a full run confirms both windows).

- [ ] **Step 2: Verify overlay defaults (fresh settings)**

With default settings, the overlay player row shows `Name, DMG, DPS, SPS, %` and an expanded skill row shows `Hits, Total, Min, Max, Avg, SPS, %`. Confirm SPS shows a sensible per-second value on a stunning skill and blank on non-stunning rows, and that the overlay auto-sizes to fit (no clipped columns).

- [ ] **Step 3: Verify main window defaults**

Open a log's quest details: the player table shows the full main set and the skill breakdown shows all columns including SPS.

- [ ] **Step 4: Verify independent customization**

In Settings, change the Overlay Skill Breakdown columns and confirm ONLY the overlay changes; change the Main Window columns and confirm ONLY the logs view changes. Confirm both persist across an app restart.

---

## Notes / deviations from spec

- **Section headings are hardcoded English** (`"Overlay Columns"`, `"Main Window Columns"`, `"Player Row"`, `"Skill Breakdown"`), matching the existing hardcoded `"Customize Overlay Meter Columns"` label rather than adding i18n keys. Only the SPS *column* strings go in `en/ui.json`. This follows the existing Settings convention.
- **SPS is frontend-computed** (no parser/protocol change), so old logs get it for free on view.
- **No store version bump** — the two new `logs_*` keys are backfilled from defaults by Zustand's shallow merge for existing users, leaving their main window unchanged.
