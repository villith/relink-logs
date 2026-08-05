import { describe, expect, it } from "vitest";

import type { ComputedPlayerState, EnemyType } from "@/types";

import type { MetricCard, MetricRow } from "../metrics/types";

import { cardSectionsFor } from "./cardSections";

/** What the damage tab measures. Spelled here rather than imported from the
 * descriptor so a change of heart there shows up as a failing expectation
 * instead of silently redefining what these cases assert. */
const DAMAGE_CARD: MetricCard = {
  amountKey: "ui.meter-columns.damage",
  valueOf: (s) => s.totalDamage,
  format: String,
  perTarget: true,
};

/** The stun tab: a different figure, and no per-enemy record to break down. */
const STUN_CARD: MetricCard = {
  amountKey: "ui.skill-columns.stun",
  valueOf: (s) => s.totalStunValue,
  format: String,
  perTarget: false,
};

const skill = (action: number, damage: number, hits: number) => ({
  actionType: { Normal: action },
  childCharacterType: "Pl1400",
  hits,
  minDamage: 10,
  maxDamage: 90,
  totalDamage: damage,
  // Deliberately NOT proportional to damage: a card reading the wrong field
  // would otherwise still produce plausible-looking ordering.
  totalStunValue: damage / 10,
  maxStunValue: 0,
  cappedHits: 0,
  cappableHits: 0,
  overcapBaseSum: 0,
  overcapCapSum: 0,
  targets: [
    { enemyType: "Em0003", hits, totalDamage: damage * 0.8 },
    // The Unknown variant is an object, not a string — it must key distinctly
    // from every other unknown, which a naive String() would not do.
    { enemyType: { Unknown: 7 }, hits, totalDamage: damage * 0.2 },
  ],
});

const PLAYERS = [
  {
    index: 0,
    partyIndex: 0,
    characterType: "Pl1400",
    totalDamage: 300,
    skillBreakdown: [skill(9001, 200, 20), skill(9002, 100, 10)],
  },
] as unknown as ComputedPlayerState[];

/** Two players who both used 9001, for the source section — which only says
 * anything when more than one player is in scope. */
const PARTY = [
  {
    index: 0,
    partyIndex: 0,
    characterType: "Pl1400",
    totalDamage: 300,
    skillBreakdown: [skill(9001, 200, 20), skill(9002, 100, 10)],
  },
  {
    index: 1,
    partyIndex: 1,
    characterType: "Pl1400",
    totalDamage: 50,
    skillBreakdown: [skill(9001, 50, 5)],
  },
] as unknown as ComputedPlayerState[];

const LABELS = {
  ability: (key: string) => `ability:${key}`,
  enemy: (type: EnemyType) => `enemy:${typeof type === "string" ? type : `unknown-${type.Unknown}`}`,
  source: (index: number) => `player:${index}`,
  sourceColor: (index: number) => `#00${index}`,
};

const row = (key: string): MetricRow => ({
  key,
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: 0,
});

const call = (level: "players" | "abilities" | "skills", key: string) =>
  cardSectionsFor({
    row: row(key),
    level,
    players: PLAYERS,
    pins: { source: 0, targets: [], ability: null },
    color: "rgb(1,2,3)",
    labels: LABELS,
    card: DAMAGE_CARD,
  });

const callWith = (
  level: "players" | "abilities" | "skills",
  key: string,
  pins: { source: number | null; targets: number[]; ability: string | null },
  players = PARTY
) =>
  cardSectionsFor({
    row: row(key),
    level,
    players,
    pins,
    color: "rgb(1,2,3)",
    labels: LABELS,
    card: DAMAGE_CARD,
  });

describe("cardSectionsFor", () => {
  it("gives a player row its abilities and its targets", () => {
    const sections = call("players", "player:0");
    expect(sections?.map((s) => s.headingKey)).toEqual(["ui.logs.hover-by-ability", "ui.logs.hover-by-target"]);
  });

  it("orders a player's abilities biggest first", () => {
    const sections = call("players", "player:0");
    expect(sections?.[0].entries.map((e) => e.value)).toEqual([200, 100]);
  });

  it("sums skills that share an ability key into one row", () => {
    // The parser can emit more than one SkillState per action id, so mapping
    // 1:1 draws the same ability twice with its damage split between the rows
    // — and hands React two children with the same key. Measured live on log
    // 544: "Link Attack" and "Light Blast" both appeared twice.
    const players = [
      {
        index: 0,
        partyIndex: 0,
        characterType: "Pl1400",
        totalDamage: 300,
        skillBreakdown: [skill(9001, 200, 20), skill(9001, 50, 5), skill(9002, 50, 5)],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
      card: DAMAGE_CARD,
    });

    const abilities = sections?.[0].entries ?? [];
    expect(abilities.map((e) => e.key)).toEqual(["Normal:9001", "Normal:9002"]);
    expect(abilities.map((e) => e.value)).toEqual([250, 50]);
  });

  it("names a player row's abilities for that player, not the first party member to share the id", () => {
    // Action ids collide across characters (120 is Eustace's "Grade 1 Shot"
    // AND Id's "Combo Finisher (Dragonform)"), and the party-order scan named
    // Id's own 120 with Eustace's skill on the hover card. The card knows
    // exactly whose breakdown it is decomposing, so it must say so.
    const owners: unknown[] = [];
    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players: PLAYERS,
      pins: { source: null, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: {
        ...LABELS,
        ability: (key, owner) => {
          owners.push(owner);
          return `ability:${key}`;
        },
      },
      card: DAMAGE_CARD,
    });

    expect(sections?.[0].entries.length).toBeGreaterThan(0);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every((owner) => owner === PLAYERS[0])).toBe(true);
  });

  it("merges a player's targets across every ability, biggest first", () => {
    // Em0003 takes 0.8 of both skills: 160 + 80. The unknown takes 0.2: 40 + 20.
    const sections = call("players", "player:0");
    expect(sections?.[1].entries).toEqual([
      { key: '"Em0003"', label: "enemy:Em0003", value: 240 },
      { key: '{"Unknown":7}', label: "enemy:unknown-7", value: 60 },
    ]);
  });

  it("keys unknown enemies apart from each other", () => {
    // String({Unknown: n}) is "[object Object]" for every n, which would merge
    // every unidentified spawn into one row.
    const players = [
      {
        index: 0,
        partyIndex: 0,
        characterType: "Pl1400",
        totalDamage: 30,
        skillBreakdown: [
          {
            ...skill(9001, 30, 3),
            targets: [
              { enemyType: { Unknown: 1 }, hits: 1, totalDamage: 20 },
              { enemyType: { Unknown: 2 }, hits: 1, totalDamage: 10 },
            ],
          },
        ],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
      card: DAMAGE_CARD,
    });

    expect(sections?.[1].entries.map((e) => e.value)).toEqual([20, 10]);
  });

  it("gives an ability row its targets, and nothing else", () => {
    // No Source section: the abilities level is only reached with a source
    // already pinned, so it would always be one row at 100%. No hit-statistics
    // section either — every section here renders as a share and a bar, which
    // is meaningless over min/max/avg, so those live in the table's columns.
    const sections = call("abilities", "skill:Normal:9001");
    expect(sections?.map((s) => s.headingKey)).toEqual(["ui.logs.hover-by-target"]);
  });

  it("explains an ability with every skill behind it, not just the first", () => {
    // The row above the card sums the skills sharing an ability key, so a card
    // built from one of them describes a fraction of what the row reports.
    const players = [
      {
        index: 0,
        partyIndex: 0,
        characterType: "Pl1400",
        totalDamage: 250,
        skillBreakdown: [skill(9001, 200, 20), skill(9001, 50, 5)],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("skill:Normal:9001"),
      level: "abilities",
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
      card: DAMAGE_CARD,
    });

    // Targets merge across both, so the section totals the ability's damage.
    expect(sections?.[0].entries.reduce((sum, e) => sum + e.value, 0)).toBe(250);
  });

  it("gives an unknown skills row no card", () => {
    expect(call("skills", "skill:Normal:404")).toBeNull();
  });

  it("gives an unknown row no card", () => {
    expect(call("players", "player:99")).toBeNull();
  });

  it("numbers a player's targets per spawn when the entries carry segments", () => {
    // Two spawns of ONE type must be two rows named like the table's target
    // rows — not merged into a type row the table would contradict.
    const players = [
      {
        index: 0,
        partyIndex: 0,
        characterType: "Pl1400",
        totalDamage: 100,
        skillBreakdown: [
          {
            ...skill(9001, 100, 10),
            targets: [
              { enemyType: "Em0003", segment: 0, hits: 5, totalDamage: 60 },
              { enemyType: "Em0003", segment: 1, hits: 5, totalDamage: 40 },
            ],
          },
        ],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: { ...LABELS, target: (segment: number) => `spawn:${segment}` },
      card: DAMAGE_CARD,
    });

    expect(sections?.[1].entries).toEqual([
      { key: "target:0", label: "spawn:0", value: 60, icon: undefined },
      { key: "target:1", label: "spawn:1", value: 40, icon: undefined },
    ]);
  });

  it("falls back to the un-numbered type for entries that predate the segment field", () => {
    // The fixture's targets carry no segment — an old cached payload. The
    // spawn labeler being INJECTED must not change how those render.
    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players: PLAYERS,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: { ...LABELS, target: (segment: number) => `spawn:${segment}` },
      card: DAMAGE_CARD,
    });

    expect(sections?.[1].entries.map((entry) => entry.label)).toEqual(["enemy:Em0003", "enemy:unknown-7"]);
  });
});

describe("cardSectionsFor at the skills level", () => {
  const ABILITY_ONLY = { source: null, targets: [] as number[], ability: "Normal:9001" };

  it("explains a member skill by source and then by target", () => {
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    expect(sections?.map((section) => section.headingKey)).toEqual([
      "ui.logs.hover-by-source",
      "ui.logs.hover-by-target",
    ]);
  });

  it("sums one action across every player who used it, biggest first", () => {
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    expect(sections?.[0].entries.map((entry) => entry.label)).toEqual(["player:0", "player:1"]);
    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([200, 50]);
  });

  it("colours each source entry with that player's own colour", () => {
    // The section carries one colour for all its rows, so a per-player section
    // needs the ENTRY to carry it — a party section in one colour says nothing.
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    expect(sections?.[0].entries.map((entry) => entry.color)).toEqual(["#000", "#001"]);
  });

  it("leaves out a player who never used the skill", () => {
    const sections = callWith("skills", "skill:Normal:9002", ABILITY_ONLY);

    expect(sections?.[0].entries.map((entry) => entry.label)).toEqual(["player:0"]);
  });

  it("still shows the source section when a friendly is pinned", () => {
    // One row at 100%. Shown anyway: Warcraft Logs does, and suppressing it
    // makes the card change shape as the friendly pin comes and goes.
    // With a friendly pinned the scoped party holds only that player, so the
    // section is a single row — which is exactly the case being kept.
    const sections = callWith("skills", "skill:Normal:9001", { source: 0, targets: [], ability: "Normal:9001" }, [
      PARTY[0],
    ]);

    expect(sections?.[0].headingKey).toBe("ui.logs.hover-by-source");
    expect(sections?.[0].entries).toHaveLength(1);
  });

  it("totals the targets across every player's copy of the skill", () => {
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    // 250 damage total, split 80/20 across the two target rows by the fixture.
    expect(sections?.[1].entries.reduce((sum, entry) => sum + entry.value, 0)).toBe(250);
  });

  it("returns null for a row no player's breakdown holds", () => {
    expect(callWith("skills", "skill:Normal:404", ABILITY_ONLY)).toBeNull();
  });
});

describe("the card follows the metric", () => {
  // The card read `SkillState.totalDamage` whatever the tab, so a stun bar's
  // tooltip explained it with damage figures under a "DMG" heading.
  const stun = (level: "players" | "abilities" | "skills", key: string, players = PLAYERS) =>
    cardSectionsFor({
      row: row(key),
      level,
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
      card: STUN_CARD,
    });

  it("reads the metric's own figure off each breakdown row", () => {
    // The fixture's stun is damage/10, so reading the wrong field is a factor
    // of ten out rather than a plausible-looking reordering.
    const sections = stun("players", "player:0");
    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([20, 10]);
  });

  it("omits the by-target section where the metric has no per-enemy record", () => {
    // SkillTargetState carries damage and hits only. A "Target" section here
    // could only be filled from the damage figures — the original defect, one
    // level down — and an empty one would suggest the ability hit nothing.
    expect(stun("players", "player:0")?.map((section) => section.headingKey)).toEqual(["ui.logs.hover-by-ability"]);
  });

  it("gives an ability row no card at all when by-target is its only section", () => {
    // The abilities level offers targets and nothing else, so a metric with no
    // per-enemy record has nothing to say there.
    expect(stun("abilities", "skill:Normal:9001")).toBeNull();
  });

  it("keeps the source section on a member skill, measured in the metric", () => {
    const sections = cardSectionsFor({
      row: row("skill:Normal:9001"),
      level: "skills",
      players: PARTY,
      pins: { source: null, targets: [], ability: "Normal:9001" },
      color: "rgb(1,2,3)",
      labels: LABELS,
      card: STUN_CARD,
    });

    expect(sections?.map((section) => section.headingKey)).toEqual(["ui.logs.hover-by-source"]);
    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([20, 5]);
  });
});
