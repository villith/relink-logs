import { describe, expect, it } from "vitest";

import { describeFinding, findingsForSubject, severityColor, worstSeverity } from "./legality";
import { LegalityFinding } from "./types";

const finding = (over: Partial<LegalityFinding> = {}): LegalityFinding => ({
  rule: "summonBonusMagnitude",
  severity: "impossible",
  subject: { kind: "summon", index: 0 },
  observed: { kind: "amount", value: 75 },
  allowed: { kind: "amount", value: 50 },
  odds: null,
  ...over,
});

const impossible = finding();
const improbable = finding({
  rule: "summonPerfectCount",
  severity: "improbable",
  subject: { kind: "summons" },
  observed: { kind: "count", value: 3 },
  allowed: { kind: "none" },
  odds: 4.7e-7,
});

/** The tooltips are translated, and the test i18n stub returns the key. Assert
 * on the interpolation values instead, which is where the claim actually
 * lives — a wrong number in a public accusation is the failure that matters. */
describe("worstSeverity", () => {
  it("ranks impossible above improbable whatever the order", () => {
    expect(worstSeverity([improbable, impossible])).toBe("impossible");
    expect(worstSeverity([impossible, improbable])).toBe("impossible");
  });

  it("reports improbable when that is all there is", () => {
    expect(worstSeverity([improbable])).toBe("improbable");
  });

  it("reports nothing for a clean player", () => {
    expect(worstSeverity([])).toBeNull();
  });
});

describe("severityColor", () => {
  it("keeps proof and suspicion visually distinct", () => {
    expect(severityColor("impossible")).toBe("red");
    expect(severityColor("improbable")).toBe("yellow");
  });

  it("has no colour for a clean player", () => {
    expect(severityColor(null)).toBeUndefined();
  });
});

describe("findingsForSubject", () => {
  const sigil = finding({ rule: "sigilTraitLevel", subject: { kind: "sigil", index: 3 } });
  const summonThree = finding({ subject: { kind: "summon", index: 3 } });
  const summonZero = finding({ subject: { kind: "summon", index: 0 } });

  it("matches on kind AND index, so a sigil never colours a summon", () => {
    expect(findingsForSubject([sigil, summonThree, summonZero], "summon", 3)).toEqual([summonThree]);
  });

  it("matches whole-set subjects, which carry no index", () => {
    expect(findingsForSubject([improbable, summonZero], "summons")).toEqual([improbable]);
  });

  it("returns nothing when a subject is clean", () => {
    expect(findingsForSubject([sigil], "summon", 3)).toEqual([]);
  });

  it("never matches an indexed subject against a missing index", () => {
    expect(findingsForSubject([summonZero], "summon")).toEqual([]);
  });
});

describe("describeFinding", () => {
  /** The i18n stub returns `key`, so capture the interpolation instead. */
  const capture = () => {
    const calls: Record<string, unknown>[] = [];
    const t = ((key: string, options?: Record<string, unknown>) => {
      calls.push({ key, ...options });
      return key;
    }) as never;
    return { calls, t };
  };

  it("states the magnitude claim with both numbers", () => {
    const { calls, t } = capture();
    describeFinding(t, impossible, "Behemoth III");

    expect(calls[0]).toMatchObject({
      key: "ui.legality.explain.summonBonusMagnitude",
      subject: "Behemoth III",
      observed: 75,
      allowed: 50,
    });
  });

  it("states the perfect-summon report as odds, not as an accusation", () => {
    const { calls, t } = capture();
    describeFinding(t, improbable, "");

    expect(calls[0]).toMatchObject({
      key: "ui.legality.explain.summonPerfectCount",
      observed: 3,
    });
    // 1 in N, the form a reader can judge — not a bare probability.
    expect(calls[0].denominator).toBe(Math.round(1 / 4.7e-7).toLocaleString());
  });

  it("omits the denominator when a finding carries no odds", () => {
    const { calls, t } = capture();
    describeFinding(t, impossible, "Behemoth III");
    expect(calls[0].denominator).toBeUndefined();
  });

  it("falls back to the rule's own key rather than rendering nothing", () => {
    const { calls, t } = capture();
    describeFinding(t, finding({ rule: "masterTraitCount", subject: { kind: "masterTraits" } }), "");
    expect(calls[0].key).toBe("ui.legality.explain.masterTraitCount");
  });
});
