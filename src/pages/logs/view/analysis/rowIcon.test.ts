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

  it("resolves a GROUPED action addressed by its raw action key", () => {
    // Percival's Zerreissen (Empowered), action 40, folds into the `zerreissen`
    // group — so its ROW key is the group's. The hover card's ability fold
    // keys by the raw action deliberately (`foldPartyDealt`), and matching row
    // keys alone left every grouped action in that card text-only beside a
    // table showing its art.
    const skill = { actionType: { Normal: 40 }, childCharacterType: "Pl1000" };
    const percival = player("Pl1000", [skill]);

    expect(abilityRowKey(skill)).not.toBe("Normal:40");
    expect(abilityRowIconUrl("Normal:40", [percival])).toMatch(/pl1000_04\.png/);
  });

  it("inherits the group's art for a member action that has none of its own", () => {
    // Id's dragonform Reginleiv Recidive Combo (1010) is a follow-up the game
    // gives no ability art; it continues 1000, which has it, and the two are
    // one row. The group is the parent to inherit from.
    const id = player("Pl1900", [{ actionType: { Normal: 1010 }, childCharacterType: "Pl2000" }]);

    expect(abilityRowIconUrl("Normal:1010", [id])).toMatch(/pl2000_01\.png/);
  });

  it("inherits from the group TABLE, not just the actions the player used", () => {
    // The sibling that carries the art may not appear in this breakdown at all
    // — a fight where only the follow-up landed. The group's membership is a
    // static fact, so the inheritance must not depend on what was used.
    const id = player("Pl1900", [
      { actionType: { Normal: 1010 }, childCharacterType: "Pl2000" },
      { actionType: { Normal: 1100 }, childCharacterType: "Pl2000" },
    ]);

    expect(abilityRowIconUrl("Normal:1010", [id])).toMatch(/pl2000_01\.png/);
  });

  it("stays undefined for a group whose members have no art at all", () => {
    // Percival's Schlacht is a charged attack, not an ability — neither member
    // of the group has a diamond, so there is nothing to inherit and a blank
    // box would be worse than no box.
    const percival = player("Pl1000", [{ actionType: { Normal: 200 }, childCharacterType: "Pl1000" }]);

    expect(abilityRowIconUrl("Normal:200", [percival])).toBeUndefined();
  });
});
