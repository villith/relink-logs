import { describe, expect, it } from "vitest";

import type { ChartWindow } from "@/types";

import { windowChips } from "./windowChips";

const WINDOWS: ChartWindow[] = [
  { kind: "sba", startMs: 10_000, endMs: 20_000, actorIndex: null },
  { kind: "sba", startMs: 50_000, endMs: 60_000, actorIndex: null },
  { kind: "break", startMs: 40_000, endMs: 55_000, actorIndex: 7 },
];

const LABELS = {
  kindLabel: (kind: ChartWindow["kind"]) => kind.toUpperCase(),
  totalLabel: (count: number) => `×${count}`,
  selectedLabel: (selected: number, total: number) => `${selected}/${total}`,
  rangeLabel: (startMs: number, endMs: number) => `${startMs / 1000}-${endMs / 1000}`,
  durationLabel: (ms: number) => `${ms / 1000}s`,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- trailing param required by WindowChipLabels' shape, unused in this test double
  breakEnemyLabel: (actorIndex: number | null, _window: ChartWindow) => (actorIndex === 7 ? "Vrazarek" : null),
};

describe("windowChips", () => {
  it("builds one group per kind present, each holding its own windows", () => {
    const groups = windowChips(WINDOWS, [], LABELS);
    expect(groups.map((group) => group.kind)).toEqual(["sba", "break"]);
    expect(groups[0].kindLabel).toBe("SBA");
    expect(groups[0].allValue).toBe("sba");
    expect(groups[0].items.map((item) => item.value)).toEqual(["sba:0", "sba:1"]);
    expect(groups[0].items[0].label).toBe("10-20");
    expect(groups[0].items[0].durationLabel).toBe("10s");
  });

  it("marks the selected window and leaves its neighbours alone", () => {
    const groups = windowChips(WINDOWS, ["sba:1"], LABELS);
    expect(groups[0].items.map((item) => item.selected)).toEqual([false, true]);
    expect(groups[0].selectedCount).toBe(1);
    expect(groups[0].active).toBe(true);
    // A different kind is untouched by the other's selection.
    expect(groups[1].active).toBe(false);
  });

  it("selects across kinds at once", () => {
    const groups = windowChips(WINDOWS, ["sba:0", "break:0"], LABELS);
    expect(groups[0].active).toBe(true);
    expect(groups[1].active).toBe(true);
  });

  it("a selected kind admits every window under it, whatever the rows say", () => {
    const groups = windowChips(WINDOWS, ["sba"], LABELS);
    expect(groups[0].allSelected).toBe(true);
    expect(groups[0].selectedCount).toBe(2);
    // The individual rows are not themselves ticked — the kind row is what
    // admits them, and the strip draws them ticked from `allSelected`.
    expect(groups[0].items.every((item) => !item.selected)).toBe(true);
  });

  it("shows the bare total at rest and the selected-of-total count while partial", () => {
    expect(windowChips(WINDOWS, [], LABELS)[0].figure).toBe("×2");
    expect(windowChips(WINDOWS, ["sba:1"], LABELS)[0].figure).toBe("1/2");
    // Everything picked is not a partial selection — "2/2" would suggest
    // something had been left out.
    expect(windowChips(WINDOWS, ["sba:0", "sba:1"], LABELS)[0].figure).toBe("×2");
    expect(windowChips(WINDOWS, ["sba"], LABELS)[0].figure).toBe("×2");
  });

  it("names a break window's enemy when resolvable", () => {
    const groups = windowChips(WINDOWS, [], LABELS);
    expect(groups[1].items[0].label).toContain("Vrazarek");
  });

  it("no windows, no groups", () => {
    expect(windowChips([], [], LABELS)).toEqual([]);
  });
});
