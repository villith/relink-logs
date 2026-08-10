import { describe, expect, it } from "vitest";

import { deriveButtonMemberships } from "./gen-attack-groups-from-buttons.mjs";

// One character shaped like the real cases: twin Attacks groups (g0 icon 4 /
// g1 icon 3), a charged-left group (g3 icon 4), and a word-named group (g16
// "Power Finishers", no icon).
const nodes = {
  pl9900_0001: {
    effects: [{ stat: "cap", percent: 35, scope: "attack-group", targetAttackGroup: 0, abilityIds: [] }],
  },
  pl9900_0002: {
    effects: [{ stat: "cap", percent: 35, scope: "attack-group", targetAttackGroup: 1, abilityIds: [] }],
  },
  pl9900_0003: {
    effects: [{ stat: "cap", percent: 35, scope: "attack-group", targetAttackGroup: 3, abilityIds: [] }],
  },
  pl9900_0004: {
    effects: [{ stat: "cap", percent: 30, scope: "attack-group", targetAttackGroup: 16, abilityIds: [] }],
  },
};
const lang = {
  pl9900_0001: { text: "Attacks: DMG Cap +35%" },
  pl9900_0002: { text: "Attacks: DMG Cap +35%" },
  pl9900_0003: { text: "Charged Attacks: DMG Cap +35%" },
  pl9900_0004: { text: "Power Finishers: DMG Cap +30%" },
};
const icons = { pl9900: { 0: [4], 1: [3], 3: [4], 16: [] } };
const skillNames = {
  Pl9900: {
    100: "Attack 1",
    101: "Attack 1 (Charged)",
    152: "Combo Finisher 1 (Charged)",
    165: "Power Finisher 2",
    200: "Schlacht",
    300: "Aerial Attack 1",
  },
};
const buttonMap = {
  pl9900: {
    families: [
      { name: "basic string", ids: [100], button: "left", source: "scott" },
      { name: "charged string", ids: [101, 152], button: "left", source: "inferred" },
      { name: "finishers", ids: [165], button: "left", source: "scott" },
      { name: "Schlacht", ids: [200], button: "right", source: "inferred" },
      { name: "aerials", ids: [300], button: "left", source: "scott" },
      { name: "Mystery Stance", ids: [400], button: null, source: null, note: "unresolved" },
    ],
  },
};

const run = () => deriveButtonMemberships({ buttonMap, icons, nodes, lang, skillNames });

describe("deriveButtonMemberships", () => {
  it("banks left-button actions to the icon-4 Attacks group and right to icon-3", () => {
    const { memberships } = run();
    // 165 name-matches the Power Finishers group, so the overlap rule keeps it
    // OUT of the Attacks group (Tweyen's oracle data proves such actions can
    // sit outside "Attacks"); charged hits stay IN (Percival's proves they do).
    expect(memberships.pl9900[0].actionIds).toEqual([100, 101, 152, 300]);
    expect(memberships.pl9900[1].actionIds).toEqual([200]);
  });

  it("banks the charged group from charge families of its side, minus finisher hits", () => {
    const { memberships } = run();
    // 152 is a charged FINISHER: Tweyen's per-hit counts show those live in at
    // most one group, so they are not claimed for "Charged Attacks".
    expect(memberships.pl9900[3].actionIds).toEqual([101]);
  });

  it("banks word-named groups by per-action name match regardless of button", () => {
    const { memberships } = run();
    expect(memberships.pl9900[16].actionIds).toEqual([165]);
  });

  it("reports unresolved families and never banks them", () => {
    const { memberships, unresolved } = run();
    const banked = Object.values(memberships.pl9900).flatMap((m) => m.actionIds);
    expect(banked).not.toContain(400);
    expect(unresolved.some((u) => u.family === "Mystery Stance")).toBe(true);
  });

  it("falls back to last-word matching when the full phrase misses, minus other groups' claims", () => {
    // Katalina's shape: the "Combo Finishers" group, but her actions are named
    // just "Finisher 1". The fallback must still NOT steal actions claimed by
    // another named group (a "Power Finisher" belongs to Power Finishers).
    const kataNodes = {
      pl9800_0001: { effects: [{ stat: "cap", percent: 35, scope: "attack-group", targetAttackGroup: 8, abilityIds: [] }] },
      pl9800_0002: { effects: [{ stat: "cap", percent: 30, scope: "attack-group", targetAttackGroup: 16, abilityIds: [] }] },
    };
    const kataLang = {
      pl9800_0001: { text: "Combo Finishers: DMG Cap +35%" },
      pl9800_0002: { text: "Power Finishers: DMG Cap +30%" },
    };
    const { memberships } = deriveButtonMemberships({
      buttonMap: { pl9800: { families: [] } },
      icons: { pl9800: { 8: [3], 16: [] } },
      nodes: kataNodes,
      lang: kataLang,
      skillNames: { Pl9800: { 110: "Finisher 1", 165: "Power Finisher 2" } },
    });
    expect(memberships.pl9800[8].actionIds).toEqual([110]);
    expect(memberships.pl9800[16].actionIds).toEqual([165]);
  });

  it("name-matches a charged group that renders no icon (Gran's Power Raise)", () => {
    const granNodes = {
      pl9700_0001: { effects: [{ stat: "cap", percent: 45, scope: "attack-group", targetAttackGroup: 4, abilityIds: [] }] },
    };
    const { memberships } = deriveButtonMemberships({
      buttonMap: { pl9700: { families: [{ name: "Power Raise", ids: [200, 201], button: "right", source: "scott" }] } },
      icons: { pl9700: { 4: [] } },
      nodes: granNodes,
      lang: { pl9700_0001: { text: "Power Raise: DMG Cap +{10}% / Charge Time +10%" } },
      skillNames: { Pl9700: { 200: "Power Raise", 201: "Power Raise (After Combo A)" } },
    });
    expect(memberships.pl9700[4].actionIds).toEqual([200, 201]);
  });

  it("never falls back for phrases other than Combo Finishers", () => {
    // "Turbine Finishers" with no full match must NOT grab every action named
    // "Finisher" — those are the basic string's finishers.
    const { memberships, unmatchedGroups } = deriveButtonMemberships({
      buttonMap: { pl9500: { families: [] } },
      icons: { pl9500: { 16: [] } },
      nodes: {
        pl9500_0001: { effects: [{ stat: "cap", percent: 30, scope: "attack-group", targetAttackGroup: 16, abilityIds: [] }] },
      },
      lang: { pl9500_0001: { text: "Turbine Finishers: DMG Cap +30%" } },
      skillNames: { Pl9500: { 104: "Combo Finisher 1" } },
    });
    expect(memberships.pl9500).toBeUndefined();
    expect(unmatchedGroups.some((u) => u.group === 16)).toBe(true);
  });

  it("banks a both-icons group ('/ Attacks') from both sides' families", () => {
    const { memberships } = deriveButtonMemberships({
      buttonMap: {
        pl9600: {
          families: [
            { name: "basic string", ids: [100], button: "left", source: "scott" },
            { name: "Bull's Eye Blast", ids: [200], button: "right", source: "scott" },
          ],
        },
      },
      icons: { pl9600: { 18: [4, 3] } },
      nodes: {
        pl9600_0001: { effects: [{ stat: "cap", percent: 20, scope: "attack-group", targetAttackGroup: 18, abilityIds: [] }] },
      },
      lang: { pl9600_0001: { text: "/ Attacks: DMG Cap +20%" } },
      skillNames: { Pl9600: { 100: "Attack", 200: "Bull's Eye Blast" } },
    });
    expect(memberships.pl9600[18].actionIds).toEqual([100, 200]);
  });

  it("carries the source mix into each membership's evidence tag", () => {
    const { memberships } = run();
    expect(memberships.pl9900[0].evidence).toContain("manual:button-map");
    expect(memberships.pl9900[0].evidence).toContain("inferred");
    expect(memberships.pl9900[16].evidence).not.toContain("inferred");
  });
});
