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
  kindChipLabel: (label: string, count: number) => `${label} ×${count}`,
  rangeLabel: (startMs: number, endMs: number) => `${startMs / 1000}-${endMs / 1000}`,
  durationLabel: (ms: number) => `${ms / 1000}s`,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- trailing param required by WindowChipLabels' shape, unused in this test double
  breakEnemyLabel: (actorIndex: number | null, _window: ChartWindow) => (actorIndex === 7 ? "Vrazarek" : null),
};

describe("windowChips", () => {
  it("builds one kind chip then one chip per window, in kind order", () => {
    const chips = windowChips(WINDOWS, null, LABELS);
    expect(chips.map((chip) => chip.value)).toEqual(["sba", "sba:0", "sba:1", "break", "break:0"]);
    expect(chips[0].label).toBe("SBA ×2");
    expect(chips[1].label).toBe("10-20");
    expect(chips[1].durationLabel).toBe("10s");
  });

  it("marks the selected chip", () => {
    const chips = windowChips(WINDOWS, "sba:1", LABELS);
    expect(chips.find((chip) => chip.value === "sba:1")?.selected).toBe(true);
    expect(chips.filter((chip) => chip.selected)).toHaveLength(1);
  });

  it("names a break window's enemy when resolvable", () => {
    const chips = windowChips(WINDOWS, null, LABELS);
    expect(chips.find((chip) => chip.value === "break:0")?.label).toContain("Vrazarek");
  });

  it("no windows, no chips", () => {
    expect(windowChips([], null, LABELS)).toEqual([]);
  });
});
