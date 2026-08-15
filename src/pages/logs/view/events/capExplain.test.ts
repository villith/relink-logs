import { describe, expect, it } from "vitest";

import type { Sigil } from "@/types";

import { explainCapHit, type ExplainInput, type ExplainLine, type ExplainSection } from "./capExplain";
import type { CapLoadout } from "./capSources";

const DMG_CAP_TRAIT = 0xdc584f60;
const FATEBREAKER_TRAIT = 0xd029fe08;
const OM_NORMAL = 0x06595c52;
const SUMMON_BONUS_NORMAL = 0x9245dfa4;

const sigil = (traitId: number, level: number): Sigil => ({
  firstTraitId: traitId,
  firstTraitLevel: level,
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
  ...over,
});

/** A normal-attack hit by Pl0300 at a rate the shipped ladder brackets. */
const input = (over: Partial<ExplainInput> = {}): ExplainInput => ({
  hit: {
    damage: 152_737,
    damage_cap: 152_737,
    base_damage: 400_000,
    attack_rate: 0.54,
    class_flags: 0x1,
    flags: 0,
    instance_snapshot: null,
    record_snapshot: null,
  },
  characterType: "Pl0300",
  ...over,
});

const section = (sections: ExplainSection[], key: string): ExplainSection => {
  const found = sections.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no "${key}" section in [${sections.map((s) => s.key).join(", ")}]`);
  return found;
};

const line = (sections: ExplainSection[], sectionKey: string, lineKey: string): ExplainLine => {
  const lines = section(sections, sectionKey).lines;
  const found = lines.find((entry) => entry.key === lineKey);
  if (found === undefined) throw new Error(`no "${lineKey}" line in [${lines.map((l) => l.key).join(", ")}]`);
  return found;
};

describe("explainCapHit sections", () => {
  it("lays the derivation out in the order the game computes it", () => {
    expect(explainCapHit(input()).map((entry) => entry.key)).toEqual(["class", "base", "capup", "clamp", "postcap"]);
  });
});

describe("the class section", () => {
  it("decodes every class bit the builder tests, including the absent ones", () => {
    const sections = explainCapHit(input({ hit: { ...input().hit, class_flags: 0x50010 } }));
    expect(line(sections, "class", "flags").value).toEqual({ kind: "hex", value: 0x50010 });
    expect(line(sections, "class", "bit-summon").value).toEqual({ kind: "verdict", value: false });
    expect(line(sections, "class", "bit-arts").value).toEqual({ kind: "verdict", value: true });
    expect(line(sections, "class", "bit-skill").value).toEqual({ kind: "verdict", value: true });
    // Both set: the builder's arts branch jumps past the skill assignment.
    expect(line(sections, "class", "resolved").value).toEqual({ kind: "text", value: "sba" });
  });

  it("resolves a bare hit to the normal class", () => {
    expect(line(explainCapHit(input()), "class", "resolved").value).toEqual({ kind: "text", value: "normal" });
  });

  it("says the class was never captured rather than guessing normal", () => {
    const sections = explainCapHit(input({ hit: { ...input().hit, class_flags: null } }));
    expect(section(sections, "class").unavailableKey).not.toBeNull();
    expect(line(sections, "class", "resolved").value).toEqual({ kind: "absent" });
  });
});

describe("the base cap section", () => {
  it("names the map and key the curve was looked up by", () => {
    const sections = explainCapHit(input());
    expect(line(sections, "base", "map").value).toEqual({ kind: "text", value: "normal" });
    // Pl0300's hash, which is what the shipped ladder maps are keyed by.
    expect(line(sections, "base", "curve-key").value).toEqual({ kind: "text", value: "079df0cc" });
  });

  it("routes a summon hit to the shared SO0000 curve regardless of class", () => {
    const sections = explainCapHit(input({ hit: { ...input().hit, class_flags: 0x80 | 0x40000 } }));
    expect(line(sections, "base", "map").value).toEqual({ kind: "text", value: "normal" });
    expect(line(sections, "base", "curve-key").value).toEqual({ kind: "text", value: "58f4dbd4" });
  });

  it("shows the bracketing rows and the substituted lerp it ran", () => {
    const sections = explainCapHit(input());
    expect(line(sections, "base", "branch").value).toEqual({ kind: "text", value: "lerp" });
    expect(line(sections, "base", "lo").value).toEqual({ kind: "text", value: "#5 (0.5, 4999)" });
    expect(line(sections, "base", "hi").value).toEqual({ kind: "text", value: "#6 (0.6, 5999)" });
    expect(section(sections, "base").substituted).toBe("trunc( 4999 + (5999 - 4999) x (0.54 - 0.5) / (0.6 - 0.5) )");
    expect(line(sections, "base", "result").value).toEqual({ kind: "count", value: 5399 });
  });

  it("keeps the pre-truncation value at full precision", () => {
    // The fraction the trunc drops is the whole reason this walk is done in
    // f32, so the panel must not round it away.
    const sections = explainCapHit(input({ hit: { ...input().hit, attack_rate: 0.5555 } }));
    expect(line(sections, "base", "lerped").value).toEqual({ kind: "float", value: Math.fround(5553.9995117188) });
    expect(line(sections, "base", "result").value).toEqual({ kind: "count", value: 5553 });
  });

  it("says WHICH fact was missing when no curve could be chosen", () => {
    expect(section(explainCapHit(input({ characterType: undefined })), "base").unavailableKey).toBe(
      "ui.debug.cap-no-character"
    );
    expect(section(explainCapHit(input({ characterType: "Pl9999" })), "base").unavailableKey).toBe(
      "ui.debug.cap-no-curve"
    );
    const noRate = input({ hit: { ...input().hit, attack_rate: null } });
    expect(section(explainCapHit(noRate), "base").unavailableKey).toBe("ui.debug.cap-no-rate");
  });
});

describe("the cap-up section", () => {
  it("divides the game's own cap by the independent base", () => {
    const sections = explainCapHit(input());
    // 152737 / 5399 - 1 = +2728.99%
    expect(line(sections, "capup", "game").value).toEqual({ kind: "percent", value: 2728.99 });
    expect(section(sections, "capup").substituted).toBe("152737 / 5399 - 1");
  });

  it("shows the integer-percent grid check with the numbers it used", () => {
    const sections = explainCapHit(input());
    expect(line(sections, "capup", "grid-k").value).toEqual({ kind: "count", value: 2829 });
    expect(line(sections, "capup", "grid-predicted").value).toEqual({ kind: "float", value: 152737.71 });
    expect(line(sections, "capup", "grid-verdict").value).toEqual({ kind: "verdict", value: true });
  });

  it("flags a cap the formula cannot have produced from this base", () => {
    const off = input({ hit: { ...input().hit, damage_cap: 46_773 } });
    expect(line(explainCapHit(off), "capup", "grid-verdict").value).toEqual({ kind: "verdict", value: false });
  });

  it("itemizes the record into every contributor it considered", () => {
    const sections = explainCapHit(
      input({
        capUp: { normal: 13.13, skill: null, sba: null },
        loadout: loadout({
          sigils: [sigil(FATEBREAKER_TRAIT, 15), sigil(DMG_CAP_TRAIT, 63)],
          summons: [{ summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 }],
          overmasteryInfo: { overmasteries: [{ id: OM_NORMAL, flags: 1, value: 20 }] },
        }),
      })
    );
    expect(line(sections, "capup", "record").value).toEqual({ kind: "percent", value: 1313 });
    // Every contributor gets its own line, sub-rows OF the record.
    const keys = section(sections, "capup").lines.map((entry) => entry.key);
    expect(keys).toContain(`trait-${FATEBREAKER_TRAIT.toString(16)}`);
    expect(keys).toContain("om-0-06595c52");
    expect(keys).toContain("summon-0-9245dfa4");
    // The DMG Cap trait reads as one of the traits, carrying its real value —
    // it is a trait the player equipped like any other, and splitting it out
    // made the trait list look like it was missing one.
    const dmgCap = line(sections, "capup", `trait-${DMG_CAP_TRAIT.toString(16)}`);
    expect(dmgCap.value).toEqual({ kind: "percent", value: 238 });
    expect(dmgCap.excluded).toBeUndefined();
  });

  it("has no separate DMG Cap term beside the trait list", () => {
    const sections = explainCapHit(input({ loadout: loadout({ sigils: [sigil(DMG_CAP_TRAIT, 63)] }) }));
    expect(section(sections, "capup").lines.map((entry) => entry.key)).not.toContain("dmgcap");
  });

  it("still attributes the DMG Cap trait outside the record", () => {
    // Where it RENDERS changed; what it MEANS did not. The game reads this one
    // trait through its own second lookup, so it is not inside the captured
    // record and must still count against the game total on its own.
    const sections = explainCapHit(input({ loadout: loadout({ sigils: [sigil(DMG_CAP_TRAIT, 63)] }) }));
    const dmgCap = line(sections, "capup", `trait-${DMG_CAP_TRAIT.toString(16)}`);
    expect(dmgCap.source).toEqual({ kind: "key", value: "ui.debug.cap-dmg-cap-source" });
    // 2728.99% game - 238% attributed, with no record captured.
    expect(line(sections, "capup", "unaccounted").value).toEqual({ kind: "percent", value: 2490.99 });
  });

  it("reports the remainder no attributed term explains", () => {
    const sections = explainCapHit(
      input({
        capUp: { normal: 13.13, skill: null, sba: null },
        loadout: loadout({ sigils: [sigil(DMG_CAP_TRAIT, 63)] }),
      })
    );
    // game 2728.99% - record 1313% - DMG Cap 238% = 1177.99%
    expect(line(sections, "capup", "unaccounted").value).toEqual({ kind: "percent", value: 1177.99 });
  });

  it("credits an active channel board node against the game total", () => {
    // pl0300_000c: "DMG Cap +15%", scope always — a FreeWork channel term the
    // oracle sees on every hit, so it is NOT inside the captured record and
    // counts against the game total on its own (log 2573 reconciliation).
    const sections = explainCapHit(
      input({ loadout: loadout({ characterType: "Pl0300", skillboard: [0x0c] }), conditions: {} })
    );
    // game 2728.99% − channel 15% = 2713.99%
    expect(line(sections, "capup", "unaccounted").value).toEqual({ kind: "percent", value: 2713.99 });
    // Rendered beside the record, not as a sub-row of it.
    expect(line(sections, "capup", "board-pl0300_000c-0").depth).toBe(1);
  });

  it("keeps a counted-sigil board node inside the record", () => {
    // pl0300_0023: "+20% per Basic sigil" — static per fight, fused into the
    // captured record at load; it never rides the per-hit channel, so crediting
    // it would double-count. It stays a sub-row OF the record.
    const basic = { ...sigil(0x50079a1c, 1) };
    const sections = explainCapHit(
      input({
        capUp: { normal: 13.13, skill: null, sba: null },
        loadout: loadout({ characterType: "Pl0300", skillboard: [0x23], sigils: [basic, basic, basic] }),
        conditions: {},
      })
    );
    // game 2728.99% − record 1313% only: the counted node's 60% is not credited.
    expect(line(sections, "capup", "unaccounted").value).toEqual({ kind: "percent", value: 1415.99 });
    expect(line(sections, "capup", "board-pl0300_0023-0").depth).toBe(2);
  });

  it("says the record was never captured rather than counting it as zero", () => {
    const sections = explainCapHit(input({ loadout: loadout() }));
    expect(line(sections, "capup", "record").value).toEqual({ kind: "absent" });
    // With nothing attributed, the whole game total is unaccounted for.
    expect(line(sections, "capup", "unaccounted").value).toEqual({ kind: "percent", value: 2728.99 });
  });

  it("has nothing to divide when the ladder could not answer", () => {
    const sections = explainCapHit(input({ characterType: undefined }));
    expect(section(sections, "capup").unavailableKey).not.toBeNull();
  });
});

describe("the clamp section", () => {
  it("shows the bound the game clamped to and how far over it the hit was", () => {
    const sections = explainCapHit(input());
    expect(line(sections, "clamp", "precap").value).toEqual({ kind: "count", value: 400_000 });
    expect(line(sections, "clamp", "bound").value).toEqual({ kind: "count", value: 152_737 });
    expect(line(sections, "clamp", "capped").value).toEqual({ kind: "verdict", value: true });
    // 400000 / 152737 = 261.89%
    expect(line(sections, "clamp", "overcap").value).toEqual({ kind: "percent", value: 261.89 });
  });

  it("clamps to the pre-cap base when the hit never reached its cap", () => {
    const under = input({ hit: { ...input().hit, base_damage: 1_000, damage: 1_000 } });
    const sections = explainCapHit(under);
    expect(line(sections, "clamp", "bound").value).toEqual({ kind: "count", value: 1_000 });
    expect(line(sections, "clamp", "capped").value).toEqual({ kind: "verdict", value: false });
  });
});

describe("the post-cap section", () => {
  it("divides the dealt damage by the clamp bound", () => {
    const sections = explainCapHit(input({ hit: { ...input().hit, damage: 305_474 } }));
    expect(line(sections, "postcap", "multiplier").value).toEqual({ kind: "multiplier", value: 2 });
  });

  it("says the three post-cap terms cannot be separated from the log", () => {
    // m1 x m2 + additive: the builder never stores them on the instance, so a
    // panel that split them would be inventing numbers.
    expect(section(explainCapHit(input()), "postcap").noteKey).toBe("ui.debug.cap-postcap-note");
  });
});

describe("a log recorded before the cap capture", () => {
  const old = input({
    hit: {
      damage: 152_737,
      damage_cap: null,
      base_damage: null,
      attack_rate: null,
      class_flags: null,
      flags: 0,
      instance_snapshot: null,
      record_snapshot: null,
    },
  });

  it("marks every derived section unavailable instead of rendering zeroes", () => {
    for (const key of ["base", "capup", "clamp", "postcap"]) {
      expect(section(explainCapHit(old), key).unavailableKey).not.toBeNull();
    }
  });

  it("still reports the one number it does have", () => {
    expect(line(explainCapHit(old), "clamp", "damage").value).toEqual({ kind: "count", value: 152_737 });
  });
});
