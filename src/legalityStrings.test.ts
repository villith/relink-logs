/**
 * Renders every rule's strings against the REAL English table.
 *
 * `legality.test.ts` asserts on the values handed to i18next, which is what a
 * key-returning stub allows — and that is exactly how a defect shipped: the
 * `{{subject}}` templates rendered headless on the audit page (which has no
 * item name to give them). An unfilled or missing placeholder is invisible
 * unless the string itself is rendered, so this suite renders it. `ui.legality
 * .limit.<rule>` is now the only namespace a finding resolves, and every member
 * of the `LegalityRule` union is exercised against the real table below.
 */

import { describe, expect, it } from "vitest";

import ui from "../src-tauri/lang/en/ui.json";
import { describeLimit } from "./legality";
import { LegalityFinding, LegalityRule } from "./types";

/** Minimal i18next: resolves a dotted `ui.` key and fills `{{name}}` from the
 * options, leaving an unfilled placeholder visible so a test can catch it. */
const render = (key: string, options: Record<string, unknown> = {}): string => {
  const path = key.replace(/^ui\./, "").split(".");
  const raw = path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], ui.ui);
  if (typeof raw !== "string") return `MISSING:${key}`;
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    options[name] === undefined ? `{{${name}}}` : String(options[name])
  );
};

const t = render as never;

/** One realistic finding per rule. A `Record` keyed by the closed union, so a
 * rule added in Rust fails `tsc` here until someone gives it a fixture. */
const FIXTURES: Record<LegalityRule, LegalityFinding> = {
  wrightstoneTraitLevel: {
    rule: "wrightstoneTraitLevel",
    subject: { kind: "wrightstone" },
    // Per-slot on both sides, the way `audit_wrightstone` actually emits it —
    // that pairing is what lets each trait line quote its own cap.
    observed: { kind: "levels", value: [30, 20, 20] },
    allowed: { kind: "levels", value: [20, 15, 10] },
    odds: null,
  },
  sigilTraitLevel: {
    rule: "sigilTraitLevel",
    subject: { kind: "sigil", index: 7 },
    observed: { kind: "level", value: 15 },
    allowed: { kind: "level", value: 10 },
    odds: null,
  },
  sigilLockedPair: {
    rule: "sigilLockedPair",
    subject: { kind: "sigil", index: 3 },
    observed: { kind: "traitIds", value: [12, 44] },
    allowed: { kind: "traitIds", value: [8, 9] },
    odds: null,
  },
  sigilQuestLockedTrait: {
    rule: "sigilQuestLockedTrait",
    subject: { kind: "sigil", index: 1 },
    observed: { kind: "traitId", value: 55 },
    allowed: { kind: "sigilIds", value: [101, 102] },
    odds: null,
  },
  sigilSingleTraitOnly: {
    rule: "sigilSingleTraitOnly",
    subject: { kind: "sigil", index: 10 },
    observed: { kind: "count", value: 2 },
    allowed: { kind: "count", value: 1 },
    odds: null,
  },
  overmasteryValue: {
    rule: "overmasteryValue",
    subject: { kind: "overmastery", index: 1 },
    observed: { kind: "amount", value: 187 },
    allowed: { kind: "none" },
    odds: null,
  },
  overmasteryAllMaxed: {
    rule: "overmasteryAllMaxed",
    subject: { kind: "overmasteries" },
    observed: { kind: "none" },
    allowed: { kind: "none" },
    odds: 1 / 2600,
  },
  summonTrait: {
    rule: "summonTrait",
    subject: { kind: "summon", index: 0 },
    observed: { kind: "traitId", value: 91 },
    allowed: { kind: "none" },
    odds: null,
  },
  summonBonusSource: {
    rule: "summonBonusSource",
    subject: { kind: "summon", index: 5 },
    observed: { kind: "summonBonusId", value: 3 },
    // The summons that DO grant it — the claim's whole payload, since the gear
    // line shows an effect name two different ids share.
    allowed: { kind: "summonIds", value: [101, 102] },
    odds: null,
  },
  summonBonusMagnitude: {
    rule: "summonBonusMagnitude",
    subject: { kind: "summon", index: 2 },
    observed: { kind: "amount", value: 120 },
    allowed: { kind: "amount", value: 50 },
    odds: null,
  },
  summonPerfectCount: {
    rule: "summonPerfectCount",
    subject: { kind: "summons" },
    observed: { kind: "count", value: 4 },
    allowed: { kind: "none" },
    odds: 1 / 41000,
  },
  masterTraitCount: {
    rule: "masterTraitCount",
    subject: { kind: "masterTraits" },
    observed: { kind: "count", value: 63 },
    allowed: { kind: "count", value: 50 },
    odds: null,
  },
};

const RULES = Object.keys(FIXTURES) as LegalityRule[];

describe.each(RULES)("%s", (rule) => {
  const finding = FIXTURES[rule];

  it("renders a limit with every placeholder filled", () => {
    const limit = describeLimit(t, finding);
    expect(limit).not.toMatch(/^MISSING:/);
    expect(limit).not.toMatch(/\{\{/);
  });
});

/**
 * The rules that still print something beside the gear.
 *
 * Every other rule says it by turning the offending line red — it knows exactly
 * which trait or bonus is wrong, because `observed` carries that id. Prose
 * there restated the colour ("not a pair this sigil rolls") or, worse, landed
 * on a heading where it read as a riddle ("Nazarbonju II  max +12").
 *
 * These five keep text because their claim IS a number, and a number has to be
 * written down: a cap to compare against, or the odds that separate a lucky
 * farmer from a modded build.
 */
const RULES_WITH_TEXT: LegalityRule[] = RULES;

describe("which rules speak", () => {
  /** EVERY rule says what it means, because red alone cannot. A silent red
   * line collapses two different accusations into one mark: "this bonus cannot
   * exist on this summon" and "this bonus is too big" look identical, and a
   * reader has no way to tell which they are looking at. */
  it("prints a limit for every rule", () => {
    for (const rule of RULES) {
      const spoke = describeLimit(t, FIXTURES[rule]).trim() !== "";
      expect(`${rule}: ${spoke}`).toBe(`${rule}: ${RULES_WITH_TEXT.includes(rule)}`);
    }
  });

  /** Short enough to sit at the end of a gear line without wrapping it. The
   * old ones were sentences ("not a pair this sigil rolls") and they read as
   * prose competing with the item rather than annotating it.
   *
   * Exempt are the rules whose claim IS the text rather than an annotation on
   * something the line already shows. The two odds rules state a probability.
   * `summonBonusSource` names the summons that do grant the bonus, and has to:
   * two ids share every effect's display name, so its line reads "Healing Cap
   * Up" whether or not this summon may hold that one — there is nothing on it
   * to annotate, and the short form ("not from this summon") read as false
   * against a summon that grants an effect by that name. */
  const SELF_CONTAINED_RULES: LegalityRule[] = ["overmasteryAllMaxed", "summonPerfectCount", "summonBonusSource"];

  it("keeps the annotations short enough to sit beside the gear", () => {
    for (const rule of RULES.filter((each) => !SELF_CONTAINED_RULES.includes(each))) {
      expect(`${rule}: ${describeLimit(t, FIXTURES[rule])}`.length).toBeLessThan(rule.length + 24);
    }
  });

  /** The two summon-bonus rules are DIFFERENT claims about the same line, so
   * they must not read the same. */
  it("tells the two summon-bonus claims apart", () => {
    expect(describeLimit(t, FIXTURES.summonBonusSource)).not.toBe(describeLimit(t, FIXTURES.summonBonusMagnitude));
  });

  /** A caller that knows the unit hands it in pre-formatted: the rule stores a
   * bare `50`, and "max +50" against a line reading "+75%" is a comparison the
   * reader has to finish themselves. */
  it("takes a pre-formatted allowed value from a caller that knows the unit", () => {
    expect(describeLimit(t, FIXTURES.summonBonusMagnitude, undefined, "+50%")).toBe("max +50%");
  });
});

describe("limit strings", () => {
  /** The audit page lists people across many logs and does not hold their
   * equipment, so nothing can supply a `{{subject}}`. A limit that inlines one
   * renders headless there ("cannot roll this trait."). The gear line above it
   * names the item instead, so no limit string may reference it. */
  it("never inline the subject", () => {
    for (const rule of RULES) {
      expect(`${rule}: ${describeLimit(t, FIXTURES[rule])}`).not.toMatch(/\{\{subject\}\}/);
    }
  });

  /** A suffix, not prose: these sit immediately after a gear line, so a full
   * stop would end a sentence the line never started. */
  it("are fragments, not sentences", () => {
    for (const rule of RULES) {
      expect(`${rule}: ${describeLimit(t, FIXTURES[rule])}`).not.toMatch(/\.$/);
    }
  });

  /** Each wrightstone slot quotes ITS OWN cap. Getting this wrong prints
   * "max 20 / 15 / 10" three times, which reads as three identical claims
   * about three different traits. */
  it("quote one slot's cap when handed a slot", () => {
    expect(describeLimit(t, FIXTURES.wrightstoneTraitLevel, 0)).toBe("max 20");
    expect(describeLimit(t, FIXTURES.wrightstoneTraitLevel, 1)).toBe("max 15");
    expect(describeLimit(t, FIXTURES.wrightstoneTraitLevel, 2)).toBe("max 10");
  });

  /** Severity is gone, so the odds ARE the distinction between a report of
   * long luck and proof the game could not have produced a build. A rule that
   * carries them must say them, as a percentage rather than a "1 in N" the
   * reader has to invert before it means anything. */
  it("quote the odds on the rules that are reports rather than proof", () => {
    expect(describeLimit(t, FIXTURES.overmasteryAllMaxed)).toBe("3 max Stun Power Up rolls — 0.038% chance");
    expect(describeLimit(t, FIXTURES.summonPerfectCount)).toBe("4 perfect summon rolls — 0.0024% chance");
  });

  /** Past a point a percentage is a row of zeroes rather than a quantity, and
   * words carry it better. */
  it("give up on a percentage once it stops meaning anything", () => {
    expect(
      describeLimit(t, {
        ...FIXTURES.summonPerfectCount,
        observed: { kind: "count", value: 3 },
        odds: 1 / 96_281_828_704,
      })
    ).toBe("3 perfect summon rolls — completely impossible");
  });
});
