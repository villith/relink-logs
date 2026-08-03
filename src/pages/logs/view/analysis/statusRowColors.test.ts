import { describe, expect, it } from "vitest";

import { statusRowColors } from "./statusRowColors";

describe("statusRowColors", () => {
  it("assigns categorical colours to slotless rows in table order", () => {
    const colors = statusRowColors([
      { key: "status:10:500", colorSlot: -1 },
      { key: "status:20:600", colorSlot: -1 },
    ]);
    expect(colors.get("status:10:500")).toBe("var(--mantine-color-red-6)");
    expect(colors.get("status:20:600")).toBe("var(--mantine-color-cyan-6)");
  });

  it("skips rows that already have a party colour", () => {
    // A player holder row keeps its party slot colour; it must not consume a
    // categorical position either, or pinning a buff would recolour the table.
    const colors = statusRowColors([
      { key: "player:0", colorSlot: 0 },
      { key: "target:2", colorSlot: -1 },
    ]);
    expect(colors.has("player:0")).toBe(false);
    expect(colors.get("target:2")).toBe("var(--mantine-color-red-6)");
  });
});
