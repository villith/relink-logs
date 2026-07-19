# Editable Build Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Builds-tab checklist user-editable from the Settings tab, with the default criteria moved into a bundled JSON asset.

**Architecture:** The hardcoded `BUILD_CHECKLIST`/`AI_CHECKLIST` constants in `src/utils.ts` move to `src/assets/checklist-default.json` (hex-string trait ids). A new persisted Zustand store (`useChecklistStore`, localStorage key `checklist-settings`) seeds from that JSON and holds the user-edited lists (`{ids, level, enabled}` entries). `View.tsx` renders the store's enabled entries; a new "Checklist" fieldset in Settings edits them.

**Tech Stack:** React + TypeScript, Mantine UI, Zustand (`persist`), i18next, Vitest (jsdom environment — localStorage works in tests).

**Spec:** `docs/superpowers/specs/2026-07-18-editable-checklist-design.md`

**Conventions:**
- Run tests with `npx vitest run <file>` (NEVER `npm run test` — it's watch mode and never exits).
- Typecheck with `npx tsc --noEmit`; lint a file with `npx eslint <file>`.
- `@/` is an alias for `src/` (both in Vite and tsconfig).

---

### Task 1: Default-criteria JSON asset + loader in utils.ts

Move the checklist defaults into a JSON file and expose a loader. The old constants are deleted; existing tests that referenced them are updated in this task.

**Files:**
- Create: `src/assets/checklist-default.json`
- Modify: `src/utils.ts` (replace `BUILD_CHECKLIST`/`AI_CHECKLIST` constants, ~lines 201-227)
- Test: `src/utils.test.ts`

- [ ] **Step 1: Create the JSON asset**

Create `src/assets/checklist-default.json` (ids are lowercase 8-char hex, matching the lang-file keys; entry order is the shipped display order — War Elemental, Spartan Echo, Berserker Echo, Nimble Onslaught, Improved Dodge, DMG Cap group, Stun Power, Autorevive, Guts, Celestial Terra, Celestial Lumen, Fatebreaker):

```json
{
  "build": [
    { "ids": ["4c588c27"], "level": 15 },
    { "ids": ["3d8153a1"], "level": 15 },
    { "ids": ["ee85cd1f"], "level": 15 },
    { "ids": ["d2c8e10a"], "level": 30 },
    { "ids": ["8b3bf60c"], "level": 15 },
    { "ids": ["dc584f60", "0151cf9e", "3b71af12", "aefeb1bc", "fff8cf64"], "level": 65 },
    { "ids": ["ceb700ee"], "level": 45 },
    { "ids": ["95f3fa86"], "level": 15 },
    { "ids": ["e69a4694"], "level": 15 },
    { "ids": ["9232dc17"], "level": 15 },
    { "ids": ["a7726190"], "level": 15 },
    { "ids": ["d029fe08"], "level": 15 }
  ],
  "ai": [{ "ids": ["a8a3163b"], "level": 15 }]
}
```

- [ ] **Step 2: Write the failing loader test**

In `src/utils.test.ts`, replace `AI_CHECKLIST` and `BUILD_CHECKLIST` in the import block at the top of the file with `defaultChecklist`:

```ts
import {
  EMPTY_ID,
  checklistLevel,
  checklistStatus,
  collectSigilsByCategory,
  collectTraitSources,
  computeCombinedTraits,
  computeOvercapPercentage,
  computeSupPercentage,
  defaultChecklist,
  formatSummonBonusValue,
  groupBonuses,
  skillboardLayoutFor,
  skillboardNodeKey,
  skillboardNodeMeta,
  summonBonusValue,
  toHash,
  toHashString,
  type BonusSource,
} from "./utils";
```

Update the two `checklistLevel` tests that used `BUILD_CHECKLIST.find(...)`:

```ts
  describe("checklistLevel", () => {
    it("sums combined-trait levels across an entry's id group", () => {
      // DMG Cap counts the generic trait plus the colored character variants.
      const dmgCap = defaultChecklist().build.find((entry) => entry.ids.includes(0xdc584f60))!;
      const traits = [
        { id: 0xdc584f60, level: 45 },
        { id: 0xaefeb1bc, level: 20 },
        { id: 0x4c588c27, level: 15 },
      ];
      expect(checklistLevel(traits, dmgCap)).toBe(65);
    });

    it("is 0 when none of the entry's ids are present", () => {
      const warElemental = defaultChecklist().build.find((entry) => entry.ids.includes(0x4c588c27))!;
      expect(checklistLevel([{ id: 0xdc584f60, level: 45 }], warElemental)).toBe(0);
    });
  });
```

Replace the `describe("AI_CHECKLIST", ...)` block with a loader test:

```ts
  describe("defaultChecklist", () => {
    it("parses the bundled JSON, converting hex ids to numbers", () => {
      const { build, ai } = defaultChecklist();
      expect(build).toHaveLength(12);
      expect(ai).toEqual([{ ids: [0xa8a3163b], level: 15 }]);
      const dmgCap = build.find((entry) => entry.ids.length > 1)!;
      expect(dmgCap).toEqual({ ids: [0xdc584f60, 0x0151cf9e, 0x3b71af12, 0xaefeb1bc, 0xfff8cf64], level: 65 });
    });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/utils.test.ts`
Expected: FAIL — `defaultChecklist` is not exported from `./utils`.

- [ ] **Step 4: Implement the loader in utils.ts**

In `src/utils.ts`, add the import next to the other asset imports (~line 19):

```ts
import checklistDefault from "@/assets/checklist-default.json";
```

Then replace the `BUILD_CHECKLIST` and `AI_CHECKLIST` constants (both the doc comments and the arrays, currently ~lines 201-227, directly after the `ChecklistEntry` type) with:

```ts
export type ChecklistGroups = { build: ChecklistEntry[]; ai: ChecklistEntry[] };

/**
 * The shipped default checklist criteria (assets/checklist-default.json):
 * the endgame requirements shown in the Builds tab, checked against a
 * player's combined trait totals (wrightstone + summons + sigils). `build`
 * is the main sigils checklist; `ai` applies to AI-controlled party members
 * (no damage penalty from Glass Cannon). The JSON stores trait ids as the
 * lowercase hex strings used by the lang files; this converts them to the
 * numeric ids the parser emits.
 */
export const defaultChecklist = (): ChecklistGroups => {
  const parse = (entries: { ids: string[]; level: number }[]): ChecklistEntry[] =>
    entries.map((entry) => ({ ids: entry.ids.map((id) => parseInt(id, 16)), level: entry.level }));
  return { build: parse(checklistDefault.build), ai: parse(checklistDefault.ai) };
};
```

Keep the `ChecklistEntry` type, `checklistLevel`, and `checklistStatus` exactly as they are.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/utils.test.ts`
Expected: PASS (all tests).

Note: `src/pages/logs/View.tsx` still imports the deleted constants at this point, so `npx tsc --noEmit` fails until Task 3. That is expected mid-plan; vitest only compiles the files under test.

- [ ] **Step 6: Commit**

```bash
git add src/assets/checklist-default.json src/utils.ts src/utils.test.ts
git commit -m "refactor: move checklist criteria into checklist-default.json"
```

---

### Task 2: Persisted checklist store

**Files:**
- Create: `src/stores/useChecklistStore.ts`
- Test: `src/stores/useChecklistStore.test.ts`

- [ ] **Step 1: Write the failing store tests**

Create `src/stores/useChecklistStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useChecklistStore } from "./useChecklistStore";

describe("useChecklistStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useChecklistStore.getState().reset();
  });

  it("seeds from the bundled defaults with every entry enabled", () => {
    const { build, ai } = useChecklistStore.getState();
    expect(build).toHaveLength(12);
    expect(build.every((entry) => entry.enabled)).toBe(true);
    expect(ai).toEqual([{ ids: [0xa8a3163b], level: 15, enabled: true }]);
    const dmgCap = build.find((entry) => entry.ids[0] === 0xdc584f60)!;
    expect(dmgCap.ids).toEqual([0xdc584f60, 0x0151cf9e, 0x3b71af12, 0xaefeb1bc, 0xfff8cf64]);
    expect(dmgCap.level).toBe(65);
  });

  it("setLevel changes only the targeted entry, keyed by first id", () => {
    useChecklistStore.getState().setLevel("build", 0xdc584f60, 55);
    const { build } = useChecklistStore.getState();
    expect(build.find((entry) => entry.ids[0] === 0xdc584f60)!.level).toBe(55);
    expect(build.find((entry) => entry.ids[0] === 0x4c588c27)!.level).toBe(15);
  });

  it("toggle flips enabled without touching other fields", () => {
    useChecklistStore.getState().toggle("ai", 0xa8a3163b);
    expect(useChecklistStore.getState().ai).toEqual([{ ids: [0xa8a3163b], level: 15, enabled: false }]);
    useChecklistStore.getState().toggle("ai", 0xa8a3163b);
    expect(useChecklistStore.getState().ai[0].enabled).toBe(true);
  });

  it("remove drops the entry", () => {
    useChecklistStore.getState().remove("build", 0x4c588c27);
    expect(useChecklistStore.getState().build).toHaveLength(11);
    expect(useChecklistStore.getState().build.some((entry) => entry.ids[0] === 0x4c588c27)).toBe(false);
  });

  it("add appends a single-id enabled entry and rejects duplicates", () => {
    useChecklistStore.getState().add("build", 0x12345678, 20);
    let { build } = useChecklistStore.getState();
    expect(build).toHaveLength(13);
    expect(build[build.length - 1]).toEqual({ ids: [0x12345678], level: 20, enabled: true });

    // Duplicate of a new entry and of a default entry: both rejected.
    useChecklistStore.getState().add("build", 0x12345678, 30);
    useChecklistStore.getState().add("build", 0x4c588c27, 30);
    build = useChecklistStore.getState().build;
    expect(build).toHaveLength(13);
    expect(build[build.length - 1].level).toBe(20);
  });

  it("reset restores the bundled defaults", () => {
    useChecklistStore.getState().remove("build", 0x4c588c27);
    useChecklistStore.getState().setLevel("build", 0xdc584f60, 1);
    useChecklistStore.getState().add("ai", 0x12345678, 20);
    useChecklistStore.getState().reset();
    const { build, ai } = useChecklistStore.getState();
    expect(build).toHaveLength(12);
    expect(build.find((entry) => entry.ids[0] === 0xdc584f60)!.level).toBe(65);
    expect(ai).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/stores/useChecklistStore.test.ts`
Expected: FAIL — cannot resolve `./useChecklistStore`.

- [ ] **Step 3: Implement the store**

Create `src/stores/useChecklistStore.ts`:

```ts
import { defaultChecklist, type ChecklistEntry } from "@/utils";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { withStorageDOMEvents } from "./useMeterSettingsStore";

/** A checklist entry plus whether the user has it switched on. */
export type ChecklistSetting = ChecklistEntry & { enabled: boolean };

/** The two editable checklist groups: `build` (Sigils) and `ai` (AI companions). */
export type ChecklistGroup = "build" | "ai";

interface ChecklistState {
  build: ChecklistSetting[];
  ai: ChecklistSetting[];
  /** Entries are keyed by their first trait id (unique within a group). */
  setLevel: (group: ChecklistGroup, firstId: number, level: number) => void;
  toggle: (group: ChecklistGroup, firstId: number) => void;
  remove: (group: ChecklistGroup, firstId: number) => void;
  /** Appends a single-id enabled entry; a trait already in the group is a no-op. */
  add: (group: ChecklistGroup, traitId: number, level: number) => void;
  reset: () => void;
}

const seed = (): Pick<ChecklistState, "build" | "ai"> => {
  const defaults = defaultChecklist();
  const enable = (entries: ChecklistEntry[]): ChecklistSetting[] =>
    entries.map((entry) => ({ ...entry, enabled: true }));
  return { build: enable(defaults.build), ai: enable(defaults.ai) };
};

// A partial state update replacing one group's list; keeps the union-keyed
// update type-safe (a computed `[group]:` key would widen to a string index).
const withGroup = (
  state: ChecklistState,
  group: ChecklistGroup,
  update: (entries: ChecklistSetting[]) => ChecklistSetting[]
): Partial<ChecklistState> => (group === "build" ? { build: update(state.build) } : { ai: update(state.ai) });

export const useChecklistStore = create<ChecklistState>()(
  persist(
    (set) => ({
      ...seed(),
      setLevel: (group, firstId, level) =>
        set((state) =>
          withGroup(state, group, (entries) =>
            entries.map((entry) => (entry.ids[0] === firstId ? { ...entry, level } : entry))
          )
        ),
      toggle: (group, firstId) =>
        set((state) =>
          withGroup(state, group, (entries) =>
            entries.map((entry) => (entry.ids[0] === firstId ? { ...entry, enabled: !entry.enabled } : entry))
          )
        ),
      remove: (group, firstId) =>
        set((state) => withGroup(state, group, (entries) => entries.filter((entry) => entry.ids[0] !== firstId))),
      add: (group, traitId, level) =>
        set((state) =>
          withGroup(state, group, (entries) =>
            entries.some((entry) => entry.ids[0] === traitId)
              ? entries
              : [...entries, { ids: [traitId], level, enabled: true }]
          )
        ),
      reset: () => set(seed()),
    }),
    { name: "checklist-settings", version: 1 }
  )
);

withStorageDOMEvents(useChecklistStore);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/stores/useChecklistStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/useChecklistStore.ts src/stores/useChecklistStore.test.ts
git commit -m "feat: persisted user-editable checklist store"
```

---

### Task 3: View.tsx reads the store

Replace the deleted constants with the store's enabled entries; hide a group's header when it has no enabled entries. No behavior change for a user who hasn't edited anything.

**Files:**
- Modify: `src/pages/logs/View.tsx`

- [ ] **Step 1: Swap the imports**

In the big `@/utils` import block, delete the `AI_CHECKLIST,` and `BUILD_CHECKLIST,` lines (keep `type ChecklistEntry` — `ChecklistEntryRow` still uses it). Add with the other store imports near the top:

```ts
import { useChecklistStore } from "@/stores/useChecklistStore";
```

- [ ] **Step 2: Read the store in ViewPage**

In the `ViewPage` component, next to the existing `useMeterSettingsStore` call, add:

```ts
  const { checklistBuild, checklistAi } = useChecklistStore(
    useShallow((state) => ({ checklistBuild: state.build, checklistAi: state.ai }))
  );
```

- [ ] **Step 3: Render from the store**

In the Builds-tab checklist `<Table.Tr>` (the cell headed by `t("ui.player-checklist")`), the body currently renders three fixed groups. Update the callback to filter enabled entries and hide empty groups — replace the cell content from the `ui.checklist.sigils` header through the `AI_CHECKLIST` map with:

```tsx
                    {playerData.map((player) => {
                      const traits = computeCombinedTraits(player);
                      const byName = (a: ChecklistEntry, b: ChecklistEntry) =>
                        translateTraitId(a.ids[0]).localeCompare(translateTraitId(b.ids[0]));
                      const buildEntries = checklistBuild.filter((entry) => entry.enabled).sort(byName);
                      const aiEntries = checklistAi.filter((entry) => entry.enabled).sort(byName);

                      return (
                        <Table.Td key={player.actorIndex} style={{ verticalAlign: "top" }}>
                          <Text size="xs" fw={700}>
                            {t("ui.player-checklist")}
                          </Text>
                          {buildEntries.length > 0 && (
                            <>
                              <Text size="xs" fw={600} c="dimmed">
                                {t("ui.checklist.sigils")}
                              </Text>
                              {buildEntries.map((entry) => (
                                <ChecklistEntryRow key={entry.ids[0]} player={player} traits={traits} entry={entry} />
                              ))}
                            </>
                          )}
                          <Text size="xs" fw={600} c="dimmed" mt={4}>
                            {t("ui.checklist.computed")}
                          </Text>
                          <SigilCategoryRow player={player} categories={["basic"]} label="ui.checklist.basic-sigils" />
                          <SigilCategoryRow
                            player={player}
                            categories={["attack"]}
                            label="ui.checklist.attack-sigils"
                          />
                          <SigilCategoryRow
                            player={player}
                            categories={["defense", "support"]}
                            label="ui.checklist.defense-support-sigils"
                          />
                          {aiEntries.length > 0 && (
                            <>
                              <Text size="xs" fw={600} c="dimmed" mt={4}>
                                {t("ui.checklist.ai")}
                              </Text>
                              {aiEntries.map((entry) => (
                                <ChecklistEntryRow key={entry.ids[0]} player={player} traits={traits} entry={entry} />
                              ))}
                            </>
                          )}
                        </Table.Td>
                      );
                    })}
```

Notes:
- `.filter()` returns a fresh array, so the chained `.sort()` never mutates store state.
- `ChecklistSetting` structurally satisfies `ChecklistEntry`, so `ChecklistEntryRow` needs no change.
- The Computed rows (`SigilCategoryRow`) are intentionally untouched. If the current file's checklist cell differs cosmetically from the snippet (this section was recently moved), preserve its current structure and only apply the store/filter/conditional-header changes.

- [ ] **Step 4: Typecheck, lint, and run the frontend test suite**

Run: `npx tsc --noEmit` — expected: no errors (the dangling constant imports are gone).
Run: `npx eslint src/pages/logs/View.tsx` — expected: clean.
Run: `npx vitest run` — expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/logs/View.tsx
git commit -m "feat: Builds-tab checklist reads the editable checklist store"
```

---

### Task 4: Settings UI + strings

A "Checklist" fieldset in Settings with two editable sections and a reset button. Logic lives in a companion hook, following the page's `useSettings` pattern.

**Files:**
- Create: `src/pages/useChecklistSettings.ts`
- Modify: `src/pages/Settings.tsx`
- Modify: `src-tauri/lang/en/ui.json` (hand-editing ui.json is allowed; the other lang files fall back to en)

- [ ] **Step 1: Add the en strings**

In `src-tauri/lang/en/ui.json`, inside the top-level `"ui"` object (next to the existing `"checklist"` block), add:

```json
    "checklist-settings": {
      "title": "Checklist",
      "sigils-section": "Sigils checklist",
      "ai-section": "AI checklist",
      "add-trait": "Add trait...",
      "reset": "Reset to defaults"
    },
```

- [ ] **Step 2: Write the companion hook**

Create `src/pages/useChecklistSettings.ts`:

```ts
import { useChecklistStore, type ChecklistGroup } from "@/stores/useChecklistStore";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

/** Level assigned to entries added from the Settings picker. */
export const NEW_ENTRY_LEVEL = 15;

/**
 * State + handlers for the Settings "Checklist" fieldset: the two editable
 * entry lists and a searchable trait picker per group, fed from the loaded
 * i18next `traits` bundle.
 */
export default function useChecklistSettings() {
  // Requesting the namespace makes i18next load it (it is normally pulled in
  // lazily by pages that render trait names).
  const { i18n } = useTranslation("traits");
  const { build, ai, setLevel, toggle, remove, add, reset } = useChecklistStore(
    useShallow((state) => ({
      build: state.build,
      ai: state.ai,
      setLevel: state.setLevel,
      toggle: state.toggle,
      remove: state.remove,
      add: state.add,
      reset: state.reset,
    }))
  );

  // All known traits as Select options ("<hex>" value, translated label),
  // minus the ones already in the group. Recomputed per render — the bundle
  // only changes on language switch and the lists are small.
  const traitOptions = (group: ChecklistGroup): { value: string; label: string }[] => {
    const bundle = (i18n.getResourceBundle(i18n.language, "traits") ??
      i18n.getResourceBundle("en", "traits") ??
      {}) as Record<string, { text?: string }>;
    const present = new Set((group === "build" ? build : ai).map((entry) => entry.ids[0]));
    return Object.entries(bundle)
      .filter(([hex, value]) => Boolean(value?.text) && !present.has(parseInt(hex, 16)))
      .map(([hex, value]) => ({ value: hex, label: value.text as string }))
      .sort((a, b) => a.label.localeCompare(b.label));
  };

  const addTrait = (group: ChecklistGroup, hex: string | null) => {
    if (!hex) return;
    add(group, parseInt(hex, 16), NEW_ENTRY_LEVEL);
  };

  const setEntryLevel = (group: ChecklistGroup, firstId: number, value: number | string) => {
    const level = typeof value === "number" ? value : parseInt(value, 10);
    if (!Number.isFinite(level)) return;
    setLevel(group, firstId, Math.max(1, Math.round(level)));
  };

  return { build, ai, toggle, remove, reset, traitOptions, addTrait, setEntryLevel };
}
```

- [ ] **Step 3: Render the fieldset in Settings.tsx**

In `src/pages/Settings.tsx`:

Add `NumberInput` to the `@mantine/core` import list, and import the pieces:

```ts
import useChecklistSettings from "./useChecklistSettings";
import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { translateTraitId } from "@/utils";
```

In the component body, after the `useSettings()` destructure:

```ts
  const checklist = useChecklistSettings();
```

Directly above the component, add the section component (same file — it is Settings-only). Translated strings (`legend`, `addPlaceholder`) are passed in as props because the page's `t` from `useTranslation()` is not in scope at module level:

```tsx
const ChecklistSection = ({
  group,
  legend,
  addPlaceholder,
  checklist,
}: {
  group: ChecklistGroup;
  legend: string;
  addPlaceholder: string;
  checklist: ReturnType<typeof useChecklistSettings>;
}) => {
  const entries = group === "build" ? checklist.build : checklist.ai;

  return (
    <Box>
      <Text size="sm" fw={600}>
        {legend}
      </Text>
      {entries.map((entry) => (
        <Flex key={entry.ids[0]} align="center" gap="xs" mt={4}>
          <Checkbox checked={entry.enabled} onChange={() => checklist.toggle(group, entry.ids[0])} />
          <Text size="sm" flex={1}>
            {translateTraitId(entry.ids[0])}
          </Text>
          <NumberInput
            value={entry.level}
            min={1}
            step={1}
            w={90}
            onChange={(value) => checklist.setEntryLevel(group, entry.ids[0], value)}
          />
          <ActionIcon
            aria-label="Remove entry"
            variant="transparent"
            color="gray"
            onClick={() => checklist.remove(group, entry.ids[0])}
          >
            x
          </ActionIcon>
        </Flex>
      ))}
      <Select
        mt="xs"
        searchable
        limit={50}
        placeholder={addPlaceholder}
        data={checklist.traitOptions(group)}
        value={null}
        onChange={(hex) => checklist.addTrait(group, hex)}
      />
    </Box>
  );
};
```

Then, in the page's JSX after the closing `</Fieldset>` of the meter settings, add:

```tsx
      <Fieldset legend={t("ui.checklist-settings.title")} mt="md">
        <Stack>
          <ChecklistSection
            group="build"
            legend={t("ui.checklist-settings.sigils-section")}
            addPlaceholder={t("ui.checklist-settings.add-trait")}
            checklist={checklist}
          />
          <ChecklistSection
            group="ai"
            legend={t("ui.checklist-settings.ai-section")}
            addPlaceholder={t("ui.checklist-settings.add-trait")}
            checklist={checklist}
          />
          <Button variant="default" onClick={checklist.reset}>
            {t("ui.checklist-settings.reset")}
          </Button>
        </Stack>
      </Fieldset>
```

(`t` inside the page comes from the existing `useTranslation()` call.)

- [ ] **Step 4: Typecheck, lint, full test run**

Run: `npx tsc --noEmit` — expected: no errors.
Run: `npx eslint src/pages/Settings.tsx src/pages/useChecklistSettings.ts` — expected: clean.
Run: `npx vitest run` — expected: all suites pass.

- [ ] **Step 5: Manual verification in the app**

Run: `npm run dev` (frontend + console-feature hook build; the Settings and Logs pages work without the game running).
- Settings tab shows the Checklist fieldset with 12 Sigils entries and 1 AI entry, all checked.
- Change DMG Cap's level to 55, uncheck Stun Power, remove Guts, add a trait via the picker.
- Open any saved log → Builds tab: the checklist reflects those edits immediately (level 55 target, no Stun Power row, no Guts row, new trait present).
- Reload the app (Ctrl+R or restart): edits persist.
- Reset to defaults: Settings and Builds tab both return to the original 12+1.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Settings.tsx src/pages/useChecklistSettings.ts src-tauri/lang/en/ui.json
git commit -m "feat: editable checklist in the Settings tab"
```
