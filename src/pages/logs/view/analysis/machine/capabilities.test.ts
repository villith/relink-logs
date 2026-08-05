import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { DIMENSIONS, METRIC_KEYS } from "./state";

describe("CAPABILITIES", () => {
  it("declares every metric", () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...METRIC_KEYS].sort());
  });

  it("orders dimensions source-first for the event metrics", () => {
    expect(CAPABILITIES.damage.dimensionOrder).toEqual(["source", "ability", "target"]);
    expect(CAPABILITIES.taken.dimensionOrder).toEqual(["source", "ability", "target"]);
  });

  it("declares the honest limits", () => {
    expect(CAPABILITIES.sba.dimensions.ability.supported).toBe(false);
    expect(CAPABILITIES.sba.dimensions.ability.disabledReasonKey).toBe("ui.logs.sba-no-breakdown");
    expect(CAPABILITIES.stun.dimensions.target.supported).toBe(false);
    expect(CAPABILITIES.stun.supportsHostility).toBe(false);
    expect(CAPABILITIES.sba.supportsHostility).toBe(false);
  });

  it("routes each metric to its data path", () => {
    expect(CAPABILITIES.damage.dataPath).toBe("groups");
    expect(CAPABILITIES.taken.dataPath).toBe("groups");
    expect(CAPABILITIES.stun.dataPath).toBe("derived");
    expect(CAPABILITIES.sba.dataPath).toBe("derived");
    expect(CAPABILITIES.buffs.dataPath).toBe("intervals");
    expect(CAPABILITIES.debuffs.dataPath).toBe("intervals");
  });

  it("declares which hover card explains each grouping", () => {
    expect(CAPABILITIES.damage.cardKind("source", "friendly")).toBe("skill");
    expect(CAPABILITIES.damage.cardKind("ability", "friendly")).toBe("skill");
    // A friendly target row still leaves ability and source free — the card
    // decomposes both (the old "fixes every dimension" rationale was wrong).
    expect(CAPABILITIES.damage.cardKind("target", "friendly")).toBe("skill");
    expect(CAPABILITIES.damage.cardKind("source", "enemy")).toBe("enemyDealt");
    // The enemy-side builders decompose attacker/victim rows only; the other
    // groupings' rows have no builder, and the declaration says so rather
    // than promising a card that arrives null.
    expect(CAPABILITIES.damage.cardKind("ability", "enemy")).toBe("none");
    expect(CAPABILITIES.damage.cardKind("target", "enemy")).toBe("none");
    expect(CAPABILITIES.taken.cardKind("source", "friendly")).toBe("taken");
    expect(CAPABILITIES.taken.cardKind("ability", "friendly")).toBe("taken");
    expect(CAPABILITIES.taken.cardKind("target", "friendly")).toBe("none");
    expect(CAPABILITIES.taken.cardKind("source", "enemy")).toBe("enemyReceived");
    expect(CAPABILITIES.taken.cardKind("ability", "enemy")).toBe("none");
    expect(CAPABILITIES.taken.cardKind("target", "enemy")).toBe("none");
    expect(CAPABILITIES.stun.cardKind("source", "friendly")).toBe("skill");
    expect(CAPABILITIES.sba.cardKind("source", "friendly")).toBe("none");
    expect(CAPABILITIES.buffs.cardKind("ability", "friendly")).toBe("none");
  });

  it("names every supported dimension's regroup tab on both sides", () => {
    for (const caps of Object.values(CAPABILITIES)) {
      for (const dim of caps.dimensionOrder) {
        const decl = caps.dimensions[dim];
        if (!decl.supported) continue;
        expect(decl.groupLabelKey.friendly).toMatch(/^ui\.logs\./);
        expect(decl.groupLabelKey.enemy).toMatch(/^ui\.logs\./);
      }
    }
  });

  // The upcoming derivation rule ("first unpinned supported entry") walks
  // `dimensionOrder` and trusts every entry in it to be pinnable, and trusts
  // every pinnable dimension to be reachable by walking it — so the two lists
  // must name exactly the same set, in both directions.
  it("keeps dimensionOrder exactly the set of supported dimensions", () => {
    for (const [metric, caps] of Object.entries(CAPABILITIES)) {
      for (const dim of caps.dimensionOrder) {
        expect(caps.dimensions[dim].supported, `${metric}.dimensionOrder lists unsupported dimension "${dim}"`).toBe(
          true
        );
      }
      for (const dim of DIMENSIONS) {
        if (caps.dimensions[dim].supported) {
          expect(caps.dimensionOrder, `${metric}.dimensionOrder is missing supported dimension "${dim}"`).toContain(
            dim
          );
        }
      }
    }
  });
});

describe("CAPABILITIES against the real ui.json", () => {
  const ui = JSON.parse(readFileSync("src-tauri/lang/en/ui.json", "utf-8"));

  /** Walks a dotted key ("ui.logs.groupby-damage-source") into the nested
   * ui.json object, the same grammar the app's i18next keys already use. */
  const resolve = (dottedKey: string): unknown =>
    dottedKey
      .split(".")
      .reduce(
        (node: unknown, part) =>
          typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined,
        ui
      );

  it("resolves every supported dimension's groupLabelKey", () => {
    for (const caps of Object.values(CAPABILITIES)) {
      for (const dim of DIMENSIONS) {
        const decl = caps.dimensions[dim];
        if (!decl.supported) continue;
        expect(typeof resolve(decl.groupLabelKey.friendly)).toBe("string");
        expect(typeof resolve(decl.groupLabelKey.enemy)).toBe("string");
      }
    }
  });

  it("resolves every disabledReasonKey", () => {
    for (const caps of Object.values(CAPABILITIES)) {
      for (const dim of DIMENSIONS) {
        const reasonKey = caps.dimensions[dim].disabledReasonKey;
        if (reasonKey === undefined) continue;
        expect(typeof resolve(reasonKey)).toBe("string");
      }
    }
  });
});
