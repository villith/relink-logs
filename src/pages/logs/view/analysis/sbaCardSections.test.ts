import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import { SBA_UNATTRIBUTED_KEY } from "../rowKey";

import { sbaCardSectionsFor } from "./sbaCardSections";

/** The same fixture shape `metrics/sba.test.ts` builds, so the card and the
 * table it explains are exercised against one idea of a player. */
const player = (
  index: number,
  values: {
    sbaGenerated?: number;
    skillBreakdown?: { action: number; sbaGenerated?: number }[];
    sbaSources?: { kind: string; id?: number; generated: number }[];
  }
) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    sba: 0,
    sbaGenerated: values.sbaGenerated,
    sbaSources: (values.sbaSources ?? []).map((s) => ({ kind: s.kind, id: s.id ?? null, generated: s.generated })),
    skillBreakdown: (values.skillBreakdown ?? []).map((s) => ({
      actionType: { Normal: s.action },
      childCharacterType: "Pl0000",
      hits: 1,
      minDamage: 0,
      maxDamage: 0,
      totalDamage: 0,
      sbaGenerated: s.sbaGenerated,
      totalStunValue: 0,
      maxStunValue: 0,
      cappedHits: 0,
      cappableHits: 0,
      overcapBaseSum: 0,
      overcapCapSum: 0,
    })),
  }) as unknown as ComputedPlayerState;

const LABELS = {
  ability: (key: string) => `ability:${key}`,
  cause: (labelKey: string, params?: Record<string, string | number>) =>
    params === undefined ? labelKey : `${labelKey} ${Object.values(params).join(" ")}`,
};

const sectionsFor = (players: ComputedPlayerState[], key: string) =>
  sbaCardSectionsFor({ row: { key }, players, color: "#abc", labels: LABELS });

describe("sbaCardSectionsFor", () => {
  it("splits a player row by ability and by cause", () => {
    const sections = sectionsFor(
      [
        player(0, {
          sbaGenerated: 1000,
          skillBreakdown: [
            { action: 1, sbaGenerated: 400 },
            { action: 2, sbaGenerated: 200 },
          ],
          sbaSources: [{ kind: "partyAward", generated: 300 }],
        }),
      ],
      "player:0"
    );

    expect(sections?.map((section) => section.headingKey)).toEqual([
      "ui.logs.hover-by-ability",
      "ui.logs.hover-by-sba-cause",
    ]);
    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([400, 200]);
    expect(sections?.[1].entries[0].label).toBe("ui.logs.sba-cause-party-award");
  });

  it("closes the gap with the same unattributed remainder the table draws", () => {
    // 1000 generated, 600 explained — the card must not sum to less than the
    // row above it, which is exactly what the generic skill walk would do.
    const sections = sectionsFor(
      [
        player(0, {
          sbaGenerated: 1000,
          skillBreakdown: [{ action: 1, sbaGenerated: 400 }],
          sbaSources: [{ kind: "partyAward", generated: 200 }],
        }),
      ],
      "player:0"
    );

    const causes = sections?.[1].entries ?? [];
    expect(causes.at(-1)?.key).toBe(SBA_UNATTRIBUTED_KEY);
    expect(causes.at(-1)?.value).toBe(400);
    expect(sections?.flatMap((section) => section.entries).reduce((sum, entry) => sum + entry.value, 0)).toBe(1000);
  });

  it("draws no remainder when the split already explains the total", () => {
    const sections = sectionsFor(
      [player(0, { sbaGenerated: 400, skillBreakdown: [{ action: 1, sbaGenerated: 400 }] })],
      "player:0"
    );
    // Ability section only — nothing left for a cause section to hold.
    expect(sections?.map((section) => section.headingKey)).toEqual(["ui.logs.hover-by-ability"]);
  });

  it("drops a sub-unit gap, like the table's rounding column", () => {
    const sections = sectionsFor(
      [player(0, { sbaGenerated: 400.4, skillBreakdown: [{ action: 1, sbaGenerated: 400 }] })],
      "player:0"
    );
    expect(sections?.map((section) => section.headingKey)).toEqual(["ui.logs.hover-by-ability"]);
  });

  it("ranks each section on its own and skips honest zeros", () => {
    const sections = sectionsFor(
      [
        player(0, {
          sbaGenerated: 500,
          skillBreakdown: [
            { action: 1, sbaGenerated: 100 },
            { action: 2, sbaGenerated: 0 },
            { action: 3, sbaGenerated: 250 },
          ],
          sbaSources: [
            { kind: "damageTaken", generated: 50 },
            { kind: "questStart", generated: 100 },
          ],
        }),
      ],
      "player:0"
    );

    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([250, 100]);
    expect(sections?.[1].entries.map((entry) => entry.value)).toEqual([100, 50]);
  });

  it("no card for a row that is not a player's", () => {
    const players = [player(0, { sbaGenerated: 100, skillBreakdown: [{ action: 1, sbaGenerated: 100 }] })];
    expect(sectionsFor(players, "skill:1")).toBeNull();
    expect(sectionsFor(players, "source:partyAward")).toBeNull();
    expect(sectionsFor(players, SBA_UNATTRIBUTED_KEY)).toBeNull();
    // A stale player index names nobody.
    expect(sectionsFor(players, "player:9")).toBeNull();
  });

  it("no card for a log recorded before the generated total — there is no denominator", () => {
    expect(sectionsFor([player(0, { skillBreakdown: [{ action: 1, sbaGenerated: 100 }] })], "player:0")).toBeNull();
  });

  it("no card for a player with nothing attributed — the table's empty state says why", () => {
    // A remote member's gauge is synced rather than granted by a hit the hook
    // can see, so a card here would be an empty panel over a real row.
    expect(sectionsFor([player(0, { sbaGenerated: 800 })], "player:0")).toBeNull();
  });
});
