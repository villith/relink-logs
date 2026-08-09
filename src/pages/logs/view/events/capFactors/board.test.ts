import { describe, expect, it } from "vitest";

import boardSources from "@/assets/skillboard-cap-sources.json";
import type { Sigil } from "@/types";

import type { CapLoadout } from "../capSources";
import { boardFactors } from "./board";

const nodes = boardSources.nodes as Record<string, { scope: string; capClass: string; percent: number }>;

/** The first node of `scope` on Captain's board (`pl0000_…`), so the fixtures
 * describe real shipped data rather than invented ids. */
const nodeOf = (scope: string, capClass = "all"): { id: number; percent: number } => {
  const found = Object.entries(nodes).find(
    ([key, value]) => key.startsWith("pl0000_") && value.scope === scope && value.capClass === capClass
  );
  if (found === undefined) throw new Error(`no ${scope}/${capClass} node on pl0000`);
  return { id: parseInt(found[0].slice("pl0000_".length), 16), percent: found[1].percent };
};

const UNPARSED_ID = parseInt(
  (Object.keys(boardSources.unparsed).find((key) => key.startsWith("pl0000_")) ?? "pl0000_0000").slice(7),
  16
);

const basicStatsSigil = (): Sigil => ({
  // ATK — a Basic Stats-type trait, which is what the per-sigil node counts.
  firstTraitId: 0x50079a1c,
  firstTraitLevel: 1,
  secondTraitId: 0,
  secondTraitLevel: 0,
  sigilId: 1,
  equippedCharacter: 0,
  sigilLevel: 1,
  acquisitionCount: 0,
  notificationEnum: 0,
});

const loadout = (over: Partial<CapLoadout> = {}): CapLoadout => ({
  sigils: [],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
  characterType: "Pl0000",
  skillboard: [],
  ...over,
});

describe("boardFactors", () => {
  it("produces nothing for a log that never captured the board", () => {
    expect(boardFactors(loadout({ skillboard: [] }), "normal")).toEqual([]);
    expect(boardFactors(loadout({ skillboard: undefined }), "normal")).toEqual([]);
  });

  it("only values nodes the player actually unlocked", () => {
    const node = nodeOf("always");
    expect(boardFactors(loadout({ skillboard: [node.id] }), "normal")).toHaveLength(1);
    // A board full of nodes, none of them unlocked, contributes nothing.
    expect(boardFactors(loadout({ skillboard: [] }), "normal")).toHaveLength(0);
  });

  it("applies a flat node at its own percent, with no params", () => {
    const node = nodeOf("always");
    const [factor] = boardFactors(loadout({ skillboard: [node.id] }), "normal");
    expect(factor.params).toEqual([]);
    expect(factor.evaluate({})).toMatchObject({ percent: node.percent, state: "active" });
  });

  it("rejects a node that raises a different attack class", () => {
    const node = nodeOf("always", "skill");
    const [factor] = boardFactors(loadout({ skillboard: [node.id] }), "normal");
    expect(factor.evaluate({})).toMatchObject({ state: "not-applicable", reason: "other-class" });
  });

  it("counts the Basic Stats sigils actually equipped, up to the game's own cap", () => {
    const node = nodeOf("sigil-count");
    const withSigils = (count: number) =>
      boardFactors(
        loadout({ skillboard: [node.id], sigils: Array.from({ length: count }, basicStatsSigil) }),
        "normal"
      )[0].evaluate({});

    expect(withSigils(3)).toMatchObject({ percent: node.percent * 3, state: "active" });
    // "max sigils: 5" is the game's own ceiling; a sixth adds nothing.
    expect(withSigils(6)).toMatchObject({ percent: node.percent * 5, state: "active" });
    expect(withSigils(0)).toMatchObject({ percent: 0, state: "inactive" });
  });

  it("leaves a move-scoped node unresolved, naming the hit's action as what it needs", () => {
    const node = nodeOf("action");
    const [factor] = boardFactors(loadout({ skillboard: [node.id] }), "normal");
    expect(factor.params).toEqual(["actionId"]);
    expect(factor.evaluate({})).toMatchObject({
      percent: 0,
      potential: node.percent,
      state: "unknown",
      missing: ["actionId"],
    });
  });

  it("keeps an unparsed node visible with no magnitude, rather than dropping it", () => {
    // A dropped node is silent under-counting: the breakdown would read as
    // complete while quietly missing a source.
    const [factor] = boardFactors(loadout({ skillboard: [UNPARSED_ID] }), "normal");
    expect(factor.evaluate({})).toMatchObject({ percent: 0, potential: 0, state: "unknown", reason: "unparsed" });
  });

  it("ignores an unlocked node that grants no damage cap at all", () => {
    // 0x000b is Captain's "Skill Cooldown -2%".
    expect(boardFactors(loadout({ skillboard: [0x000b] }), "normal")).toEqual([]);
  });
});
