import { describe, expect, it } from "vitest";
import { gameXxhash32 } from "../scripts/gbfr-hash.mjs";
import skillNameSources from "../src-tauri/assets/skill-name-sources.json";
import enAbilities from "../src-tauri/lang/en/abilities.json";
import enEnemies from "../src-tauri/lang/en/enemies.json";
import enOvermasteries from "../src-tauri/lang/en/overmasteries.json";
import enBranches from "../src-tauri/lang/en/skillboard-branches.json";
import enSummons from "../src-tauri/lang/en/summons.json";
import enUi from "../src-tauri/lang/en/ui.json";
import { stripTierSuffix } from "./skillNameSources";
import {
  EnemyState,
  EquippedSummon,
  PlayerData,
  PlayerState,
  Sigil,
  SkillState,
  WeaponInfo,
  WeaponState,
} from "./types";
import {
  EMPTY_ID,
  OVERMASTERY_EFFECT_IDS,
  SKILLBOARD_CATEGORIES,
  SUMMON_ATTACK_ACTION_ID,
  barWidth,
  checklistLevel,
  checklistStatus,
  collectSigilsByCategory,
  collectTraitSources,
  computeCombinedTraits,
  computeOvercapPercentage,
  computeSupPercentage,
  damageOverTimeKeys,
  defaultChecklist,
  deriveNavState,
  deriveTranscendence,
  fillBonusGroups,
  formatBonusAmount,
  formatSummonBonusValue,
  getBossHpTarget,
  getPlayerLevel,
  groupBonuses,
  hasQuestElapsedTime,
  humanizeNumbers,
  mergeTargetBreakdowns,
  moveItem,
  orderedChecklistEntries,
  overmasteryAmountFromId,
  overmasteryAmountFromKind,
  resolveAvailableTab,
  skillboardActivationCost,
  skillboardLayoutFor,
  skillboardNodeKey,
  skillboardNodeMeta,
  summonBonusValue,
  toHash,
  toHashString,
  traitMaxLevel,
  translateTraitId,
  type BonusSource,
} from "./utils";

const makeSkill = (
  actionType: SkillState["actionType"],
  totalDamage: number,
  childCharacterType: SkillState["childCharacterType"] = "Pl0000"
): SkillState => ({
  actionType,
  childCharacterType,
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
  describe("getPlayerLevel", () => {
    const playerWithLevels = (recordLevel?: number, legacyLevel?: number): PlayerData =>
      ({
        stats: recordLevel === undefined ? null : { level: recordLevel },
        playerStats: legacyLevel === undefined ? null : { level: legacyLevel },
      }) as PlayerData;

    it("prefers the recovered record level over the legacy level", () => {
      expect(getPlayerLevel(playerWithLevels(100, 1))).toBe(100);
    });

    it("falls back to the legacy level for older logs", () => {
      expect(getPlayerLevel(playerWithLevels(undefined, 100))).toBe(100);
    });

    it("preserves the existing level 1 fallback when neither source has a value", () => {
      expect(getPlayerLevel(playerWithLevels())).toBe(1);
    });
  });

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

    it("excludes Ferry's pets and Umlauf from the eligible base", () => {
      // The ghosts' hits report as Normal skills but no supplementary proc is ever
      // logged under their bodies, so counting them only dilutes the proc-quality
      // number: log 1668 read 13.4% with them in the base and 29.5% without.
      const player = makePlayer([
        makeSkill({ Normal: 1 }, 1000),
        makeSkill({ Normal: 9995 }, 4000, "Pl0700Ghost"),
        makeSkill({ Normal: 1700 }, 2000, "Pl0700GhostSatellite"),
        makeSkill({ SupplementaryDamage: 1 }, 200),
      ]);
      const { eligible, overall } = computeSupPercentage(player);
      expect(eligible).toBeCloseTo(20);
      expect(overall).toBeCloseTo((200 / 7200) * 100);
    });

    it("excludes summon hits from the eligible base", () => {
      // Summons are called, not swung: no supplementary damage is ever logged under
      // a summon body, and one Primal Burst can outweigh a whole rotation.
      const player = makePlayer([
        makeSkill({ Normal: 1 }, 1000),
        makeSkill({ Normal: SUMMON_ATTACK_ACTION_ID }, 9000, { Unknown: 0x5418b8f8 }),
        makeSkill({ SupplementaryDamage: 1 }, 200),
      ]);
      expect(computeSupPercentage(player).eligible).toBeCloseTo(20);
    });

    it("keeps a transformed body's own hits eligible", () => {
      // Id's transformation (Pl2000) and Cagliostro's clone do proc supplementary
      // damage — the exclusion is for pets and summons, not every child body.
      const player = makePlayer([
        makeSkill({ Normal: 1000 }, 4000, "Pl2000"),
        makeSkill({ SupplementaryDamage: 1 }, 800),
      ]);
      expect(computeSupPercentage(player).eligible).toBeCloseTo(20);
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
      const dmgCap = defaultChecklist()
        .find((group) => group.id === "build")!
        .entries.find((entry) => entry.ids.includes(0xdc584f60))!;
      const traits = [
        { id: 0xdc584f60, level: 45 },
        { id: 0xaefeb1bc, level: 20 },
        { id: 0x4c588c27, level: 15 },
      ];
      expect(checklistLevel(traits, dmgCap)).toBe(65);
    });

    it("is 0 when none of the entry's ids are present", () => {
      const warElemental = defaultChecklist()
        .find((group) => group.id === "build")!
        .entries.find((entry) => entry.ids.includes(0x4c588c27))!;
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

    it("splits every tier evenly across the three branches", () => {
      // The board is uniform for all 29 characters: 4 nodes per branch on
      // Chaos I, 8 on Chaos II/III — which is what the activation pips assume.
      for (const tier of skillboardLayoutFor("Pl1600")) {
        const perCategory = SKILLBOARD_CATEGORIES.map(
          (category) => tier.ids.filter((id) => skillboardNodeMeta(id)?.category === category).length
        );
        expect(perCategory).toEqual([tier.ids.length / 3, tier.ids.length / 3, tier.ids.length / 3]);
      }
    });
  });

  describe("skillboardActivationCost", () => {
    it("is 3 points on Chaos I and 6 on Chaos II/III", () => {
      expect(skillboardActivationCost(1)).toBe(3);
      expect(skillboardActivationCost(2)).toBe(6);
      expect(skillboardActivationCost(3)).toBe(6);
    });

    it("is 0 for EX, which has no activation threshold", () => {
      expect(skillboardActivationCost("ex")).toBe(0);
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
    it("seeds three groups in Builds-tab order", () => {
      const groups = defaultChecklist();
      expect(groups.map((group) => group.id)).toEqual(["build", "computed", "ai"]);
      expect(groups.map((group) => group.kind)).toEqual(["custom", "computed", "custom"]);
    });

    it("carries the i18n key for each seeded group name", () => {
      expect(defaultChecklist().map((group) => group.nameKey)).toEqual([
        "ui.checklist.sigils",
        "ui.checklist.computed",
        "ui.checklist.ai",
      ]);
    });

    it("parses hex trait ids into numbers and keeps multi-id entries intact", () => {
      const build = defaultChecklist().find((group) => group.id === "build")!;
      expect(build.entries).toHaveLength(13);
      const dmgCap = build.entries.find((entry) => entry.ids[0] === 0xdc584f60)!;
      expect(dmgCap.ids).toEqual([0xdc584f60, 0x0151cf9e, 0x3b71af12, 0xaefeb1bc, 0xfff8cf64]);
      expect(dmgCap.level).toBe(65);
      expect(defaultChecklist().find((group) => group.id === "ai")!.entries).toEqual([
        { ids: [0xa8a3163b], level: 15 },
      ]);
    });

    it("gives the computed group no entries", () => {
      expect(defaultChecklist().find((group) => group.id === "computed")!.entries).toEqual([]);
    });
  });

  describe("moveItem", () => {
    it("moves an item forward", () => {
      expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    });

    it("moves an item backward", () => {
      expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    });

    it("returns the input untouched for a no-op or out-of-range move", () => {
      const items = ["a", "b", "c"];
      expect(moveItem(items, 1, 1)).toEqual(items);
      expect(moveItem(items, 5, 0)).toEqual(items);
      expect(moveItem(items, 0, -1)).toEqual(items);
    });
  });

  describe("orderedChecklistEntries", () => {
    const entries = [
      { ids: [0xdc584f60], level: 65 },
      { ids: [0x95f3fa86], level: 15 },
    ];

    it("keeps stored order when the group is manually ordered", () => {
      expect(orderedChecklistEntries(entries, true)).toEqual(entries);
    });

    it("sorts by translated trait name otherwise", () => {
      // translateTraitId falls back to the hex id when the traits bundle is not
      // loaded in tests, so assert against that same ordering rule.
      const names = orderedChecklistEntries(entries, false).map((entry) => translateTraitId(entry.ids[0]) ?? "");
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it("does not mutate the input array", () => {
      const input = [...entries];
      orderedChecklistEntries(input, false);
      expect(input).toEqual(entries);
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

  describe("overmastery display amounts", () => {
    // limit_bonus_param stores Stun Power Up at a tenth of the number the game
    // shows: the kind-3 ladder is [0.1, 0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.6, 2]
    // and Lv7 (raw 1.0) reads "Stun Power Up +10" in game.
    it("scales Stun Power Up by 10 and shows it flat, not as a percent", () => {
      expect(overmasteryAmountFromKind(3, 1)).toEqual({ kind: "flat", amount: 10 });
      expect(overmasteryAmountFromKind(3, 2)).toEqual({ kind: "flat", amount: 20 });
      // 0x2676f9d2 / 0x6cb38ef3 are Stun Power Up ids on the record path.
      expect(overmasteryAmountFromId(0x2676f9d2, 1)).toEqual({ kind: "flat", amount: 10 });
      expect(overmasteryAmountFromId(0x6cb38ef3, 0.4)).toEqual({ kind: "flat", amount: 4 });
    });

    it("agrees with the summon table, which pre-multiplies the same effect", () => {
      // Both sides of a combined Builds line must share a scale before they sum.
      expect(summonBonusValue(0xf7b0316f, 0)).toEqual({ kind: "flat", amount: 2 });
      expect(overmasteryAmountFromKind(3, 0.2)).toEqual({ kind: "flat", amount: 2 });
    });

    it("keeps ATK / HP flat and every other effect a percent, unscaled", () => {
      expect(overmasteryAmountFromKind(0, 1000)).toEqual({ kind: "flat", amount: 1000 });
      expect(overmasteryAmountFromKind(1, 2000)).toEqual({ kind: "flat", amount: 2000 });
      expect(overmasteryAmountFromKind(2, 20)).toEqual({ kind: "percent", amount: 20 });
      // 100+ are the damage-type specials (Skill DMG Up, cap ups, Healing Cap Up).
      expect(overmasteryAmountFromKind(104, 16)).toEqual({ kind: "percent", amount: 16 });
    });

    it("classifies recorded overmasteries by id", () => {
      expect(overmasteryAmountFromId(0xc4925bd7, 1000)).toEqual({ kind: "flat", amount: 1000 }); // Attack Power Up
      expect(overmasteryAmountFromId(0x52a207b5, 2000)).toEqual({ kind: "flat", amount: 2000 }); // Health Up
      expect(overmasteryAmountFromId(0x45c65767, 20)).toEqual({ kind: "percent", amount: 20 }); // Crit Hit Rate Up
      expect(overmasteryAmountFromId(0x9c555433, 16)).toEqual({ kind: "percent", amount: 16 }); // Skill DMG Cap Up
    });

    it("covers every Stun Power Up id the lang table knows", () => {
      const stunIds = Object.entries(enOvermasteries)
        .filter(([, entry]) => entry.text === "Stun Power Up")
        .map(([id]) => parseInt(id, 16));

      expect(stunIds).toHaveLength(19);
      for (const id of stunIds) {
        expect(overmasteryAmountFromId(id, 1)).toEqual({ kind: "flat", amount: 10 });
      }
    });

    it("treats every Attack Power Up / Health Up id as flat", () => {
      const flatIds = Object.entries(enOvermasteries)
        .filter(([, entry]) => entry.text === "Attack Power Up" || entry.text === "Health Up")
        .map(([id]) => parseInt(id, 16));

      for (const id of flatIds) {
        expect(overmasteryAmountFromId(id, 500)).toEqual({ kind: "flat", amount: 500 });
      }
    });
  });

  describe("formatBonusAmount", () => {
    it("suffixes percents, leaves flat amounts bare, and parenthesises levels", () => {
      expect(formatBonusAmount({ kind: "flat", amount: 1800 })).toBe("+1800");
      expect(formatBonusAmount({ kind: "percent", amount: 20 })).toBe("+20%");
      expect(formatBonusAmount({ kind: "level", amount: 3 })).toBe("(Lvl. 3)");
    });

    it("formats a Lv7 Stun Power Up as the game's +10", () => {
      expect(formatBonusAmount(overmasteryAmountFromKind(3, 1))).toBe("+10");
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

  describe("hasQuestElapsedTime", () => {
    it("accepts a clear time the game really reported", () => {
      expect(hasQuestElapsedTime(92)).toBe(true);
    });

    it("rejects the constant 1s stored before the timer offset was fixed", () => {
      // The hook read the quest timer from the wrong offset and got 1 for every
      // quest, which rendered as a plausible-looking 00:01. A real logs.db has
      // 386 such rows against a smallest real clear time of 92s.
      expect(hasQuestElapsedTime(1)).toBe(false);
    });

    it("rejects a quest the game never reported a time for", () => {
      expect(hasQuestElapsedTime(0)).toBe(false);
      expect(hasQuestElapsedTime(null)).toBe(false);
      expect(hasQuestElapsedTime(undefined)).toBe(false);
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

    it("derives via family curve sharing when the hook reports a stale pre-ascension variant id", () => {
      // Online reads can carry the weapon's _06_02 row id (0xe3b35c0d,
      // Jumbo Crab log 542/544) alongside live levels from the true _06_03
      // form — the gen script shares each family's curves with its
      // curve-less sibling rows so the stage still derives.
      expect(deriveTranscendence(0xe3b35c0d, stage9Traits)).toBe(9);
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

    it("marks the debug tab active on its page without claiming the Logs tab", () => {
      expect(deriveNavState("/logs/debug")).toMatchObject({
        debugActive: true,
        logsActive: false,
        questsActive: false,
      });
      expect(deriveNavState("/logs")).toMatchObject({ debugActive: false });
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

  describe("resolveAvailableTab", () => {
    it("keeps a tab that is available", () => {
      expect(resolveAvailableTab("builds", ["overview", "sba", "equipment", "builds"], "overview")).toBe("builds");
    });

    it("falls back when the remembered tab is currently unavailable", () => {
      // A log with no player data disables the equipment/builds tabs; without
      // the fallback the page would render with no tab selected at all.
      expect(resolveAvailableTab("builds", ["overview", "sba"], "overview")).toBe("overview");
    });

    it("falls back on an unknown tab name", () => {
      expect(resolveAvailableTab("nonsense", ["overview", "sba"], "overview")).toBe("overview");
    });
  });
});

describe("mergeTargetBreakdowns", () => {
  it("merges same-enemy entries across skills and sorts by damage descending", () => {
    const merged = mergeTargetBreakdowns([
      [
        { enemyType: { Unknown: 0xaaaa }, hits: 2, totalDamage: 100 },
        { enemyType: { Unknown: 0xbbbb }, hits: 1, totalDamage: 500 },
      ],
      [{ enemyType: { Unknown: 0xaaaa }, hits: 3, totalDamage: 250 }],
    ]);

    expect(merged).toEqual([
      { enemyType: { Unknown: 0xbbbb }, hits: 1, totalDamage: 500 },
      { enemyType: { Unknown: 0xaaaa }, hits: 5, totalDamage: 350 },
    ]);
  });

  it("treats string and hash enemy types as distinct keys", () => {
    const merged = mergeTargetBreakdowns([
      [
        { enemyType: "Em1000", hits: 1, totalDamage: 10 },
        { enemyType: { Unknown: 0x1234 }, hits: 1, totalDamage: 20 },
      ],
    ]);

    expect(merged).toEqual([
      { enemyType: { Unknown: 0x1234 }, hits: 1, totalDamage: 20 },
      { enemyType: "Em1000", hits: 1, totalDamage: 10 },
    ]);
  });

  it("ignores missing breakdowns from logs saved by older app versions", () => {
    expect(mergeTargetBreakdowns([undefined])).toEqual([]);
    expect(mergeTargetBreakdowns([undefined, [{ enemyType: { Unknown: 1 }, hits: 1, totalDamage: 5 }]])).toEqual([
      { enemyType: { Unknown: 1 }, hits: 1, totalDamage: 5 },
    ]);
  });
});

describe("getBossHpTarget", () => {
  const enemy = (index: number, hp?: { current: number; max: number }, totalDamage = 0): EnemyState => ({
    index,
    targetType: { Unknown: 0 } as unknown as EnemyState["targetType"],
    totalDamage,
    currentHp: hp?.current,
    maxHp: hp?.max,
  });

  it("returns null when no target carries HP data", () => {
    expect(getBossHpTarget({})).toBeNull();
    expect(getBossHpTarget({ 1: enemy(1) })).toBeNull();
  });

  /** Regression: the backend serializes `Option<u64>::None` as JSON `null`, not as an
   * absent key, so a guard that only tested `undefined` let hp-less rows through and the
   * overlay header rendered `HP NaN% (0 / 0)` for the whole fight. */
  it("treats null HP the same as absent HP, as the backend actually sends it", () => {
    const nullHp = { ...enemy(1), currentHp: null, maxHp: null };
    expect(getBossHpTarget({ 1: nullHp })).toBeNull();
    expect(getBossHpTarget({ 1: nullHp, 2: enemy(2, { current: 5, max: 10 }) })?.index).toBe(2);
  });

  it("picks the target with the largest max HP among those with HP data", () => {
    const targets = {
      1: enemy(1, { current: 100, max: 1000 }),
      2: enemy(2, { current: 40_000_000, max: 50_000_000 }),
      3: enemy(3), // no HP data, even with more damage taken
    };
    expect(getBossHpTarget(targets)?.index).toBe(2);
  });

  it("skips dead targets so a finished boss doesn't pin the readout at 0%", () => {
    const targets = {
      1: enemy(1, { current: 0, max: 50_000_000 }), // killed, biggest pool
      2: enemy(2, { current: 30_000_000, max: 40_000_000 }),
      3: enemy(3, { current: 1_000_000, max: 2_000_000 }),
    };
    expect(getBossHpTarget(targets)?.index).toBe(2);
  });

  it("falls back to the largest pool once every known target is dead", () => {
    const targets = {
      1: enemy(1, { current: 0, max: 50_000_000 }),
      2: enemy(2, { current: 0, max: 40_000_000 }),
    };
    expect(getBossHpTarget(targets)?.index).toBe(1);
  });
});

describe("humanizeNumbers", () => {
  it("keeps a trailing zero so scaled values are always one decimal place", () => {
    expect(humanizeNumbers(400_000_000)).toEqual(["400.0", "m"]);
    expect(humanizeNumbers(2_000)).toEqual(["2.0", "k"]);
    expect(humanizeNumbers(1_500_000_000)).toEqual(["1.5", "b"]);
    expect(humanizeNumbers(3_000_000_000_000)).toEqual(["3.0", "t"]);
  });

  it("leaves sub-thousand values as whole numbers", () => {
    expect(humanizeNumbers(999)).toEqual(["999", ""]);
    expect(humanizeNumbers(0)).toEqual(["0", ""]);
  });
});

describe("damageOverTimeKeys", () => {
  it("prefers the type-specific name, per character then global", () => {
    expect(damageOverTimeKeys("Pl0100", "Pl0100", 0)).toEqual([
      "skills.Pl0100.damage-over-time-poison",
      "skills.Pl0100.damage-over-time-poison",
      "skills.Pl0100.damage-over-time",
      "skills.Pl0100.damage-over-time",
      "skills.default.damage-over-time-poison",
      "skills.default.damage-over-time",
    ]);
  });

  it("names each known DoT type", () => {
    const nameKey = (dotType: number) => damageOverTimeKeys("Pl0100", "Pl0100", dotType)[0];

    expect(nameKey(0)).toBe("skills.Pl0100.damage-over-time-poison");
    expect(nameKey(1)).toBe("skills.Pl0100.damage-over-time-burn");
    expect(nameKey(2)).toBe("skills.Pl0100.damage-over-time-darkburn");
  });

  it("keeps a character's own DoT name ahead of the generic type name", () => {
    // Id's DoT is flavoured "Darkflame (DoT)"; that override should still win over
    // the generic "Darkburn" once the type is known.
    const keys = damageOverTimeKeys("Pl1900", "Pl1900", 2);

    expect(keys.indexOf("skills.Pl1900.damage-over-time")).toBeLessThan(
      keys.indexOf("skills.default.damage-over-time-darkburn")
    );
  });

  it("falls back to the unnamed DoT keys for an unknown type", () => {
    expect(damageOverTimeKeys("Pl0100", "Pl0200", 7)).toEqual([
      "skills.Pl0200.damage-over-time",
      "skills.Pl0100.damage-over-time",
      "skills.default.damage-over-time",
    ]);
  });
});

describe("summon class sources in skill-name-sources.json", () => {
  const classes = skillNameSources["summon-classes"] as Record<
    string,
    { ns: string; hash: string; key: string; via?: string }
  >;

  it("keys every entry by a lowercase eight-digit hash", () => {
    // A mistyped or unpadded key never resolves, and the only symptom in game is
    // a row silently reading "Summon Attack" — invisible without this check.
    const bad = Object.keys(classes).filter((k) => !/^[0-9a-f]{8}$/.test(k));

    expect(bad).toEqual([]);
    expect(Object.keys(classes).length).toBeGreaterThan(0);
  });

  it("names the summon body classes the hook can attribute", () => {
    // The names themselves now come from each language's own summons.json; what
    // this file pins is which body class points at which game entry.
    // d2e5407a = Lucilius (So0000), 5395ce93 = Beelzebub (So9200).
    expect(classes["d2e5407a"]?.key).toBe("TXT_SMN_So0000");
    expect(classes["5395ce93"]?.key).toBe("TXT_SMN_So9200");
  });

  it("pairs every id-derived class with the So id that actually hashes to it", () => {
    // A body class is XXHash32Custom("So####"). Checking that identity here is
    // what stops a display-name collision from quietly mislabelling a row —
    // two different summons, and some enemies, share names.
    const mismatched = Object.entries(classes)
      .filter(([, source]) => source.via === "id")
      .filter(([classHash, source]) => {
        const soId = /^TXT_SMN_(So[0-9a-f]{4})(?:_\d+)?$/.exec(source.key)?.[1];
        return soId === undefined || gameXxhash32(soId) !== classHash;
      })
      .map(([classHash, source]) => `${classHash} -> ${source.key}`);

    expect(mismatched).toEqual([]);
  });

  it("marks the classes identity could not resolve so a patch review can find them", () => {
    // The Cat and Lilith bodies are not So#### summons, so they rest on a name
    // match. Their text agrees with the same-named summon in every shipped
    // language today, but that is a coincidence worth re-checking.
    const byName = Object.entries(classes)
      .filter(([, source]) => source.via === "name")
      .map(([classHash]) => classHash)
      .sort();

    expect(byName).toEqual(["0f617ff0", "9f394f85"]);
  });

  it("points every entry at a hash that resolves in the generated bundle", () => {
    // The regression net after a game patch renames a lang key.
    const bundles: Record<string, Record<string, { text?: string }>> = {
      summons: enSummons,
      enemies: enEnemies,
    };
    const broken = Object.entries(classes).filter(([, source]) => !bundles[source.ns]?.[source.hash]?.text);

    expect(broken).toEqual([]);
  });

  it("names the slimes by identity, so no hand-coined class is left in ui.json", () => {
    // 0x34894579 is the shared Silverslime/Goldslime body class, once labelled
    // "Silverslime/Goldslime" by hand because it names neither summon. The hook
    // now clears the body id's unit byte and publishes So2000 / So2100 instead,
    // which map here — the hand label, and the whole ui.json block, are gone.
    expect(classes["34894579"]).toBeUndefined();
    expect((enUi.skills as Record<string, unknown>)["summon-classes"]).toBeUndefined();

    expect(classes["2d179019"]?.key).toBe("TXT_SMN_So2000_2");
    expect(classes["6bca42ab"]?.key).toBe("TXT_SMN_So2100_2");
    expect(stripTierSuffix(enSummons[classes["2d179019"].hash as keyof typeof enSummons].text)).toBe("Silverslime");
    expect(stripTierSuffix(enSummons[classes["6bca42ab"].hash as keyof typeof enSummons].text)).toBe("Goldslime");
  });

  it("provides the generic label every unnamed body class falls back to", () => {
    expect(enUi.skills.default["80000"]).toBeTruthy();
  });
});

describe("ability sources in skill-name-sources.json", () => {
  const abilityBlocks = Object.entries(skillNameSources).filter(([block]) => block !== "summon-classes") as [
    string,
    Record<string, { ns: string; hash: string; key: string }>,
  ][];

  it("points every entry at a hash that resolves in en/abilities.json", () => {
    const broken = abilityBlocks.flatMap(([block, entries]) =>
      Object.entries(entries)
        .filter(([, source]) => !(enAbilities as Record<string, { text?: string }>)[source.hash]?.text)
        .map(([id]) => `${block}.${id}`)
    );

    expect(broken).toEqual([]);
  });

  it("scopes every ability key to its own character block", () => {
    // The scoping is what disambiguates a name shared by two hashes; a key from
    // another character would silently mislabel the row.
    const mismatched = abilityBlocks.flatMap(([block, entries]) =>
      Object.entries(entries)
        .filter(([, source]) => !source.key.startsWith(`AB_${block.toUpperCase()}_`))
        .map(([id, source]) => `${block}.${id} -> ${source.key}`)
    );

    expect(mismatched).toEqual([]);
  });

  it("never maps a row to a _CG cutscene variant", () => {
    const cg = Object.values(skillNameSources)
      .flatMap((entries) => Object.values(entries as Record<string, { key: string }>))
      .filter((source) => source.key.endsWith("_CG"));

    expect(cg).toEqual([]);
  });
});

describe("master-trait branch names in en/skillboard-branches.json", () => {
  const branches: Record<string, { key: string; text: string }> = enBranches;

  it("names all three branches for every character", () => {
    const byCharacter = new Map<string, string[]>();
    for (const name of Object.keys(branches)) {
      const [character, category] = name.split("_");
      byCharacter.set(character, [...(byCharacter.get(character) ?? []), category].sort());
    }

    expect(byCharacter.size).toBe(29);
    for (const [character, categories] of byCharacter) {
      expect([character, categories]).toEqual([character, ["atk", "def", "lim"]]);
    }
  });

  it("files each game key under the character and branch its id encodes", () => {
    // TXT_SB_NAME_PL####_SP000/100/200 — that hundreds digit is the same
    // category encoding the node ids use, so a mis-filed entry would put the
    // wrong name on a branch.
    for (const [name, entry] of Object.entries(branches)) {
      const match = /^TXT_SB_NAME_PL(\d{4})_SP(\d{3})$/.exec(entry.key);
      expect([entry.key, match !== null]).toEqual([entry.key, true]);

      const [, character, spId] = match!;
      const category = skillboardNodeMeta(Number(spId))!.category;
      expect([entry.key, name]).toEqual([entry.key, `pl${character}_${category}`]);
    }
  });

  it("carries the character's own branch titles", () => {
    // Pl2700 = Eustace.
    expect(branches["pl2700_atk"].text).toBe("Essence: Lightning Soldier");
    expect(branches["pl2700_def"].text).toBe("Insight: Keep Your Foes Closer");
    expect(branches["pl2700_lim"].text).toBe("Crux: Perfectionist");
  });
});

describe("barWidth", () => {
  it("returns the raw percentage in total mode", () => {
    expect(barWidth(42, 80, "total")).toBe(42);
  });

  it("ignores the max entirely in total mode", () => {
    expect(barWidth(42, 0, "total")).toBe(42);
  });

  it("scales against the largest row in relative mode", () => {
    expect(barWidth(40, 80, "relative")).toBe(50);
    expect(barWidth(80, 80, "relative")).toBe(100);
  });

  it("falls back to the raw percentage when there is no max to scale against", () => {
    // Nothing has dealt damage yet: divide-by-zero would render NaN%.
    expect(barWidth(0, 0, "relative")).toBe(0);
    expect(barWidth(12, 0, "relative")).toBe(12);
  });
});
