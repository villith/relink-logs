import { describe, expect, it } from "vitest";

import ui from "../src-tauri/lang/en/ui.json";
import { LegalityRule } from "./types";
import {
  VIOLATIONS,
  Violation,
  findingsTone,
  toneOfViolations,
  violationLabel,
  violationOf,
  violationTone,
} from "./violations";

const render = (key: string): string => {
  const path = key.replace(/^ui\./, "").split(".");
  const raw = path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], ui.ui);
  return typeof raw === "string" ? raw : `MISSING:${key}`;
};
const t = render as never;

/** Every rule maps somewhere. A `Record` keyed by the closed union, so a rule
 * added in Rust fails `tsc` here until someone says what it is a violation of. */
const EXPECTED: Record<LegalityRule, Violation> = {
  wrightstoneTraitLevel: "impossibleWrightstone",
  wrightstoneTrait: "impossibleWrightstone",
  sigilTraitLevel: "impossibleSigil",
  sigilLockedPair: "impossibleSigil",
  sigilQuestLockedTrait: "impossibleSigil",
  sigilSingleTraitOnly: "impossibleSigil",
  overmasteryValue: "impossibleOvermastery",
  overmasteryAllMaxed: "perfectOvermasteries",
  summonTrait: "impossibleSummon",
  summonBonusSource: "impossibleSummon",
  summonBonusMagnitude: "impossibleSummon",
  summonPerfectCount: "perfectSummons",
  masterTraitCount: "masterTraits",
};

describe("violationOf", () => {
  /** A reader thinks in equipment, not in rules. Four separate sigil rules are
   * one thing to them — "this person's sigil could not exist" — and listing all
   * four spends four chips saying it. */
  it.each(Object.entries(EXPECTED))("files %s under its equipment", (rule, violation) => {
    expect(violationOf(rule as LegalityRule)).toBe(violation);
  });

  it("collapses the four sigil rules into one violation", () => {
    const sigilRules: LegalityRule[] = [
      "sigilTraitLevel",
      "sigilLockedPair",
      "sigilQuestLockedTrait",
      "sigilSingleTraitOnly",
    ];
    expect(new Set(sigilRules.map(violationOf)).size).toBe(1);
  });

  /** Proof and long odds are different claims about the same equipment and must
   * never collapse: "impossible summon" is a mod, "perfect summons" is luck. */
  it("keeps proof and long odds apart on the same equipment", () => {
    expect(violationOf("summonBonusMagnitude")).not.toBe(violationOf("summonPerfectCount"));
    expect(violationOf("overmasteryValue")).not.toBe(violationOf("overmasteryAllMaxed"));
  });
});

describe("violationLabel", () => {
  it.each(VIOLATIONS)("names %s", (violation) => {
    const label = violationLabel(t, violation);
    expect(label).not.toMatch(/^MISSING:/);
    expect(label.trim()).not.toBe("");
  });

  it("names them the way the reader would say them", () => {
    expect(violationLabel(t, "impossibleSigil")).toBe("Impossible Sigil");
    expect(violationLabel(t, "masterTraits")).toBe("Master Traits");
  });

  /** Not "Perfect Summons": that name filed a farmer's luck under cheating,
   * which is the complaint that renamed it. The label is a compliment. */
  it("names perfect summons as luck, not as a cheat", () => {
    expect(violationLabel(t, "perfectSummons")).toBe("Blessed by RNG");
  });
});

describe("violationTone", () => {
  it("reads perfect summons as luck", () => {
    expect(violationTone("perfectSummons")).toBe("lucky");
  });

  /** Everything else stays a cheat read — including perfect overmasteries,
   * whose ladder a few rerolls can walk. */
  it("reads every other violation as cheating", () => {
    for (const violation of VIOLATIONS.filter((v) => v !== "perfectSummons")) {
      expect(violationTone(violation)).toBe("cheat");
    }
  });
});

describe("toneOfViolations", () => {
  it("is lucky only when luck is ALL there is", () => {
    expect(toneOfViolations(["perfectSummons"])).toBe("lucky");
  });

  /** One real breach turns the whole set red: luck does not launder a modded
   * sigil. */
  it("is a cheat as soon as anything else joins", () => {
    expect(toneOfViolations(["impossibleSigil", "perfectSummons"])).toBe("cheat");
  });

  /** An empty set is "not judged", which has no colour — never "clean", and
   * never lucky. */
  it("has no tone for an empty set", () => {
    expect(toneOfViolations([])).toBeUndefined();
  });
});

describe("findingsTone", () => {
  it("reads tone through the rules that computed the findings", () => {
    expect(findingsTone([{ rule: "summonPerfectCount" }])).toBe("lucky");
    expect(findingsTone([{ rule: "summonPerfectCount" }, { rule: "sigilTraitLevel" }])).toBe("cheat");
    expect(findingsTone([])).toBeUndefined();
  });
});

describe("VIOLATIONS", () => {
  /** The order chips appear in, so two players carrying the same violations
   * read as the same shape rather than as two arbitrary orderings. */
  it("lists every violation exactly once", () => {
    expect(new Set(VIOLATIONS).size).toBe(VIOLATIONS.length);
    expect(new Set(Object.values(EXPECTED))).toEqual(new Set(VIOLATIONS));
  });

  it("puts proof before long odds", () => {
    const proof = VIOLATIONS.filter((v) => v.startsWith("impossible"));
    const odds = VIOLATIONS.filter((v) => !v.startsWith("impossible"));
    const lastProof = Math.max(...proof.map((v) => VIOLATIONS.indexOf(v)));
    const firstOdds = Math.min(...odds.map((v) => VIOLATIONS.indexOf(v)));
    expect(lastProof).toBeLessThan(firstOdds);
  });
});
