import { describe, expect, it } from "vitest";

import {
  ALL_SKILL_COLUMNS,
  ColumnSetting,
  DEFAULT_LOGS_COLUMNS,
  DEFAULT_LOGS_SKILL_COLUMNS,
  DEFAULT_OVERLAY_COLUMNS,
  DEFAULT_OVERLAY_SKILL_COLUMNS,
  reconcileColumns,
  SkillColumns,
  visibleColumns,
} from "@/types";

describe("default column sets", () => {
  it("overlay and logs player defaults show different columns", () => {
    expect(visibleColumns(DEFAULT_OVERLAY_COLUMNS)).not.toEqual(visibleColumns(DEFAULT_LOGS_COLUMNS));
  });

  it("overlay and logs skill defaults show different columns", () => {
    expect(visibleColumns(DEFAULT_OVERLAY_SKILL_COLUMNS)).not.toEqual(visibleColumns(DEFAULT_LOGS_SKILL_COLUMNS));
  });

  it("the lean overlay skill set shows fewer columns than the full logs set", () => {
    for (const column of visibleColumns(DEFAULT_OVERLAY_SKILL_COLUMNS)) {
      expect(visibleColumns(DEFAULT_LOGS_SKILL_COLUMNS)).toContain(column);
    }
    expect(visibleColumns(DEFAULT_OVERLAY_SKILL_COLUMNS).length).toBeLessThan(
      visibleColumns(DEFAULT_LOGS_SKILL_COLUMNS).length
    );
  });

  it("every column set lists all columns (hidden ones stay in place)", () => {
    // Full logs skill set shows all 11 columns; the lean overlay set still lists
    // all 11 (the extras just hidden), so toggling one on never reorders.
    expect(DEFAULT_OVERLAY_SKILL_COLUMNS.length).toBe(DEFAULT_LOGS_SKILL_COLUMNS.length);
  });
});

describe("reconcileColumns", () => {
  it("appends universe columns missing from the saved list as hidden, keeping order and visibility", () => {
    // A stored list from before some columns existed (only two of the eleven).
    const saved: ColumnSetting<SkillColumns>[] = [
      { id: SkillColumns.TotalDamage, visible: true },
      { id: SkillColumns.Hits, visible: false },
    ];

    const result = reconcileColumns(saved, ALL_SKILL_COLUMNS);

    // Saved entries stay first, in order, with their original visibility.
    expect(result.slice(0, 2)).toEqual(saved);
    // Every universe column is now present exactly once (the new feature: added
    // columns become reachable in the picker).
    expect([...result.map((c) => c.id)].sort()).toEqual([...ALL_SKILL_COLUMNS].sort());
    // The freshly-appended columns default to hidden.
    expect(result.slice(2).every((c) => !c.visible)).toBe(true);
  });

  it("drops a column no longer in the universe", () => {
    const saved = [
      { id: SkillColumns.Hits, visible: true },
      { id: "obsolete-column" as SkillColumns, visible: true },
    ];

    const result = reconcileColumns(saved, [SkillColumns.Hits]);

    expect(result).toEqual([{ id: SkillColumns.Hits, visible: true }]);
  });

  it("drops explicitly removed columns even if still saved", () => {
    const saved: ColumnSetting<SkillColumns>[] = [
      { id: SkillColumns.Hits, visible: true },
      { id: SkillColumns.Overcap, visible: true },
    ];

    const result = reconcileColumns(saved, ALL_SKILL_COLUMNS, [SkillColumns.Overcap]);

    expect(result.find((c) => c.id === SkillColumns.Overcap)).toBeUndefined();
  });
});
