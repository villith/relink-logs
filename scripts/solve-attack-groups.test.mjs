import { describe, expect, it } from "vitest";

import {
  alignOffset,
  auditBankedMemberships,
  bank,
  explainAction,
  joinHits,
  parseOracleLine,
  solve,
  splitSessions,
  stableCounts,
  subtractCounts,
  termPercents,
} from "./solve-attack-groups.mjs";

// A real-shaped new-format line (agg/om present) and an old-format one
// (pre-aggregate build: nothing after buffs). Both appear in one extract file,
// because the hook was rebuilt mid-day.
const NEW_LINE =
  "[INFO hook::hooks::cap_oracle] CAPORACLE t=893844 inst=0x7ff7f7b6f980 action=1400 rate=33.000 " +
  "class_flags=0x10002 cap=9587135 floor=4294967295 " +
  "terms=[0x61418d8:0x2:0.150000,0x61418d8:0x2:0.450000,0x61418d8:0x22:0.100000] " +
  "buffs=[125:0.050000] agg=[0:0x2:4.849999,1:0x2:0.000000] " +
  "drift_up=0.000000 drift_down=0.000000 om=[sel:skill:16.359999,n:14.580000,s:16.359999,b:13.639999]";
const OLD_LINE =
  "[INFO hook::hooks::cap_oracle] CAPORACLE t=162303 inst=0x7ff61226f980 action=1700 rate=1.100 " +
  "class_flags=0x10008 cap=295541 floor=4294967295 " +
  "terms=[0x61418d8:0x2:0.350000,0x61418d8:0x2:0.450000] buffs=[]";

describe("parseOracleLine", () => {
  it("parses the current format, terms itemized, agg/om ignored", () => {
    const record = parseOracleLine(NEW_LINE);
    expect(record).toMatchObject({
      t: 893844,
      action: 1400,
      cap: 9587135,
      rate: "33.000",
      classFlags: 0x10002,
    });
    expect(record.terms).toEqual([
      { rva: 0x61418d8, paramId: 2, value: 0.15 },
      { rva: 0x61418d8, paramId: 2, value: 0.45 },
      { rva: 0x61418d8, paramId: 0x22, value: 0.1 },
    ]);
  });

  it("parses the pre-aggregate format that ends at buffs", () => {
    const record = parseOracleLine(OLD_LINE);
    expect(record.t).toBe(162303);
    expect(record.terms).toHaveLength(2);
  });

  it("returns null for unrelated log lines", () => {
    expect(parseOracleLine("[INFO hook::hooks::damage] something else")).toBeNull();
  });
});

describe("splitSessions", () => {
  it("starts a new session when the hook-relative clock resets", () => {
    const records = [{ t: 100_000 }, { t: 900_000 }, { t: 5_000 }, { t: 6_000 }];
    expect(splitSessions(records).map((s) => s.length)).toEqual([2, 2]);
  });

  it("tolerates async-logger jitter: a small backwards step is not a reset", () => {
    // Lines from different game threads interleave slightly out of order in
    // the log file; only a drop back toward zero is a new hook process.
    const records = [{ t: 100_000 }, { t: 900_000 }, { t: 899_400 }, { t: 901_000 }];
    expect(splitSessions(records).map((s) => s.length)).toEqual([4]);
  });
});

describe("alignOffset", () => {
  // Keys unique on both sides vote for the offset; a stray coincidental match
  // far from the cluster must not drag the estimate.
  it("recovers the clock offset from uniquely-keyed hits", () => {
    const oracle = [1000, 2000, 3000, 4000, 5000].map((t, i) => ({ t, key: `k${i}` }));
    const events = [
      ...[1000, 2000, 3000, 4000].map((t, i) => ({ t: t + 500_000, key: `k${i}` })),
      { t: 999_999_999, key: "k4" },
    ];
    const aligned = alignOffset(oracle, events, { minSupport: 3 });
    expect(aligned.offset).toBe(500_000);
    expect(aligned.support).toBe(4);
  });

  it("refuses an alignment with too little support", () => {
    const oracle = [{ t: 1, key: "a" }];
    const events = [{ t: 100, key: "a" }];
    expect(alignOffset(oracle, events, { minSupport: 3 })).toBeNull();
  });

  it("recovers the offset when no key is unique, via the pair histogram", () => {
    // A combo-heavy fight: every key repeats, so unique-key voting has zero
    // votes — but each event still has its true partner at a constant offset,
    // and mispairings scatter across the fight instead of clustering.
    const oracle = [
      { t: 1000, key: "a" },
      { t: 41_000, key: "a" },
      { t: 90_000, key: "a" },
      { t: 2000, key: "b" },
      { t: 55_000, key: "b" },
      { t: 130_000, key: "b" },
    ];
    const events = oracle.map(({ t, key }) => ({ t: t + 500_000, key }));
    const aligned = alignOffset(oracle, events, { minSupport: 3 });
    expect(aligned).not.toBeNull();
    expect(aligned.offset).toBe(500_000);
  });
});

describe("joinHits", () => {
  it("matches one-to-one by key and nearest aligned time, dropping strays", () => {
    const oracle = [
      { t: 1000, key: "a" },
      { t: 1150, key: "a" },
      { t: 2000, key: "b" },
    ];
    const events = [
      { t: 501_000, key: "a" },
      { t: 501_160, key: "a" },
      { t: 900_000, key: "b" },
    ];
    const pairs = joinHits(oracle, events, 500_000, 750);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => [p.oracle.t, p.event.t])).toEqual([
      [1000, 501_000],
      [1150, 501_160],
    ]);
  });
});

describe("multiset helpers", () => {
  it("termPercents keeps only cap-up terms, as integer percents", () => {
    const record = parseOracleLine(NEW_LINE);
    expect(termPercents(record)).toEqual([15, 45]);
  });

  it("stableCounts keeps what every hit of the action carried", () => {
    // Second hit gained a transient +10 (an hp-gated trait crossing its
    // threshold) — the stable part is what group membership can rest on.
    const stable = stableCounts([
      [15, 30, 30],
      [10, 15, 30, 30],
      [15, 30, 30],
    ]);
    expect(stable).toEqual(
      new Map([
        [15, 1],
        [30, 2],
      ])
    );
  });

  it("subtractCounts removes the baseline, keeping multiplicity", () => {
    const delta = subtractCounts(
      new Map([
        [15, 1],
        [30, 2],
        [45, 1],
      ]),
      new Map([
        [15, 1],
        [30, 1],
      ])
    );
    expect(delta).toEqual(
      new Map([
        [30, 1],
        [45, 1],
      ])
    );
  });
});

describe("explainAction", () => {
  // Eustace's real shape: group 15 carries TWO +30 nodes, group 16 ONE +30,
  // group 17 one +40. A residual of {30×2} is group 15 alone — multiplicity
  // separates what value alone cannot.
  const groupValues = new Map([
    [15, [30, 30]],
    [16, [30]],
    [17, [40]],
  ]);

  it("assigns the unique group subset that reproduces the residual", () => {
    const result = explainAction(new Map([[30, 2]]), groupValues, new Set());
    expect(result.groups).toEqual([15]);
    expect(result.flags).toEqual([]);
  });

  it("assigns a multi-group subset when only that union fits", () => {
    const result = explainAction(
      new Map([
        [30, 3],
        [40, 1],
      ]),
      groupValues,
      new Set()
    );
    expect(result.groups).toEqual([15, 16, 17]);
  });

  it("flags instead of guessing when two subsets fit", () => {
    // {30×1} is group 15-half? No — subsets are all-or-nothing, so {30×1} is
    // ONLY group 16... unless group 15 had one node. Make it ambiguous:
    const ambiguous = new Map([
      [15, [30]],
      [16, [30]],
    ]);
    const result = explainAction(new Map([[30, 1]]), ambiguous, new Set());
    expect(result.groups).toBeNull();
    expect(result.flags).toContain("ambiguous-subset");
  });

  it("flags a residual no subset reproduces", () => {
    const result = explainAction(new Map([[25, 1]]), groupValues, new Set());
    expect(result.groups).toBeNull();
    expect(result.flags).toContain("unexplained-residual");
  });

  it("flags when a conditional source shares a residual value", () => {
    // A charge-graded trait worth +30 could masquerade as the group node.
    const result = explainAction(new Map([[30, 2]]), groupValues, new Set([30]));
    expect(result.groups).toBeNull();
    expect(result.flags).toContain("confounded-value");
  });

  it("reports an empty residual as membership in no group", () => {
    const result = explainAction(new Map(), groupValues, new Set());
    expect(result.groups).toEqual([]);
    expect(result.flags).toEqual([]);
  });
});

describe("confounder refinement in solve", () => {
  // Eustace's real shape: a counted "+20% per Basic sigil" node is worth 40
  // with two sigils equipped — but a sigil count is STATIC for the whole
  // fight, so it sits in the baseline and can never explain an action-scoped
  // delta. It must not block the +40 group node.
  const oracleText = [
    "[X] CAPORACLE t=1000 inst=0x1 action=100 rate=1.000 class_flags=0x0 cap=100000 floor=1 terms=[0x61418d8:0x2:0.400000] buffs=[]",
    "[X] CAPORACLE t=2000 inst=0x1 action=100 rate=1.100 class_flags=0x0 cap=100000 floor=1 terms=[0x61418d8:0x2:0.400000] buffs=[]",
    "[X] CAPORACLE t=3000 inst=0x1 action=130 rate=3.000 class_flags=0x0 cap=300000 floor=1 terms=[0x61418d8:0x2:0.400000,0x61418d8:0x2:0.400000] buffs=[]",
    "[X] CAPORACLE t=4000 inst=0x1 action=130 rate=3.100 class_flags=0x0 cap=300000 floor=1 terms=[0x61418d8:0x2:0.400000,0x61418d8:0x2:0.400000] buffs=[]",
  ].join("\n");

  const hits = (statuses) => [
    { t: 501_000, actor: 1, action: 100, cap: 100000, rate: 1, classFlags: 0, summon: false, statuses },
    { t: 502_000, actor: 1, action: 100, cap: 100000, rate: 1.1, classFlags: 0, summon: false, statuses },
    { t: 503_000, actor: 1, action: 130, cap: 300000, rate: 3, classFlags: 0, summon: false, statuses },
    { t: 504_000, actor: 1, action: 130, cap: 300000, rate: 3.1, classFlags: 0, summon: false, statuses },
  ];
  const evidenceWith = (nodeIds, statuses) => ({
    logs: [
      {
        id: 43,
        players: [
          { actorIndex: 1, characterType: "Pl2700", skillboard: nodeIds, sigils: [], summons: [] },
          null,
          null,
          null,
        ],
        hits: hits(statuses),
      },
    ],
  });
  const baseAssets = (extraNodes) => ({
    nodes: {
      pl2700_0032: {
        effects: [
          { stat: "cap", percent: 40, capClass: null, scope: "attack-group", targetAttackGroup: 17, abilityIds: [] },
        ],
      },
      ...extraNodes,
    },
    skillNameSources: {},
    capUpSources: { conditionalTraits: {}, conditionalTraitInputs: {}, traits: {}, transcendedTraits: {} },
  });

  it("a sigil-counted node does not confound an action-scoped residual", () => {
    const assets = baseAssets({
      pl2700_0023: {
        effects: [
          { stat: "cap", percent: 20, capClass: "all", scope: "counted", countKind: "basic-sigil", maxCount: 5 },
        ],
      },
    });
    const result = solve(oracleText, evidenceWith([0x32, 0x23], []), assets, { minSupport: 2 });
    expect(result.assignments).toEqual({ pl2700: { 17: [130] } });
  });

  it("a quest-counter counted node still confounds", () => {
    const assets = baseAssets({
      pl2700_0023: {
        effects: [
          { stat: "cap", percent: 40, capClass: "all", scope: "counted", countKind: "quest-counter", maxCount: 1 },
        ],
      },
    });
    const result = solve(oracleText, evidenceWith([0x32, 0x23], []), assets, { minSupport: 2 });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "confounded-value")).toBe(true);
  });

  it("a gated node whose status the snapshot never shows does not confound", () => {
    const assets = baseAssets({
      pl2700_0040: {
        effects: [{ stat: "cap", percent: 40, capClass: null, scope: "gated", gateKind: "status", gateStatusId: 77 }],
      },
    });
    // Snapshots captured on every hit, status 77 never up.
    const result = solve(oracleText, evidenceWith([0x32, 0x40], [{ statusId: 25, stacks: 1 }]), assets, {
      minSupport: 2,
    });
    // 130's membership comes from its residual; 100's from baseline
    // attribution — its every hit carried the 40 with no always-node or
    // unruled confounder to explain it, so the group holds it too.
    expect(result.assignments).toEqual({ pl2700: { 17: [100, 130] } });
  });

  it("a gated node stays a confounder when its status was up on every hit", () => {
    const assets = baseAssets({
      pl2700_0040: {
        effects: [{ stat: "cap", percent: 40, capClass: null, scope: "gated", gateKind: "status", gateStatusId: 77 }],
      },
    });
    const result = solve(oracleText, evidenceWith([0x32, 0x40], [{ statusId: 77, stacks: 1 }]), assets, {
      minSupport: 2,
    });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "confounded-value")).toBe(true);
  });

  it("a gated node stays a confounder when snapshots were not captured", () => {
    const assets = baseAssets({
      pl2700_0040: {
        effects: [{ stat: "cap", percent: 40, capClass: null, scope: "gated", gateKind: "status", gateStatusId: 77 }],
      },
    });
    const result = solve(oracleText, evidenceWith([0x32, 0x40], null), assets, { minSupport: 2 });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "confounded-value")).toBe(true);
  });
});

describe("solve", () => {
  // Two actions of one character: 2000 carries the group-20 +35 on top of the
  // shared baseline {15}; 1000 is baseline only. The move-scoped +45 on 1700
  // must be explained by the bridge, not banked as a group.
  const oracleText = [
    "[X] CAPORACLE t=1000 inst=0x1 action=1000 rate=1.000 class_flags=0x10000 cap=100000 floor=1 terms=[0x61418d8:0x2:0.150000] buffs=[]",
    "[X] CAPORACLE t=2000 inst=0x1 action=2000 rate=2.000 class_flags=0x10000 cap=200000 floor=1 terms=[0x61418d8:0x2:0.150000,0x61418d8:0x2:0.350000] buffs=[]",
    "[X] CAPORACLE t=3000 inst=0x1 action=1700 rate=3.000 class_flags=0x10000 cap=300000 floor=1 terms=[0x61418d8:0x2:0.150000,0x61418d8:0x2:0.450000] buffs=[]",
    "[X] CAPORACLE t=4000 inst=0x1 action=1000 rate=1.000 class_flags=0x10000 cap=100000 floor=1 terms=[0x61418d8:0x2:0.150000] buffs=[]",
  ].join("\n");

  const evidence = {
    logs: [
      {
        id: 42,
        players: [
          {
            actorIndex: 1,
            characterType: "Pl2700",
            skillboard: [0x0085, 0x0001, 0x0097],
            sigils: [],
            summons: [],
          },
          null,
          null,
          null,
        ],
        hits: [
          { t: 501_000, actor: 1, action: 1000, cap: 100000, rate: 1, classFlags: 0x10000, summon: false },
          { t: 502_000, actor: 1, action: 2000, cap: 200000, rate: 2, classFlags: 0x10000, summon: false },
          { t: 503_000, actor: 1, action: 1700, cap: 300000, rate: 3, classFlags: 0x10000, summon: false },
          { t: 504_000, actor: 1, action: 1000, cap: 100000, rate: 1, classFlags: 0x10000, summon: false },
        ],
      },
    ],
  };

  const assets = {
    nodes: {
      // group-scoped, group 20, +35
      pl2700_0085: {
        effects: [
          { stat: "cap", percent: 35, capClass: null, scope: "attack-group", targetAttackGroup: 20, abilityIds: [] },
        ],
      },
      // always-on +15: the baseline every action carries
      pl2700_0001: { effects: [{ stat: "cap", percent: 15, capClass: null, scope: "always" }] },
      // move-scoped +45 bridged to action 1700
      pl2700_0097: {
        effects: [
          {
            stat: "cap",
            percent: 45,
            capClass: "skill",
            scope: "attack-group",
            targetAttackGroup: 10,
            abilityIds: ["aea6d151"],
          },
        ],
      },
    },
    skillNameSources: { Pl2700: { 1700: { ns: "abilities", hash: "aea6d151" } } },
    capUpSources: { conditionalTraits: {}, conditionalTraitInputs: {}, traits: {}, transcendedTraits: {} },
  };

  it("rejects a log the capture never saw instead of force-joining it", () => {
    const foreign = structuredClone(evidence);
    foreign.logs[0].hits = foreign.logs[0].hits.map((hit) => ({ ...hit, cap: hit.cap + 7 }));
    const result = solve(oracleText, foreign, assets, { minSupport: 2, minHitsPerAction: 1 });
    expect(result.stats.logs[0]).toMatchObject({ id: 42, aligned: false });
    expect(result.assignments).toEqual({});
  });

  it("accepts a low-vote alignment when the join itself is near-total", () => {
    // Two of the four actions repeat in a short fight, so unique-key support
    // is only 2 — but the offset joins every hit, which is the real proof.
    const result = solve(oracleText, evidence, assets, { minSupport: 5, minHitsPerAction: 1 });
    expect(result.stats.logs[0]).toMatchObject({ aligned: true, joined: 4 });
  });

  it("banks the group action and explains the bridged move without claiming it", () => {
    const result = solve(oracleText, evidence, assets, { minSupport: 2, minHitsPerAction: 1 });
    expect(result.assignments).toEqual({ pl2700: { 20: [2000] } });
    // 1700's +45 resolved through the bridge — no flag, no group claim.
    const flagged = result.flags.filter((f) => f.action === 1700);
    expect(flagged).toEqual([]);
  });
});

describe("auditBankedMemberships", () => {
  // Eustace's real shape again: group 15 carries [30, 30], 16 [30], 17 [40].
  const groupValues = new Map([
    [15, [30, 30]],
    [16, [30]],
    [17, [40]],
  ]);

  it("passes when the stable multiset carries every banked group's values", () => {
    const stable = new Map([
      [30, 3],
      [40, 1],
    ]);
    const { checked, missing } = auditBankedMemberships(stable, [15, 16, 17], groupValues);
    expect(checked).toEqual([15, 16, 17]);
    expect(missing).toEqual([]);
  });

  it("demands the SUM across banked groups, not each individually", () => {
    // 15 [30,30] and 16 [30] together need 30×3; 30×2 satisfies each alone,
    // but the groups fire together, so 30×2 contradicts the pair.
    const { missing } = auditBankedMemberships(new Map([[30, 2]]), [15, 16], groupValues);
    expect(missing).toEqual([{ value: 30, shortfall: 1 }]);
  });

  it("skips banked groups with no unlocked node — absence is not evidence", () => {
    // The Tweyen lesson: 4 of her 7 group nodes were locked; a banked group
    // whose node is absent from this loadout predicts nothing.
    const { checked, missing } = auditBankedMemberships(new Map(), [19], groupValues);
    expect(checked).toEqual([]);
    expect(missing).toEqual([]);
  });
});

describe("contradiction audit in solve", () => {
  // Character with one group-only node: group 17, +40 (pl2700_0032).
  const assets = {
    nodes: {
      pl2700_0032: {
        effects: [
          { stat: "cap", percent: 40, capClass: null, scope: "attack-group", targetAttackGroup: 17, abilityIds: [] },
        ],
      },
    },
    skillNameSources: {},
    capUpSources: { conditionalTraits: {}, conditionalTraitInputs: {}, traits: {}, transcendedTraits: {} },
  };
  const evidenceWith = (nodeIds, hits) => ({
    logs: [
      {
        id: 77,
        players: [
          { actorIndex: 1, characterType: "Pl2700", skillboard: nodeIds, sigils: [], summons: [] },
          null,
          null,
          null,
        ],
        hits,
      },
    ],
  });
  const line = (t, action, rate, cap, terms) =>
    `[X] CAPORACLE t=${t} inst=0x1 action=${action} rate=${rate} class_flags=0x0 cap=${cap} floor=1 terms=[${terms}] buffs=[]`;

  it("flags banked-but-absent when an unlocked banked group's value never fires", () => {
    // Bank claims action 100 ∈ group 17, node unlocked — yet no hit of 100
    // carried the +40. A single observed action suffices: the check is on the
    // raw stable multiset, no baseline needed.
    const oracleText = [line(1000, 100, "1.000", 100000, ""), line(2000, 100, "1.100", 100000, "")].join("\n");
    const hits = [
      { t: 501_000, actor: 1, action: 100, cap: 100000, rate: 1, classFlags: 0, summon: false },
      { t: 502_000, actor: 1, action: 100, cap: 100000, rate: 1.1, classFlags: 0, summon: false },
    ];
    const banked = { pl2700: { groups: { 17: { actionIds: [100], evidence: "manual:button-map 2026-08-10" } } } };
    const result = solve(oracleText, evidenceWith([0x32], hits), assets, { minSupport: 2, banked });
    expect(result.flags).toContainEqual({
      log: 77,
      character: "pl2700",
      action: 100,
      capClass: "normal",
      flag: "banked-but-absent",
      groups: [17],
      missing: [{ value: 40, shortfall: 1 }],
    });
  });

  it("does not flag a banked group whose node is locked in this loadout", () => {
    const oracleText = [line(1000, 100, "1.000", 100000, ""), line(2000, 100, "1.100", 100000, "")].join("\n");
    const hits = [
      { t: 501_000, actor: 1, action: 100, cap: 100000, rate: 1, classFlags: 0, summon: false },
      { t: 502_000, actor: 1, action: 100, cap: 100000, rate: 1.1, classFlags: 0, summon: false },
    ];
    const banked = { pl2700: { groups: { 17: { actionIds: [100], evidence: "manual:button-map 2026-08-10" } } } };
    const result = solve(oracleText, evidenceWith([], hits), assets, { minSupport: 2, banked });
    expect(result.flags.filter((f) => f.flag === "banked-but-absent")).toEqual([]);
  });

  const twoActionOracle = [
    line(1000, 100, "1.000", 100000, ""),
    line(2000, 100, "1.100", 100000, ""),
    line(3000, 130, "3.000", 300000, "0x61418d8:0x2:0.400000"),
    line(4000, 130, "3.100", 300000, "0x61418d8:0x2:0.400000"),
  ].join("\n");
  const twoActionHits = [
    { t: 501_000, actor: 1, action: 100, cap: 100000, rate: 1, classFlags: 0, summon: false },
    { t: 502_000, actor: 1, action: 100, cap: 100000, rate: 1.1, classFlags: 0, summon: false },
    { t: 503_000, actor: 1, action: 130, cap: 300000, rate: 3, classFlags: 0, summon: false },
    { t: 504_000, actor: 1, action: 130, cap: 300000, rate: 3.1, classFlags: 0, summon: false },
  ];

  it("flags observed-but-unbanked when the residual matches a group the bank denies", () => {
    // The bank has group 17 with OTHER actions only; observation derives 130
    // into it. The membership still banks (evidence accumulates) — the flag is
    // the safety net for the inferred button-map entries.
    const banked = {
      pl2700: { groups: { 17: { actionIds: [999], evidence: "manual:button-map 2026-08-10 (partly inferred)" } } },
    };
    const result = solve(twoActionOracle, evidenceWith([0x32], twoActionHits), assets, { minSupport: 2, banked });
    expect(result.assignments).toEqual({ pl2700: { 17: [130] } });
    expect(result.flags).toContainEqual({
      log: 77,
      character: "pl2700",
      action: 130,
      capClass: "normal",
      flag: "observed-but-unbanked",
      group: 17,
      evidence: "manual:button-map 2026-08-10 (partly inferred)",
    });
  });

  it("stays silent when observation and bank agree", () => {
    const banked = { pl2700: { groups: { 17: { actionIds: [130], evidence: "manual:button-map 2026-08-10" } } } };
    const result = solve(twoActionOracle, evidenceWith([0x32], twoActionHits), assets, { minSupport: 2, banked });
    expect(result.assignments).toEqual({ pl2700: { 17: [130] } });
    expect(result.flags).toEqual([]);
  });

  it("does not flag a derived group the bank has never seen — that is discovery, not disagreement", () => {
    const banked = { pl2700: { groups: { 15: { actionIds: [200], evidence: "manual:button-map 2026-08-10" } } } };
    const result = solve(twoActionOracle, evidenceWith([0x32], twoActionHits), assets, { minSupport: 2, banked });
    expect(result.assignments).toEqual({ pl2700: { 17: [130] } });
    expect(result.flags.filter((f) => f.flag === "observed-but-unbanked")).toEqual([]);
  });
});

describe("baseline attribution in solve", () => {
  // Eustace's log-2571 shape, miniaturized: EVERY observed action carries the
  // group pair [35,35] plus an always-on 15, so the pair lands in the class
  // BASELINE and residual analysis never sees it. After subtracting the
  // loadout's always-on channel nodes, the leftover [35,35] must be explained
  // by exactly one unlocked group subset — and that group then holds every
  // observed action.
  const line = (t, action, rate, cap, terms) =>
    `[X] CAPORACLE t=${t} inst=0x1 action=${action} rate=${rate} class_flags=0x0 cap=${cap} floor=1 terms=[${terms}] buffs=[]`;
  const PAIR = "0x61418d8:0x2:0.150000,0x61418d8:0x2:0.350000,0x61418d8:0x2:0.350000";
  const oracleText = [
    line(1000, 100, "1.000", 100000, PAIR),
    line(2000, 100, "1.100", 100000, PAIR),
    line(3000, 130, "3.000", 300000, PAIR),
    line(4000, 130, "3.100", 300000, PAIR),
  ].join("\n");
  const hits = [
    { t: 501_000, actor: 1, action: 100, cap: 100000, rate: 1, classFlags: 0, summon: false, statuses: [] },
    { t: 502_000, actor: 1, action: 100, cap: 100000, rate: 1.1, classFlags: 0, summon: false, statuses: [] },
    { t: 503_000, actor: 1, action: 130, cap: 300000, rate: 3, classFlags: 0, summon: false, statuses: [] },
    { t: 504_000, actor: 1, action: 130, cap: 300000, rate: 3.1, classFlags: 0, summon: false, statuses: [] },
  ];
  const evidenceWith = (nodeIds, sigils = []) => ({
    logs: [
      {
        id: 88,
        players: [
          { actorIndex: 1, characterType: "Pl2700", skillboard: nodeIds, sigils, summons: [] },
          null,
          null,
          null,
        ],
        hits,
      },
    ],
  });
  const assetsWith = (extraNodes, conditionalTraits = {}) => ({
    nodes: {
      pl2700_0001: { effects: [{ stat: "cap", percent: 15, capClass: "all", scope: "always" }] },
      pl2700_0085: {
        effects: [
          { stat: "cap", percent: 35, capClass: null, scope: "attack-group", targetAttackGroup: 0, abilityIds: [] },
        ],
      },
      pl2700_00e1: {
        effects: [
          { stat: "cap", percent: 35, capClass: null, scope: "attack-group", targetAttackGroup: 0, abilityIds: [] },
        ],
      },
      ...extraNodes,
    },
    skillNameSources: {},
    capUpSources: { conditionalTraits, conditionalTraitInputs: {}, traits: {}, transcendedTraits: {} },
  });

  it("banks a group hiding in the class baseline once always-nodes are subtracted", () => {
    const result = solve(oracleText, evidenceWith([0x01, 0x85, 0xe1]), assetsWith({}), { minSupport: 2 });
    expect(result.assignments).toEqual({ pl2700: { 0: [100, 130] } });
    expect(result.flags).toEqual([]);
  });

  it("flags an ambiguous baseline residue instead of guessing", () => {
    // Two single-node [35] groups: the [35,35] leftover is their union, but a
    // two-node group 0 would also fit — make BOTH shapes available.
    const assets = assetsWith({
      pl2700_0050: {
        effects: [
          { stat: "cap", percent: 35, capClass: null, scope: "attack-group", targetAttackGroup: 5, abilityIds: [] },
        ],
      },
      pl2700_0051: {
        effects: [
          { stat: "cap", percent: 35, capClass: null, scope: "attack-group", targetAttackGroup: 6, abilityIds: [] },
        ],
      },
    });
    const result = solve(oracleText, evidenceWith([0x01, 0x85, 0xe1, 0x50, 0x51]), assets, { minSupport: 2 });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "baseline-ambiguous-subset")).toBe(true);
  });

  it("a sigil-counted node's possible totals confound the baseline residue", () => {
    // Unlike an action-scoped delta (where a static count can never explain a
    // difference BETWEEN actions), the baseline is exactly where a static
    // sigil-counted contribution lives — so here it IS a confounder.
    const assets = assetsWith({
      pl2700_0023: {
        effects: [
          { stat: "cap", percent: 35, capClass: "all", scope: "counted", countKind: "basic-sigil", maxCount: 5 },
        ],
      },
    });
    const result = solve(oracleText, evidenceWith([0x01, 0x85, 0xe1, 0x23]), assets, { minSupport: 2 });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "baseline-confounded-value")).toBe(true);
  });

  it("a flat conditional trait value confounds the baseline residue", () => {
    const sigils = [{ sigilId: 1, firstTraitId: 0x1111, firstTraitLevel: 1, secondTraitId: 0, secondTraitLevel: 0 }];
    const assets = assetsWith({}, { "00001111": [[35, 35, 35]] });
    const result = solve(oracleText, evidenceWith([0x01, 0x85, 0xe1], sigils), assets, { minSupport: 2 });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "baseline-confounded-value")).toBe(true);
  });

  it("skips attribution when two players share the character — merged loadouts prove nothing", () => {
    // Log 2571's party had TWO Ids: the solver pools same-character hits, so
    // a "baseline" across two different loadouts is meaningless and banking
    // from it would write fiction. It must flag and refuse.
    const evidence = {
      logs: [
        {
          id: 89,
          players: [
            { actorIndex: 1, characterType: "Pl2700", skillboard: [0x01, 0x85, 0xe1], sigils: [], summons: [] },
            { actorIndex: 2, characterType: "Pl2700", skillboard: [0x01, 0x85, 0xe1], sigils: [], summons: [] },
            null,
            null,
          ],
          hits: hits.map((hit, index) => ({ ...hit, actor: index < 2 ? 1 : 2 })),
        },
      ],
    };
    const result = solve(oracleText, evidence, assetsWith({}), { minSupport: 2 });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "baseline-multiple-players")).toBe(true);
  });

  it("flags a baseline residue no group subset reproduces", () => {
    // Only ONE of the pair's nodes unlocked: the [35,35] leftover matches no
    // subset (the group fires [35] alone), so it must flag, not half-bank.
    const result = solve(oracleText, evidenceWith([0x01, 0x85]), assetsWith({}), { minSupport: 2 });
    expect(result.assignments).toEqual({});
    expect(result.flags.some((f) => f.flag === "baseline-unexplained-residual")).toBe(true);
  });
});

describe("bank", () => {
  const nodes = {
    pl2700_0085: {
      effects: [
        { stat: "cap", percent: 35, capClass: null, scope: "attack-group", targetAttackGroup: 20, abilityIds: [] },
      ],
    },
    pl2700_0015: {
      effects: [
        { stat: "cap", percent: 30, capClass: null, scope: "attack-group", targetAttackGroup: 15, abilityIds: [] },
      ],
    },
  };

  it("merges new memberships with existing ones and recomputes status", () => {
    const coverage = {
      version: "2.0.4",
      characters: {
        pl2700: {
          status: "partial",
          neededGroups: [20],
          groups: { 15: { actionIds: [1100], evidence: "manual" } },
        },
      },
    };
    const banked = bank(coverage, nodes, { pl2700: { 20: [2000], 15: [1100, 1200] } }, "caporacle log 42");
    const character = banked.characters.pl2700;
    expect(character.groups["20"]).toEqual({ actionIds: [2000], evidence: "caporacle log 42" });
    // Existing membership keeps its actions, unions the new, keeps both tags.
    expect(character.groups["15"].actionIds).toEqual([1100, 1200]);
    expect(character.groups["15"].evidence).toContain("manual");
    expect(character.groups["15"].evidence).toContain("caporacle log 42");
    expect(character.status).toBe("derived");
    expect(character.neededGroups).toEqual([]);
  });
});
