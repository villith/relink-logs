import { afterEach, describe, expect, it } from "vitest";

import shippedCoverage from "@/assets/attack-group-coverage.json";
import { setSkillNameSources } from "@/skillNameSources";
import type { Sigil } from "@/types";

import type { CapLoadout } from "../capSources";
import { setAttackGroupCoverage } from "./attackGroups";
import { boardFactors } from "./board";

/**
 * Node ids are the low half of the shipped `pl####_####` keys. These are real
 * Captain (pl0000) nodes, picked one per scope, so the fixtures exercise the
 * data that actually ships rather than an invented shape.
 */
/** `DMG Cap +20%`, unconditional. */
const ALWAYS = 0x000c;
/** +45%, scoped to attack group 4 — a per-character group, so no class claimed. */
const ATTACK_GROUP = 0x0016;
/** +45% skill-class, scoped to one named ability (`6fd0843a`) in group 10. */
const ABILITY_SCOPED = 0x0033;
/** +100% while status 1000 (Poison) is on the attacker. */
const STATUS_GATED = 0x001b;
/** +20% per Basic Stats sigil, ceiling 5. */
const SIGIL_COUNTED = 0x0023;
/** Grants the cap-up status (56) for 30s rather than applying directly. */
const GRANTS_STATUS = 0x00e7;
/** Chain Burst cap — real, but not one of the three hit classes. */
const CHAIN_BURST = 0x00ec;
/** An engine-defined keystone: the table holds values, the exe holds meaning. */
const ENGINE_DEFINED = 0x0002;
/** "Skill Cooldown -2%" — a node that touches no cap at all. */
const NOT_A_CAP_NODE = 0x000b;

/** ATK — a Basic Stats-type trait, which is what the per-sigil node counts. */
const basicStatsSigil = (): Sigil => ({
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

/** The single factor produced for `nodeId`, evaluated under `conditions`. */
const factorFor = (nodeId: number, capClass: "normal" | "skill" | "sba" = "normal", over: Partial<CapLoadout> = {}) =>
  boardFactors(loadout({ skillboard: [nodeId], ...over }), capClass)[0];

describe("boardFactors", () => {
  it("produces nothing for a log that never captured the board", () => {
    expect(boardFactors(loadout({ skillboard: [] }), "normal")).toEqual([]);
    expect(boardFactors(loadout({ skillboard: undefined }), "normal")).toEqual([]);
  });

  it("ignores an unlocked node that grants no damage cap", () => {
    expect(boardFactors(loadout({ skillboard: [NOT_A_CAP_NODE] }), "normal")).toEqual([]);
  });

  it("ignores the Chain Burst cap, which is not one of the three hit classes", () => {
    expect(boardFactors(loadout({ skillboard: [CHAIN_BURST] }), "normal")).toEqual([]);
  });
});

describe("unconditional board nodes", () => {
  it("applies at its own percent with no params", () => {
    const factor = factorFor(ALWAYS);
    expect(factor.params).toEqual([]);
    expect(factor.evaluate({})).toMatchObject({ percent: 20, state: "active" });
  });
});

describe("attack-scoped board nodes", () => {
  it("asks for the hit's action id", () => {
    const factor = factorFor(ATTACK_GROUP);
    expect(factor.params).toEqual(["actionId"]);
    expect(factor.evaluate({})).toMatchObject({ potential: 45, state: "unknown", missing: ["actionId"] });
  });

  it("stays unresolved for a group whose membership is underived", () => {
    // Group 4 carries no ability ids, so an action id can only settle it
    // through a derived membership. The SHIPPED registry now carries one for
    // this group (the button map derived it), so an explicitly-empty registry
    // pins down what this test is about: underived stays unknown.
    setAttackGroupCoverage({});
    expect(factorFor(ATTACK_GROUP).evaluate({ actionId: 123 })).toMatchObject({
      state: "unknown",
      reason: "no-action-mapping",
    });
  });

  it("never claims a node did NOT apply just because the ids do not compare", () => {
    // The table's ability ids are xxhash32 of ability.tbl keys; a hit's
    // ActionType is a small per-character integer ({ Normal: 200 }). The
    // skill-name-sources bridge connects the two — but for an action it does
    // not cover (a normal attack, a patch-added move), "no match" as
    // `inactive` would be a confident, wrong claim that the node contributed
    // nothing. Unresolved is the truthful answer for an unbridged action.
    const factor = boardFactors(loadout({ skillboard: [ABILITY_SCOPED] }), "skill")[0];
    const result = factor.evaluate({ actionId: 200 });
    expect(result.state).not.toBe("inactive");
    expect(result).toMatchObject({ state: "unknown", reason: "no-action-mapping", potential: 45 });
  });
});

afterEach(() => setAttackGroupCoverage(shippedCoverage.characters as Parameters<typeof setAttackGroupCoverage>[0]));

describe("ability-scoped nodes with a bridged action id", () => {
  afterEach(() => setSkillNameSources({}));

  /** The real Captain node 0x0033 targets ability `6fd0843a`; give the bridge
   * one action that IS that ability and one that is a different one. */
  const bridge = () =>
    setSkillNameSources({
      Pl0000: {
        "2600": { ns: "abilities", hash: "6fd0843a", key: "AB_PL0000_05" },
        "2700": { ns: "abilities", hash: "aaaaaaaa", key: "AB_PL0000_06" },
      },
    });

  it("applies when the hit's action resolves to an ability the node names", () => {
    bridge();
    const factor = boardFactors(loadout({ skillboard: [ABILITY_SCOPED] }), "skill")[0];
    expect(factor.evaluate({ actionId: 2600 })).toMatchObject({ percent: 45, state: "active" });
  });

  it("does not apply when the hit resolves to a DIFFERENT ability", () => {
    // The bridge covers this action and it is genuinely another move —
    // `inactive` is now a claim the data supports, not a failed comparison.
    bridge();
    const factor = boardFactors(loadout({ skillboard: [ABILITY_SCOPED] }), "skill")[0];
    expect(factor.evaluate({ actionId: 2700 })).toMatchObject({ percent: 0, state: "inactive" });
  });

  it("stays unresolved for an action the bridge does not cover", () => {
    bridge();
    const factor = boardFactors(loadout({ skillboard: [ABILITY_SCOPED] }), "skill")[0];
    expect(factor.evaluate({ actionId: 120 })).toMatchObject({ state: "unknown", reason: "no-action-mapping" });
  });

  it("resolves a group-scoped node through a derived group membership", () => {
    // The Captain node 0x0016 is scoped to attack group 4 with no ability ids.
    // Once the coverage registry carries an empirically derived membership for
    // that group, an action id settles the row both ways.
    setAttackGroupCoverage({
      pl0000: {
        status: "partial",
        neededGroups: [1],
        groups: { "4": { actionIds: [210, 220, 230], evidence: "test" } },
      },
    });
    const factor = factorFor(ATTACK_GROUP);
    expect(factor.evaluate({ actionId: 220 })).toMatchObject({ percent: 45, state: "active" });
    expect(factor.evaluate({ actionId: 100 })).toMatchObject({ percent: 0, state: "inactive" });
  });

  it("stays unresolved for a group the registry has not derived", () => {
    setAttackGroupCoverage({
      pl0000: { status: "partial", neededGroups: [4], groups: { "1": { actionIds: [999], evidence: "test" } } },
    });
    expect(factorFor(ATTACK_GROUP).evaluate({ actionId: 220 })).toMatchObject({
      state: "unknown",
      reason: "no-action-mapping",
    });
  });

  it("resolves Eustace's Heaven Comes Down node against the SHIPPED bridge", async () => {
    // End to end through the real assets: node pl2700_0097 names ability
    // aea6d151, and the shipped skill-name-sources maps Eustace action 1700 to
    // exactly that hash — the row that motivated the bridge (log 2559).
    const shipped = await import("../../../../../../src-tauri/assets/skill-name-sources.json");
    setSkillNameSources(shipped.default as Parameters<typeof setSkillNameSources>[0]);
    const factor = boardFactors(loadout({ characterType: "Pl2700", skillboard: [0x0097] }), "skill")[0];
    expect(factor.evaluate({ actionId: 1700 })).toMatchObject({ percent: 45, state: "active" });
    expect(factor.evaluate({ actionId: 1100 })).toMatchObject({ percent: 0, state: "inactive" });
  });
});

describe("status-gated board nodes", () => {
  it("asks for the attacker's active statuses", () => {
    const factor = factorFor(STATUS_GATED);
    expect(factor.params).toEqual(["buffs"]);
    expect(factor.evaluate({})).toMatchObject({ potential: 100, state: "unknown", missing: ["buffs"] });
  });

  it("applies when the gating status is active", () => {
    // The gate is a numeric status id off the game's own table, so an active
    // buff list settles it outright — no prose matching anywhere.
    expect(factorFor(STATUS_GATED).evaluate({ buffs: [1000] })).toMatchObject({ percent: 100, state: "active" });
  });

  it("does not apply when the gating status is absent", () => {
    expect(factorFor(STATUS_GATED).evaluate({ buffs: [1, 2] })).toMatchObject({ percent: 0, state: "inactive" });
  });
});

describe("counted board nodes", () => {
  it("counts the Basic Stats sigils equipped, up to the game's own ceiling", () => {
    const withSigils = (count: number) =>
      factorFor(SIGIL_COUNTED, "normal", { sigils: Array.from({ length: count }, basicStatsSigil) }).evaluate({});

    expect(withSigils(3)).toMatchObject({ percent: 60, state: "active" });
    expect(withSigils(6)).toMatchObject({ percent: 100, state: "active" });
    expect(withSigils(0)).toMatchObject({ percent: 0, state: "inactive" });
  });
});

describe("board nodes this model cannot settle", () => {
  it("reports a status-granting node as unresolved rather than applying it directly", () => {
    // The node grants a cap-up buff; whether that buff was up at this hit is a
    // different question from whether the node is unlocked.
    expect(factorFor(GRANTS_STATUS).evaluate({})).toMatchObject({ state: "unknown", potential: 10 });
  });

  it("keeps an engine-defined node visible with no magnitude", () => {
    // Its values are in the table but which slot is the cap lives in the exe.
    // Dropping it would let the breakdown read as complete while missing it.
    const factor = factorFor(ENGINE_DEFINED);
    expect(factor.evaluate({})).toMatchObject({ percent: 0, potential: 0, state: "unknown", reason: "unparsed" });
  });
});

describe("attack class", () => {
  it("applies an all-class node to every class", () => {
    for (const capClass of ["normal", "skill", "sba"] as const) {
      expect(factorFor(ALWAYS, capClass).evaluate({})).toMatchObject({ percent: 20, state: "active" });
    }
  });
});
