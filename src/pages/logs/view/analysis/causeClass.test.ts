import { describe, expect, it } from "vitest";

import type { MetricRow } from "../metrics/types";

import { CAUSE_CLASS_LABEL_KEY, CAUSE_CLASS_ORDER, causeClassOf, causeClassOfKey, withProvenance } from "./causeClass";
import { statusKeyParts } from "./statusLabel";

describe("statusKeyParts", () => {
  it("parses both ids and the unknown cause", () => {
    expect(statusKeyParts("status:10:500:unknown")).toEqual({ statusId: 10, causeId: 500, classHash: null });
    expect(statusKeyParts("status:10:unknown:unknown")).toEqual({ statusId: 10, causeId: null, classHash: null });
    expect(statusKeyParts("skill:9")).toBeNull();
    expect(statusKeyParts("player:0")).toBeNull();
  });
});

describe("causeClassOf", () => {
  it("files the unattributed sentinels as unknown — causeLabel's own test", () => {
    expect(causeClassOf(null, false)).toBe("unknown");
    expect(causeClassOf(0, true)).toBe("unknown");
    expect(causeClassOf(0xffffffff, true)).toBe("unknown");
  });

  it("files the environment cause as field", () => {
    expect(causeClassOf(1048575, true)).toBe("field");
  });

  it("files the passive-gear bands as sigilTrait", () => {
    expect(causeClassOf(9999, true)).toBe("sigilTrait");
    expect(causeClassOf(10000, true)).toBe("sigilTrait");
    expect(causeClassOf(10001, true)).toBe("sigilTrait");
    expect(causeClassOf(10002, true)).toBe("sigilTrait");
  });

  it("files a NAMED cause as skill — character actions and the action bands alike", () => {
    expect(causeClassOf(1100, true)).toBe("skill"); // Scourge (Dragonform)
    expect(causeClassOf(800, true)).toBe("skill"); // Chain Burst
    expect(causeClassOf(99996, true)).toBe("skill"); // Perfect Guard
  });

  it("files a numeric cause nothing names as unknown — no fabricated provenance", () => {
    expect(causeClassOf(31337, false)).toBe("unknown");
  });
});

describe("causeClassOfKey", () => {
  it("classifies off the row key, resolving names only for real ids", () => {
    expect(causeClassOfKey("status:10:9999:unknown", () => true)).toBe("sigilTrait");
    expect(causeClassOfKey("status:10:1100:unknown", (id) => id === 1100)).toBe("skill");
    expect(causeClassOfKey("status:10:unknown:unknown", () => true)).toBe("unknown");
    expect(causeClassOfKey("not-a-status-key", () => true)).toBe("unknown");
  });
});

describe("withProvenance", () => {
  const row = (key: string, value: number): MetricRow => ({
    key,
    label: key,
    value,
    columns: ["10%", "3"],
    pinOnClick: null,
    colorSlot: -1,
  });

  // Arrives sorted by uptime, as statusRows sorts.
  const ROWS = [
    row("status:1:9999:unknown", 900), // sigilTrait
    row("status:2:1100:unknown", 800), // skill
    row("status:3:unknown:unknown", 700), // unknown
    row("status:4:1048575:unknown", 600), // field
    row("status:5:1200:unknown", 500), // skill
  ];

  const classOf = (r: MetricRow) => causeClassOfKey(r.key, (id) => id === 1100 || id === 1200 || id > 0);

  it("orders sections Skill → Sigil/Trait → Field → Unknown, keeping uptime order inside each", () => {
    const decorated = withProvenance(ROWS, classOf, (cls) => cls);
    expect(decorated.map((r) => r.key)).toEqual([
      "status:2:1100:unknown",
      "status:5:1200:unknown",
      "status:1:9999:unknown",
      "status:4:1048575:unknown",
      "status:3:unknown:unknown",
    ]);
  });

  it("prepends the SOURCE cell to each row's columns", () => {
    const decorated = withProvenance(ROWS, classOf, (cls) => `label:${cls}`);
    expect(decorated[0].columns).toEqual(["label:skill", "10%", "3"]);
    expect(decorated[4].columns).toEqual(["label:unknown", "10%", "3"]);
  });

  it("declares a label key for every class, in section order", () => {
    expect(CAUSE_CLASS_ORDER).toEqual(["skill", "sigilTrait", "field", "unknown"]);
    for (const cls of CAUSE_CLASS_ORDER) {
      expect(CAUSE_CLASS_LABEL_KEY[cls]).toMatch(/^ui\.logs\./);
    }
  });
});
