import { describe, expect, it, vi } from "vitest";

import { describeLimit, findingsForSubject } from "./legality";
import { LegalityFinding } from "./types";

// i18next is not initialised under vitest, so the id-to-name lookup is stubbed:
// what these tests are about is which names are composed and in what order, not
// the translation itself. `legalityStrings.test.ts` renders the real strings.
vi.mock("./utils", async (original) => ({
  ...(await original<typeof import("./utils")>()),
  translateSummonId: (id: number) => ({ 1: "Rolan", 2: "Lucilius", 3: "Beelzebub", 4: "Lilith" })[id] ?? `#${id}`,
}));

const finding = (over: Partial<LegalityFinding> = {}): LegalityFinding => ({
  rule: "summonBonusMagnitude",
  subject: { kind: "summon", index: 0 },
  observed: { kind: "amount", value: 75 },
  allowed: { kind: "amount", value: 50 },
  odds: null,
  ...over,
});

/** A hard table breach: no odds, because that is the point of one. */
const breach = finding();
/** A long-odds report. With severity gone, `odds` is the ONLY thing telling a
 * reader this is luck rather than proof. */
const longOdds = finding({
  rule: "summonPerfectCount",
  subject: { kind: "summons" },
  observed: { kind: "count", value: 3 },
  allowed: { kind: "none" },
  odds: 4.7e-7,
});

describe("findingsForSubject", () => {
  const sigil = finding({ rule: "sigilTraitLevel", subject: { kind: "sigil", index: 3 } });
  const summonThree = finding({ subject: { kind: "summon", index: 3 } });
  const summonZero = finding({ subject: { kind: "summon", index: 0 } });

  it("matches on kind AND index, so a sigil never colours a summon", () => {
    expect(findingsForSubject([sigil, summonThree, summonZero], "summon", 3)).toEqual([summonThree]);
  });

  it("matches whole-set subjects, which carry no index", () => {
    expect(findingsForSubject([longOdds, summonZero], "summons")).toEqual([longOdds]);
  });

  it("returns nothing when a subject is clean", () => {
    expect(findingsForSubject([sigil], "summon", 3)).toEqual([]);
  });

  it("never matches an indexed subject against a missing index", () => {
    expect(findingsForSubject([summonZero], "summon")).toEqual([]);
  });
});

describe("describeLimit", () => {
  /** The i18n stub returns `key`, so capture the interpolation instead.
   * `legalityStrings.test.ts` renders the real strings; this pins what reaches
   * them. */
  const capture = () => {
    const calls: Record<string, unknown>[] = [];
    const t = ((key: string, options?: Record<string, unknown>) => {
      calls.push({ key, ...options });
      return key;
    }) as never;
    return { calls, t };
  };

  /**
   * A bonus-source claim is about an ID, and ids are invisible on a gear line:
   * two of them share every effect's display name, so a Behemoth III caught
   * with the boss set's Healing Cap Up renders a line reading "Healing Cap Up"
   * — a bonus Behemoth III genuinely grants. The old "not from this summon"
   * therefore contradicted its own evidence. Naming the owners is what makes
   * the claim checkable, so those names have to reach the string.
   */
  it("names the summons that do grant a foreign bonus, alphabetically", () => {
    const { calls, t } = capture();
    describeLimit(
      t,
      finding({
        rule: "summonBonusSource",
        observed: { kind: "summonBonusId", value: 99 },
        allowed: { kind: "summonIds", value: [1, 2, 3, 4] },
      })
    );

    expect(calls[0]).toMatchObject({
      key: "ui.legality.limit.summonBonusSource",
      allowed: "Beelzebub, Lilith, Lucilius, Rolan",
    });
  });

  /** A bonus no summon is known to grant has nobody to name — a modded id, or
   * one granted too widely to list. The claim then has to stand on its own
   * rather than trail an empty "only". */
  it("falls back to the bare claim when there is nobody to name", () => {
    const { calls, t } = capture();
    describeLimit(
      t,
      finding({
        rule: "summonBonusSource",
        observed: { kind: "summonBonusId", value: 99 },
        allowed: { kind: "summonIds", value: [] },
      })
    );

    expect(calls[0]).toMatchObject({ key: "ui.legality.limit.summonBonusSource-unnamed" });
  });

  it("hands the magnitude claim both numbers", () => {
    const { calls, t } = capture();
    describeLimit(t, breach);

    expect(calls[0]).toMatchObject({
      key: "ui.legality.limit.summonBonusMagnitude",
      observed: 75,
      allowed: 50,
    });
  });

  /** Without a slot the list stays whole, for a claim about the levels
   * together. */
  it("renders a list of levels as one comparable figure", () => {
    const { calls, t } = capture();
    describeLimit(t, finding({ rule: "wrightstoneTraitLevel", observed: { kind: "levels", value: [12, 9, 5] } }));
    expect(calls[0].observed).toBe("12 / 9 / 5");
  });

  /** The reason `slot` exists: a wrightstone line reading "Stun Power (Lvl. 30)"
   * must be followed by ITS cap, not by all three. */
  it("picks one slot's cap out of a per-slot list", () => {
    const { calls, t } = capture();
    describeLimit(
      t,
      finding({
        rule: "wrightstoneTraitLevel",
        observed: { kind: "levels", value: [30, 20, 20] },
        allowed: { kind: "levels", value: [20, 15, 10] },
      }),
      1
    );

    expect(calls[0]).toMatchObject({ observed: 20, allowed: 15 });
  });

  /** Ids name a thing rather than measure one; those rules phrase their limit
   * without a number, so passing an id as one would render nonsense. */
  it("hands no figure for an id-valued finding", () => {
    const { calls, t } = capture();
    describeLimit(t, finding({ rule: "summonTrait", observed: { kind: "traitId", value: 91 } }));
    expect(calls[0].observed).toBeUndefined();
  });

  /** The odds-carrying rules quote them inside their own limit line, so the
   * chance has to reach the template. Found by key rather than by position:
   * building the chance is itself a translation, so it lands first. */
  it("hands the chance to a rule that quotes it", () => {
    const { calls, t } = capture();
    describeLimit(t, longOdds);

    const limit = calls.find((call) => call.key === "ui.legality.limit.summonPerfectCount");
    expect(limit?.chance).toBe("ui.legality.chance-percent");
    expect(calls.find((call) => call.key === "ui.legality.chance-percent")?.percent).toBe("0.000047");
  });

  /** Below a point a percentage is a row of zeroes rather than a quantity, and
   * words carry it better. */
  it("stops quoting a percentage once it has stopped meaning anything", () => {
    const { calls, t } = capture();
    describeLimit(t, { ...longOdds, odds: 1 / 96_281_828_704 });

    expect(calls.some((call) => call.key === "ui.legality.chance-impossible")).toBe(true);
    expect(calls.some((call) => call.key === "ui.legality.chance-percent")).toBe(false);
  });

  it("falls back to the rule's own key rather than rendering nothing", () => {
    const { calls, t } = capture();
    describeLimit(t, finding({ rule: "masterTraitCount", subject: { kind: "masterTraits" } }));
    expect(calls[0].key).toBe("ui.legality.limit.masterTraitCount");
  });
});
