import { describe, expect, it } from "vitest";
import { EquippedSummon, PlayerState, Sigil, SkillState, WeaponInfo, WeaponState } from "./types";
import {
  EMPTY_ID,
  OVERMASTERY_EFFECT_IDS,
  checklistLevel,
  checklistStatus,
  collectSigilsByCategory,
  collectTraitSources,
  computeCombinedTraits,
  computeOvercapPercentage,
  computeSupPercentage,
  defaultChecklist,
  deriveNavState,
  deriveTranscendence,
  fillBonusGroups,
  formatSummonBonusValue,
  groupBonuses,
  skillboardLayoutFor,
  skillboardNodeKey,
  skillboardNodeMeta,
  summonBonusValue,
  toHash,
  toHashString,
  traitMaxLevel,
  type BonusSource,
} from "./utils";

const makeSkill = (actionType: SkillState["actionType"], totalDamage: number): SkillState => ({
  actionType,
  childCharacterType: "Pl0000",
  hits: 1,
  minDamage: totalDamage,
  maxDamage: totalDamage,
  totalDamage,
  totalStunValue: 0,
  maxStunValue: 0,
  cappedHits: 0,
  cappableHits: 0,
  overcapBaseSum: 0,
  overcapCapSum: 0,
});

const makePlayer = (skills: SkillState[]): PlayerState => ({
  index: 0,
  characterType: "Pl0000",
  totalDamage: skills.reduce((acc, s) => acc + s.totalDamage, 0),
  dps: 0,
  sba: 0,
  totalStunValue: 0,
  stunPerSecond: 0,
  lastDamageTime: 0,
  skillBreakdown: skills,
  cappedHits: 0,
  cappableHits: 0,
  overcapBaseSum: 0,
  overcapCapSum: 0,
});

describe("utils", () => {
  it("toHash", () => {
    expect(toHash(1)).toBe("1");
    expect(toHash(255)).toBe("ff");
  });

  it("toHashString", () => {
    expect(toHashString(1)).toBe("00000001");
    expect(toHashString(255)).toBe("000000ff");
  });

  it("skillboardNodeKey", () => {
    // Matches the map keys gen-langfiles emits into lang/<locale>/skillboard.json.
    expect(skillboardNodeKey("Pl2700", 10)).toBe("pl2700_000a");
    expect(skillboardNodeKey("Pl0000", 259)).toBe("pl0000_0103");
  });

  it("skillboardNodeMeta", () => {
    expect(skillboardNodeMeta(10)).toEqual({ category: "def", tier: 1 });
    expect(skillboardNodeMeta(27)).toEqual({ category: "def", tier: 2 });
    expect(skillboardNodeMeta(63)).toEqual({ category: "def", tier: "ex" });
    expect(skillboardNodeMeta(137)).toEqual({ category: "atk", tier: 3 });
    expect(skillboardNodeMeta(150)).toEqual({ category: "atk", tier: "ex" });
    expect(skillboardNodeMeta(213)).toEqual({ category: "lim", tier: 1 });
    expect(skillboardNodeMeta(259)).toEqual({ category: "lim", tier: "ex" });
    // A tier's special node encodes as tier - 1.
    expect(skillboardNodeMeta(2)).toEqual({ category: "def", tier: 3 });
    // Outside any known band.
    expect(skillboardNodeMeta(305)).toBeNull();
    expect(skillboardNodeMeta(5)).toBeNull();
  });

  describe("computeSupPercentage", () => {
    it("is 0 without supplementary damage", () => {
      const player = makePlayer([makeSkill({ Normal: 1 }, 1000)]);
      expect(computeSupPercentage(player)).toEqual({ eligible: 0, overall: 0 });
    });

    it("is supplementary damage relative to eligible damage", () => {
      // 1000 eligible + 200 procs -> +20% eligible; 200 of 1200 total -> ~16.7% overall
      const player = makePlayer([makeSkill({ Normal: 1 }, 1000), makeSkill({ SupplementaryDamage: 1 }, 200)]);
      const { eligible, overall } = computeSupPercentage(player);
      expect(eligible).toBeCloseTo(20);
      expect(overall).toBeCloseTo(100 / 6);
    });

    it("excludes supp-ineligible damage (Link Attack, SBA, DoT) from the eligible base", () => {
      // 1000 eligible + 200 procs -> +20% eligible, regardless of LA/SBA/DoT damage;
      // overall is the supp share of ALL damage
      const player = makePlayer([
        makeSkill({ Normal: 1 }, 1000),
        makeSkill({ SupplementaryDamage: 1 }, 200),
        makeSkill("LinkAttack", 800),
        makeSkill("SBA", 6000),
        makeSkill({ DamageOverTime: 0 }, 2000),
      ]);
      const { eligible, overall } = computeSupPercentage(player);
      expect(eligible).toBeCloseTo(20);
      expect(overall).toBeCloseTo((200 / 10000) * 100);
    });

    it("caps out at +60% when every hit procs all three sources", () => {
      const player = makePlayer([makeSkill({ Normal: 1 }, 1000), makeSkill({ SupplementaryDamage: 1 }, 600)]);
      expect(computeSupPercentage(player).eligible).toBeCloseTo(60);
    });

    it("is 0 for a player with no damage", () => {
      const player = makePlayer([]);
      expect(computeSupPercentage(player)).toEqual({ eligible: 0, overall: 0 });
    });
  });

  describe("computeCombinedTraits", () => {
    const makeSigil = (overrides: Partial<Sigil>): Sigil => ({
      firstTraitId: EMPTY_ID,
      firstTraitLevel: 0,
      secondTraitId: EMPTY_ID,
      secondTraitLevel: 0,
      sigilId: 1,
      equippedCharacter: 0,
      sigilLevel: 15,
      acquisitionCount: 0,
      notificationEnum: 0,
      ...overrides,
    });

    const makeSummon = (overrides: Partial<EquippedSummon>): EquippedSummon => ({
      summonId: 1,
      mainTraitId: EMPTY_ID,
      mainTraitLevel: 0,
      bonusId: EMPTY_ID,
      bonusLevel: 0,
      ...overrides,
    });

    const makeWeaponState = (wrightstoneTraits: WeaponState["wrightstoneTraits"]): WeaponState => ({
      weaponId: 1,
      exp: 0,
      starLevel: 0,
      plusMarks: 0,
      awakeningLevel: 0,
      wrightstoneId: 1,
      wrightstoneTraits,
      innateTraits: [{ id: 0xaaaa, level: 10 }],
    });

    it("sums the same trait across sigils, summons, the wrightstone, and weapon innate skills", () => {
      const traits = computeCombinedTraits({
        sigils: [
          makeSigil({ firstTraitId: 0x100, firstTraitLevel: 15 }),
          makeSigil({ firstTraitId: 0x100, firstTraitLevel: 12, secondTraitId: 0x200, secondTraitLevel: 5 }),
        ],
        summons: [makeSummon({ mainTraitId: 0x100, mainTraitLevel: 10 })],
        weaponState: makeWeaponState([{ id: 0x200, level: 7 }]),
        weaponInfo: null,
      });

      expect(traits).toEqual([
        { id: 0x100, level: 37 },
        { id: 0x200, level: 12 },
        { id: 0xaaaa, level: 10 },
      ]);
    });

    it("ignores empty ids, empty sigil slots, and zero levels", () => {
      const traits = computeCombinedTraits({
        sigils: [
          makeSigil({ sigilId: EMPTY_ID, firstTraitId: 0x300, firstTraitLevel: 15 }),
          makeSigil({ firstTraitId: 0x400, firstTraitLevel: 0 }),
        ],
        summons: [makeSummon({})],
        weaponState: makeWeaponState([]),
        weaponInfo: null,
      });

      // The weapon's innate skill (from the shared fixture) still counts.
      expect(traits).toEqual([{ id: 0xaaaa, level: 10 }]);
    });

    it("falls back to legacy weaponInfo wrightstone traits", () => {
      const weaponInfo: WeaponInfo = {
        weaponId: 1,
        starLevel: 0,
        plusMarks: 0,
        awakeningLevel: 0,
        trait1Id: 0x500,
        trait1Level: 10,
        trait2Id: 0x600,
        trait2Level: 5,
        trait3Id: EMPTY_ID,
        trait3Level: 0,
        wrightstoneId: 1,
        weaponLevel: 0,
        weaponHp: 0,
        weaponAttack: 0,
      };

      const traits = computeCombinedTraits({ sigils: [], summons: [], weaponState: null, weaponInfo });

      expect(traits).toEqual([
        { id: 0x500, level: 10 },
        { id: 0x600, level: 5 },
      ]);
    });

    it("sorts by total level descending, then id for ties", () => {
      const traits = computeCombinedTraits({
        sigils: [
          makeSigil({ firstTraitId: 0x900, firstTraitLevel: 5 }),
          makeSigil({ firstTraitId: 0x800, firstTraitLevel: 5 }),
          makeSigil({ firstTraitId: 0x700, firstTraitLevel: 20 }),
        ],
        summons: [],
        weaponState: null,
        weaponInfo: null,
      });

      expect(traits.map((trait) => trait.id)).toEqual([0x700, 0x800, 0x900]);
    });
  });

  describe("checklistLevel", () => {
    it("sums combined-trait levels across an entry's id group", () => {
      // DMG Cap counts the generic trait plus the colored character variants.
      const dmgCap = defaultChecklist().build.find((entry) => entry.ids.includes(0xdc584f60))!;
      const traits = [
        { id: 0xdc584f60, level: 45 },
        { id: 0xaefeb1bc, level: 20 },
        { id: 0x4c588c27, level: 15 },
      ];
      expect(checklistLevel(traits, dmgCap)).toBe(65);
    });

    it("is 0 when none of the entry's ids are present", () => {
      const warElemental = defaultChecklist().build.find((entry) => entry.ids.includes(0x4c588c27))!;
      expect(checklistLevel([{ id: 0xdc584f60, level: 45 }], warElemental)).toBe(0);
    });
  });

  describe("collectTraitSources", () => {
    it("lists each contributing sigil, summon, and wrightstone with its level", () => {
      const sources = collectTraitSources(
        {
          sigils: [
            {
              firstTraitId: 0x100,
              firstTraitLevel: 15,
              secondTraitId: 0x200,
              secondTraitLevel: 5,
              sigilId: 0xabc,
              equippedCharacter: 0,
              sigilLevel: 15,
              acquisitionCount: 0,
              notificationEnum: 0,
            },
          ],
          summons: [{ summonId: 0xdef, mainTraitId: 0x100, mainTraitLevel: 10, bonusId: EMPTY_ID, bonusLevel: 0 }],
          weaponState: {
            weaponId: 0x456,
            exp: 0,
            starLevel: 0,
            plusMarks: 0,
            awakeningLevel: 0,
            wrightstoneId: 0x123,
            wrightstoneTraits: [{ id: 0x100, level: 7 }],
            innateTraits: [{ id: 0x100, level: 10 }],
          },
          weaponInfo: null,
        },
        [0x100]
      );

      expect(sources).toEqual([
        { kind: "sigil", sourceId: 0xabc, level: 15 },
        { kind: "summon", sourceId: 0xdef, level: 10 },
        { kind: "wrightstone", sourceId: 0x123, level: 7 },
        { kind: "weapon", sourceId: 0x456, level: 10 },
      ]);
    });

    it("matches any id in the group and skips empty sigil slots", () => {
      const sources = collectTraitSources(
        {
          sigils: [
            {
              firstTraitId: 0x200,
              firstTraitLevel: 15,
              secondTraitId: EMPTY_ID,
              secondTraitLevel: 0,
              sigilId: EMPTY_ID,
              equippedCharacter: 0,
              sigilLevel: 15,
              acquisitionCount: 0,
              notificationEnum: 0,
            },
          ],
          summons: [],
          weaponState: null,
          weaponInfo: null,
        },
        [0x100, 0x200]
      );

      expect(sources).toEqual([]);
    });
  });

  describe("skillboardLayoutFor", () => {
    it("returns Zeta's real per-tier node counts from the layout asset", () => {
      // Pl1600 = Zeta. Counts exclude the keystone/special nodes (3 per Chaos
      // tier), which the in-game boards do not list as tier traits.
      const tiers = skillboardLayoutFor("Pl1600");
      expect(tiers.map((tier) => [tier.key, tier.ids.length])).toEqual([
        [1, 12],
        [2, 24],
        [3, 24],
        ["ex", 30],
      ]);
    });

    it("is empty for unknown characters", () => {
      expect(skillboardLayoutFor({ Unknown: 123 })).toEqual([]);
    });
  });

  describe("checklistStatus", () => {
    it("classifies missing / partial / met / over", () => {
      expect(checklistStatus(0, 15)).toBe("missing");
      expect(checklistStatus(7, 15)).toBe("partial");
      expect(checklistStatus(15, 15)).toBe("met");
      expect(checklistStatus(20, 15)).toBe("over");
    });
  });

  describe("traitMaxLevel", () => {
    it("returns the trait's effect cap from the extracted table", () => {
      expect(traitMaxLevel(0xdc584f60)).toBe(65); // DMG Cap
      expect(traitMaxLevel(0xceb700ee)).toBe(45); // Stun Power
      expect(traitMaxLevel(0x4c588c27)).toBe(15); // War Elemental
    });

    it("is null for ids the table doesn't know", () => {
      expect(traitMaxLevel(0xdeadbeef)).toBeNull();
    });
  });

  describe("collectSigilsByCategory", () => {
    const makeSigil = (overrides: Partial<Sigil>): Sigil => ({
      firstTraitId: EMPTY_ID,
      firstTraitLevel: 0,
      secondTraitId: EMPTY_ID,
      secondTraitLevel: 0,
      sigilId: 1,
      equippedCharacter: 0,
      sigilLevel: 15,
      acquisitionCount: 0,
      notificationEnum: 0,
      ...overrides,
    });

    // Real trait ids, one per in-game sigil type (see sigil-trait-categories.json).
    const atk = makeSigil({ sigilId: 0xa, firstTraitId: 0x50079a1c, firstTraitLevel: 15 }); // ATK -> basic
    const stun = makeSigil({ sigilId: 0xb, firstTraitId: 0xceb700ee, firstTraitLevel: 15 }); // Stun Power -> basic
    const warElemental = makeSigil({ sigilId: 0xc, firstTraitId: 0x4c588c27, firstTraitLevel: 15 }); // attack
    const glassCannon = makeSigil({ sigilId: 0xd, firstTraitId: 0xa8a3163b, firstTraitLevel: 15 }); // attack
    const aegis = makeSigil({ sigilId: 0xe, firstTraitId: 0xe0abfdfe, firstTraitLevel: 15 }); // defense
    const uplift = makeSigil({ sigilId: 0xf, firstTraitId: 0xb5ff9fd3, firstTraitLevel: 15 }); // support
    const guts = makeSigil({ sigilId: 0x10, firstTraitId: 0xe69a4694, firstTraitLevel: 15 }); // other

    const party = { sigils: [atk, stun, warElemental, glassCannon, aegis, uplift, guts] };

    it("keeps sigils whose first trait is of a requested type", () => {
      expect(collectSigilsByCategory(party, ["basic"])).toEqual([atk, stun]);
      expect(collectSigilsByCategory(party, ["attack"])).toEqual([warElemental, glassCannon]);
      expect(collectSigilsByCategory(party, ["defense", "support"])).toEqual([aegis, uplift]);
      expect(collectSigilsByCategory(party, ["other"])).toEqual([guts]);
    });

    it("ignores empty slots, unknown first traits, and category traits in the second slot", () => {
      const empty = makeSigil({ sigilId: EMPTY_ID, firstTraitId: 0x50079a1c, firstTraitLevel: 15 });
      const secondSlotBasic = makeSigil({
        sigilId: 0xa,
        firstTraitId: 0x123,
        firstTraitLevel: 15,
        secondTraitId: 0x50079a1c,
        secondTraitLevel: 15,
      });

      expect(collectSigilsByCategory({ sigils: [empty, secondSlotBasic] }, ["basic"])).toEqual([]);
      expect(collectSigilsByCategory({ sigils: undefined }, ["basic"])).toEqual([]);
    });
  });

  describe("defaultChecklist", () => {
    it("parses the bundled JSON, converting hex ids to numbers", () => {
      const { build, ai } = defaultChecklist();
      expect(build).toHaveLength(13);
      expect(ai).toEqual([{ ids: [0xa8a3163b], level: 15 }]);
      const dmgCap = build.find((entry) => entry.ids.length > 1)!;
      expect(dmgCap).toEqual({ ids: [0xdc584f60, 0x0151cf9e, 0x3b71af12, 0xaefeb1bc, 0xfff8cf64], level: 65 });
    });
  });

  describe("summonBonusValue", () => {
    it("returns the raw display value with its unit", () => {
      // 0xa8900c80 = Attack Power Up (flat): level index 0 -> 200.
      expect(summonBonusValue(0xa8900c80, 0)).toEqual({ kind: "flat", amount: 200 });
      // 0x00d171e0 = Critical Hit Rate Up (percent): level index 9 -> 20.
      expect(summonBonusValue(0x00d171e0, 9)).toEqual({ kind: "percent", amount: 20 });
    });

    it("is null for unknown ids or out-of-range levels", () => {
      expect(summonBonusValue(0xdeadbeef, 0)).toBeNull();
      expect(summonBonusValue(0xa8900c80, 10)).toBeNull();
    });
  });

  describe("groupBonuses", () => {
    it("groups same-named bonuses, keeping sources and per-unit totals", () => {
      const omAtk: BonusSource = { kind: "overmastery", sourceId: 0x1, value: { kind: "level", amount: 3 } };
      const omCrit: BonusSource = { kind: "overmastery", sourceId: 0x2, value: { kind: "percent", amount: 5 } };
      const sumAtkA: BonusSource = { kind: "summon", sourceId: 0xa, value: { kind: "flat", amount: 200 } };
      const sumAtkB: BonusSource = { kind: "summon", sourceId: 0xb, value: { kind: "flat", amount: 350 } };
      const sumCrit: BonusSource = { kind: "summon", sourceId: 0xc, value: { kind: "percent", amount: 20 } };

      const combined = groupBonuses([
        { name: "Attack Power Up", source: omAtk },
        { name: "Critical Hit Rate Up", source: omCrit },
        { name: "Attack Power Up", source: sumAtkA },
        { name: "Attack Power Up", source: sumAtkB },
        { name: "Critical Hit Rate Up", source: sumCrit },
      ]);

      // First-seen order; totals in flat / percent / level order, zero units dropped.
      expect(combined).toEqual([
        {
          name: "Attack Power Up",
          sources: [omAtk, sumAtkA, sumAtkB],
          totals: [
            { kind: "flat", amount: 550 },
            { kind: "level", amount: 3 },
          ],
        },
        {
          name: "Critical Hit Rate Up",
          sources: [omCrit, sumCrit],
          totals: [{ kind: "percent", amount: 25 }],
        },
      ]);
    });

    it("keeps single-source bonuses as one-entry groups", () => {
      const source: BonusSource = { kind: "summon", sourceId: 0xa, value: { kind: "flat", amount: 200 } };
      expect(groupBonuses([{ name: "Health Up", source }])).toEqual([
        { name: "Health Up", sources: [source], totals: [{ kind: "flat", amount: 200 }] },
      ]);
    });
  });

  describe("fillBonusGroups", () => {
    it("lists every known effect in canonical order, empty groups for the missing ones", () => {
      const source: BonusSource = { kind: "summon", sourceId: 0xa, value: { kind: "flat", amount: 200 } };
      const healthUp = { name: "Health Up", sources: [source], totals: [{ kind: "flat" as const, amount: 200 }] };

      expect(fillBonusGroups([healthUp], ["Attack Power Up", "Health Up", "Stun Power Up"])).toEqual([
        { name: "Attack Power Up", sources: [], totals: [] },
        healthUp,
        { name: "Stun Power Up", sources: [], totals: [] },
      ]);
    });

    it("appends groups the canonical list doesn't know instead of dropping them", () => {
      const source: BonusSource = { kind: "overmastery", sourceId: 0x1, value: { kind: "level", amount: 3 } };
      const unknown = {
        name: "Unknown (deadbeef)",
        sources: [source],
        totals: [{ kind: "level" as const, amount: 3 }],
      };

      expect(fillBonusGroups([unknown], ["Attack Power Up"])).toEqual([
        { name: "Attack Power Up", sources: [], totals: [] },
        unknown,
      ]);
    });
  });

  describe("OVERMASTERY_EFFECT_IDS", () => {
    it("covers the 11 distinct effects with one representative id each", () => {
      expect(OVERMASTERY_EFFECT_IDS).toHaveLength(11);
      expect(new Set(OVERMASTERY_EFFECT_IDS).size).toBe(11);
    });
  });

  describe("formatSummonBonusValue", () => {
    it("formats flat and percent bonuses from the extracted table", () => {
      // 0xa8900c80 = Attack Power Up (flat): level index 0 -> +200.
      expect(formatSummonBonusValue(0xa8900c80, 0)).toBe("+200");
      // 0x00d171e0 = Critical Hit Rate Up (percent): level index 9 -> +20%.
      expect(formatSummonBonusValue(0x00d171e0, 9)).toBe("+20%");
      // 0xf7b0316f = Stun Power Up: display-multiplied (0.2 x 10) flat value.
      expect(formatSummonBonusValue(0xf7b0316f, 0)).toBe("+2");
    });

    it("is null for unknown ids or out-of-range levels", () => {
      expect(formatSummonBonusValue(0xdeadbeef, 0)).toBeNull();
      expect(formatSummonBonusValue(0xa8900c80, 10)).toBeNull();
    });
  });

  describe("computeOvercapPercentage", () => {
    it("is the game's (ΣbaseSum / ΣcapSum) * 100", () => {
      // base 1500 vs cap 1000 -> 150%
      expect(computeOvercapPercentage({ overcapBaseSum: 1500, overcapCapSum: 1000 })).toBeCloseTo(150);
      // exactly at cap -> 100%
      expect(computeOvercapPercentage({ overcapBaseSum: 1000, overcapCapSum: 1000 })).toBeCloseTo(100);
    });

    it("is null when there are no cappable hits (no cap sum)", () => {
      expect(computeOvercapPercentage({ overcapBaseSum: 0, overcapCapSum: 0 })).toBeNull();
    });
  });

  describe("deriveTranscendence", () => {
    // Real live data (2026-07-18 WSDIAG): Hraesvelgr (WEP_PL2700_06_03,
    // 0xded16fcf) at in-game Transcendence 9/10. Slot 1's live id
    // (0xa8a3163b, the upgrade-resolved variant) differs from the asset's
    // base id (0xf17850b9) — exercises the positional fallback.
    const hraesvelgr = 0xded16fcf;
    const stage9Traits = [
      { id: 0x1e1cecce, level: 32 },
      { id: 0xa8a3163b, level: 22 },
      { id: 0xdc584f60, level: 12 },
      { id: 0x57e8a93f, level: 1 },
    ];

    it("derives stage 9/10 from the live innate levels of a transcended weapon", () => {
      expect(deriveTranscendence(hraesvelgr, stage9Traits)).toBe(9);
    });

    it("derives the max stage when levels sit at each curve's final value", () => {
      const traits = [
        { id: 0x1e1cecce, level: 35 },
        { id: 0xa8a3163b, level: 25 },
        { id: 0xdc584f60, level: 15 },
        { id: 0x57e8a93f, level: 1 },
      ];
      expect(deriveTranscendence(hraesvelgr, traits)).toBe(10);
    });

    it("is null when only a flat curve constrains the stage (ambiguous)", () => {
      expect(deriveTranscendence(hraesvelgr, [{ id: 0x57e8a93f, level: 1 }])).toBeNull();
    });

    it("is null for level-0 traits (pre-fix logs never recorded levels)", () => {
      const traits = stage9Traits.map((trait) => ({ ...trait, level: 0 }));
      expect(deriveTranscendence(hraesvelgr, traits)).toBeNull();
    });

    it("is null for weapons without transcendence curves", () => {
      expect(deriveTranscendence(0x12345678, stage9Traits)).toBeNull();
    });
  });

  describe("deriveNavState", () => {
    it("marks the Logs tab active on the list, detail, and conflux pages", () => {
      for (const pathname of ["/logs", "/logs/123", "/logs/conflux", "/logs/conflux/run/5"]) {
        const nav = deriveNavState(pathname);
        expect(nav.logsActive, pathname).toBe(true);
        expect(nav.toolboxActive, pathname).toBe(false);
        expect(nav.settingsActive, pathname).toBe(false);
      }
    });

    it("marks toolbox and settings tabs active on their pages only", () => {
      const toolbox = deriveNavState("/logs/toolbox");
      expect(toolbox).toMatchObject({ logsActive: false, toolboxActive: true, settingsActive: false });

      const settings = deriveNavState("/logs/settings");
      expect(settings).toMatchObject({ logsActive: false, toolboxActive: false, settingsActive: true });
    });

    it("keeps the quests/conflux sub-tab split and list-page detection", () => {
      expect(deriveNavState("/logs")).toMatchObject({ questsActive: true, confluxActive: false, onListPage: true });
      expect(deriveNavState("/logs/conflux")).toMatchObject({
        questsActive: false,
        confluxActive: true,
        onListPage: true,
      });
      expect(deriveNavState("/logs/123")).toMatchObject({ questsActive: true, onListPage: false });
      expect(deriveNavState("/logs/settings")).toMatchObject({ questsActive: false, onListPage: false });
    });
  });
});
