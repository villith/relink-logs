import { describe, expect, it } from "vitest";

import { classifyNode } from "./gen-skillboard-cap-sources.mjs";

describe("classifyNode", () => {
  it("ignores a node that says nothing about the damage cap", () => {
    expect(classifyNode("ATK +20%")).toBeNull();
    expect(classifyNode("Skill Cooldown -2%")).toBeNull();
  });

  it("reads a flat node as unconditional", () => {
    expect(classifyNode("DMG Cap +35%")).toEqual({ percent: 35, capClass: "all", scope: "always" });
  });

  it("reads the attack class a flat node names", () => {
    expect(classifyNode("Skill DMG Cap +40%")).toEqual({ percent: 40, capClass: "skill", scope: "always" });
  });

  it("reads the per-sigil rule as countable, with its own cap on the count", () => {
    expect(classifyNode("DMG Cap +20% per Basic Stats-type sigil equipped (max sigils: 5)")).toEqual({
      percent: 20,
      capClass: "all",
      scope: "sigil-count",
      maxCount: 5,
    });
  });

  it("reads a move-scoped node as scoped to that move", () => {
    expect(classifyNode("Dead Lands: DMG Cap +45%")).toEqual({
      percent: 45,
      capClass: "all",
      scope: "action",
      label: "Dead Lands",
    });
    expect(classifyNode("Combo Finishers: DMG Cap +35%")).toMatchObject({ scope: "action", label: "Combo Finishers" });
  });

  it("reads a scoped node written without a colon", () => {
    expect(classifyNode("Chain Burst DMG Cap +40%")).toEqual({
      percent: 40,
      capClass: "all",
      scope: "action",
      label: "Chain Burst",
    });
  });

  it("reads a gated node as conditional, keeping the gate text", () => {
    expect(classifyNode("While inflicted with Poison : DMG Cap +100%")).toEqual({
      percent: 100,
      capClass: "all",
      scope: "conditional",
      condition: "While inflicted with Poison",
    });
  });

  it("looks past an awakening-rank prefix to what the node actually does", () => {
    expect(classifyNode("Insight Rank : Damage Skill DMG Cap +20%")).toMatchObject({ percent: 20, scope: "action" });
  });

  it("refuses a node whose magnitude is an unresolved placeholder", () => {
    // `{10}` is a table reference the text never resolved; guessing it would
    // put a number on screen the game never quoted.
    expect(classifyNode("Power Raise: DMG Cap +{10}% / Charge Time +10%")).toEqual({ scope: "unparsed" });
  });

  it("refuses a node carrying more than one cap magnitude", () => {
    const text =
      "Boosts DMG Cap based on Triple Shroud marks. 1 Shroud mark: DMG Cap +3% 2 Shroud marks: DMG Cap +5% 3 Shroud marks: DMG Cap +10%";
    expect(classifyNode(text)).toEqual({ scope: "unparsed" });
  });

  it("refuses prose it cannot reduce to one magnitude and one scope", () => {
    const text = "Coffinmaker gains a max of ATK +30% and DMG Cap +100% based on Heat gauge level, but the Heat gauge fills 20% slower.";
    expect(classifyNode(text)).toEqual({ scope: "unparsed" });
  });
});
