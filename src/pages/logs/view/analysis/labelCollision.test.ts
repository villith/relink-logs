import { describe, expect, it } from "vitest";

import type { MetricRow } from "../metrics/types";

import { qualifiedAbilityLabels, qualifyDuplicateLabels } from "./labelCollision";

describe("qualifyDuplicateLabels", () => {
  it("appends the qualifier only where a label collides", () => {
    expect(
      qualifyDuplicateLabels([
        { label: "Normal Attack", qualifier: "Id" },
        { label: "Normal Attack", qualifier: "Eustace" },
        { label: "Reginleiv", qualifier: "Id" },
      ])
    ).toEqual(["Normal Attack (Id)", "Normal Attack (Eustace)", "Reginleiv"]);
  });

  it("leaves a colliding label bare when there is no qualifier to add", () => {
    expect(
      qualifyDuplicateLabels([
        { label: "Attack 4", qualifier: "" },
        { label: "Attack 4", qualifier: "Id" },
      ])
    ).toEqual(["Attack 4", "Attack 4 (Id)"]);
  });

  it("does not restate a qualifier the label already carries", () => {
    // Same "already stated" rule as legendLabelFor.
    expect(
      qualifyDuplicateLabels([
        { label: "Id's Normal Attack", qualifier: "Id" },
        { label: "Id's Normal Attack", qualifier: "Narmaya" },
      ])
    ).toEqual(["Id's Normal Attack", "Id's Normal Attack (Narmaya)"]);
  });
});

describe("qualifiedAbilityLabels", () => {
  const abilityRow = (key: string): MetricRow => ({
    key: `skill:${key}`,
    label: key,
    kind: "ability",
    value: 0,
    columns: [],
    pinOnClick: null,
    colorSlot: -1,
  });

  const rows: MetricRow[] = [
    abilityRow('Group:normal-attack@"Pl0900"'),
    abilityRow('Group:normal-attack@"Pl1000"'),
    abilityRow("Normal:9001"),
    // Not an ability row: never qualified, never in the map.
    { key: "player:0", label: "0", kind: "player", value: 0, columns: [], pinOnClick: null, colorSlot: 0 },
  ];

  const LABELS: Record<string, string> = {
    'Group:normal-attack@"Pl0900"': "Normal Attack",
    'Group:normal-attack@"Pl1000"': "Normal Attack",
    "Normal:9001": "Reginleiv",
  };
  const QUALIFIERS: Record<string, string> = {
    'Group:normal-attack@"Pl0900"': "Id",
    'Group:normal-attack@"Pl1000"': "Eustace",
    "Normal:9001": "Id",
  };

  it("maps colliding ability rows to qualified labels, keyed by row key", () => {
    const map = qualifiedAbilityLabels(
      rows,
      (key) => LABELS[key] ?? key,
      (key) => QUALIFIERS[key] ?? ""
    );

    expect(map.get('skill:Group:normal-attack@"Pl0900"')).toBe("Normal Attack (Id)");
    expect(map.get('skill:Group:normal-attack@"Pl1000"')).toBe("Normal Attack (Eustace)");
    // No collision → the plain label, so the view can use the map unconditionally.
    expect(map.get("skill:Normal:9001")).toBe("Reginleiv");
    expect(map.has("player:0")).toBe(false);
  });

  it("skips self-naming rows — they resolve against nothing", () => {
    const selfNamed: MetricRow = {
      key: "other",
      label: "",
      kind: "ability",
      labelKey: "ui.logs.chart-other-label",
      value: 0,
      columns: [],
      pinOnClick: null,
      colorSlot: -1,
    };
    const map = qualifiedAbilityLabels(
      [selfNamed],
      () => "x",
      () => "y"
    );
    expect(map.has("other")).toBe(false);
  });
});
