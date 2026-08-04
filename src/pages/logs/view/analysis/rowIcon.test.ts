import { describe, expect, it } from "vitest";

import { abilityRowKey } from "../abilitySkills";

import { abilityRowIconUrl, type IconRowPlayer } from "./rowIcon";

const player = (characterType: string, skills: IconRowPlayer["skillBreakdown"]): IconRowPlayer => ({
  characterType,
  skillBreakdown: skills,
});

describe("abilityRowIconUrl", () => {
  it("resolves a raw ability action to its owner's diamond", () => {
    const gran = player("Pl0000", [{ actionType: { Normal: 1200 }, childCharacterType: "" }]);
    expect(abilityRowIconUrl("Normal:1200", [gran])).toMatch(/pl0000_01\.png/); // Decimate
  });

  it("resolves a GROUP row through a member action", () => {
    // 1001 is Overdrive Surge (Arts I), grouped as overdrive-surge for Pl0000 —
    // the row key is derived, not spelled, so this cannot drift from the table.
    const skill = { actionType: { Normal: 1001 }, childCharacterType: "Pl0000" };
    const gran = player("Pl0000", [skill]);
    expect(abilityRowIconUrl(abilityRowKey(skill), [gran])).toMatch(/pl0000_08\.png/);
  });

  it("resolves through the child character where a hit has one", () => {
    // Id's dragonform Scourge: the player is Pl1900, the art is Pl2000's.
    const id = player("Pl1900", [{ actionType: { Normal: 1100 }, childCharacterType: "Pl2000" }]);
    expect(abilityRowIconUrl("Normal:1100", [id])).toMatch(/pl2000_05\.png/);
  });

  it("prefers the pinned owner on colliding action ids", () => {
    // 1200 is Gran's Decimate AND dragonform's Never Enough.
    const gran = player("Pl0000", [{ actionType: { Normal: 1200 }, childCharacterType: "" }]);
    const dragon = player("Pl2000", [{ actionType: { Normal: 1200 }, childCharacterType: "" }]);
    expect(abilityRowIconUrl("Normal:1200", [gran, dragon])).toMatch(/pl0000_01\.png/);
    expect(abilityRowIconUrl("Normal:1200", [gran, dragon], dragon)).toMatch(/pl2000_07\.png/);
  });

  it("returns undefined for actions that are not ability casts", () => {
    const gran = player("Pl0000", [
      { actionType: "LinkAttack", childCharacterType: "" },
      { actionType: { Normal: 100 }, childCharacterType: "" }, // Attack 1
    ]);
    expect(abilityRowIconUrl("LinkAttack", [gran])).toBeUndefined();
    expect(abilityRowIconUrl("Normal:100", [gran])).toBeUndefined();
  });

  it("returns undefined for a key nobody used", () => {
    expect(abilityRowIconUrl("Normal:1200", [])).toBeUndefined();
  });
});
