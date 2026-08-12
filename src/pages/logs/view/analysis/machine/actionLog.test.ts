import { describe, expect, it } from "vitest";

import {
  describeTransition,
  entryRows,
  formatReport,
  queryOf,
  summarizeState,
  type ActionEntry,
  type RecordedState,
} from "./actionLog";
import { DEFAULT_STATE, decodeState, type AnalysisState } from "./state";

const recorded = (over: Partial<RecordedState> = {}): RecordedState => ({ ...DEFAULT_STATE, tab: null, ...over });

describe("describeTransition", () => {
  it("reports nothing when the state did not change", () => {
    expect(describeTransition(recorded(), recorded())).toEqual([]);
    const pinned = recorded({ source: 2, aura: ["src:status:1:2:3"] });
    expect(describeTransition(pinned, { ...pinned })).toEqual([]);
  });

  it("names the field, where it came from and where it went", () => {
    expect(describeTransition(recorded(), recorded({ metric: "taken" }))).toEqual([
      { field: "metric", from: "damage", to: "taken" },
    ]);
  });

  it("keeps every field a single transition touched in one entry", () => {
    // The hostility switch clears both actor pins. Recorded as ONE user action
    // with three deltas, not three actions — the user clicked once.
    const before = recorded({ source: 2, target: 3 });
    const after = recorded({ hostility: "enemy" });
    expect(describeTransition(before, after)).toEqual([
      { field: "side", from: "friendly", to: "enemy" },
      { field: "src", from: "2", to: "—" },
      { field: "tgt", from: "3", to: "—" },
    ]);
  });

  it("orders deltas by a fixed field order, not by which changed first", () => {
    // A stable order is what makes two reports comparable by eye.
    const after = recorded({ tab: "timeline", by: "target", window: [4, 9], win: ["sba"] });
    expect(describeTransition(recorded(), after).map((delta) => delta.field)).toEqual(["tab", "by", "zoom", "win"]);
  });

  it("spells an absent pin rather than leaving the side blank", () => {
    expect(describeTransition(recorded({ ability: "skill:1601" }), recorded())).toEqual([
      { field: "abil", from: "skill:1601", to: "—" },
    ]);
  });

  it("prints the scrub window as a range and calls it zoom", () => {
    // `zoom`, not `window`: the battle-window FILTER is `win`, and two fields a
    // character apart in a readout are two fields a reader will confuse.
    expect(describeTransition(recorded(), recorded({ window: [41, 78] }))).toEqual([
      { field: "zoom", from: "—", to: "41-78" },
    ]);
  });

  it("prints list filters as their whole list, so a report shows what is composed", () => {
    const before = recorded({ aura: ["src:status:1:2:3"] });
    const after = recorded({ aura: ["src:status:1:2:3", "tgt:status:9:unknown:1"] });
    expect(describeTransition(before, after)).toEqual([
      { field: "aura", from: "src:status:1:2:3", to: "src:status:1:2:3,tgt:status:9:unknown:1" },
    ]);
  });

  it("records the tab verbatim, defaulting only a missing one", () => {
    // A hand-typed `tab=bogus` reads as the table but must not PRINT as one:
    // the readout's job is to show why the view is doing something odd.
    expect(describeTransition(recorded(), recorded({ tab: "bogus" }))).toEqual([
      { field: "tab", from: "table", to: "bogus" },
    ]);
  });
});

describe("summarizeState", () => {
  it("spells every field, so the opened entry is a baseline on its own", () => {
    expect(summarizeState(recorded())).toBe(
      "tab=table metric=damage side=friendly by=— src=— abil=— tgt=— zoom=— aura=— win=—"
    );
  });

  it("uses the same spellings the deltas do", () => {
    const state = recorded({ metric: "sba", source: 2, window: [1, 5], win: ["sba", "link:0"] });
    expect(summarizeState(state)).toBe(
      "tab=table metric=sba side=friendly by=— src=2 abil=— tgt=— zoom=1-5 aura=— win=sba,link:0"
    );
  });
});

describe("queryOf", () => {
  it("is empty for the default state, matching an address with no query", () => {
    expect(queryOf(recorded())).toBe("");
  });

  it("builds the query the state would write, leading ? and all", () => {
    expect(queryOf(recorded({ metric: "taken", hostility: "enemy", source: 2, window: [41, 78] }))).toBe(
      "?metric=taken&side=enemy&src=2&from=41&to=78"
    );
  });

  it("carries the body, which is not part of the machine state", () => {
    expect(queryOf(recorded({ tab: "timeline" }))).toBe("?tab=timeline");
  });

  it("round-trips back through the codec", () => {
    // The point of the recorded query is replay: pasting it must reproduce the
    // state that produced it.
    const state: AnalysisState = {
      metric: "buffs",
      hostility: "enemy",
      source: 1,
      target: 4,
      ability: "status:120:9:1",
      window: [3, 88],
      by: "target",
      aura: ["src:status:1:2:3"],
      win: ["sba:1", "break"],
    };
    const params = new URLSearchParams(queryOf({ ...state, tab: null }));
    const read = (key: string) => params.get(key);
    expect(
      decodeState({
        metric: read("metric"),
        side: read("side"),
        src: read("src"),
        tgt: read("tgt"),
        abil: read("abil"),
        from: read("from"),
        to: read("to"),
        by: read("by"),
        aura: read("aura"),
        win: read("win"),
      })
    ).toEqual(state);
  });
});

describe("entryRows", () => {
  // One author for how a step reads, so the panel and the pasted report can
  // never describe the same action differently.
  it("labels the landing entry and hands over its summary", () => {
    const entry: ActionEntry = { kind: "opened", seq: 0, atMs: 0, summary: "metric=damage", query: "" };
    expect(entryRows(entry)).toEqual([{ label: "opened", value: "metric=damage" }]);
  });

  it("turns each delta into its own row", () => {
    const entry: ActionEntry = {
      kind: "change",
      seq: 1,
      atMs: 0,
      deltas: [
        { field: "side", from: "friendly", to: "enemy" },
        { field: "src", from: "2", to: "—" },
      ],
      query: "",
    };
    expect(entryRows(entry)).toEqual([
      { label: "side", value: "friendly → enemy" },
      { label: "src", value: "2 → —" },
    ]);
  });
});

describe("formatReport", () => {
  const entries: ActionEntry[] = [
    { kind: "opened", seq: 0, atMs: 0, summary: summarizeState(recorded()), query: "" },
    {
      kind: "change",
      seq: 1,
      atMs: 1234,
      deltas: [{ field: "metric", from: "damage", to: "taken" }],
      query: "?metric=taken",
    },
  ];
  const readout = [
    { label: "state", value: '{"metric":"taken"}' },
    { label: "spec", value: "groupBy=ability" },
  ];

  it("leads with the live query and the readout lines", () => {
    const report = formatReport({ query: "?metric=taken", readout, entries, dropped: 0 });
    expect(report.split("\n").slice(0, 4)).toEqual([
      "RELINK ANALYSIS DEBUG",
      "query   ?metric=taken",
      'state   {"metric":"taken"}',
      "spec    groupBy=ability",
    ]);
  });

  it("says so when the live query is empty rather than trailing a bare label", () => {
    const report = formatReport({ query: "", readout: [], entries: [], dropped: 0 });
    expect(report).toContain("query   (none)");
  });

  it("numbers each action, stamps it and prints the query it produced", () => {
    const report = formatReport({ query: "?metric=taken", readout: [], entries, dropped: 0 });
    expect(report).toContain("ACTIONS (2)");
    expect(report).toContain("  0 +0.0s opened  tab=table metric=damage");
    expect(report).toContain("  1 +1.2s metric  damage → taken");
    expect(report).toContain("         query   ?metric=taken");
  });

  it("prints an empty produced query as (none) too", () => {
    const report = formatReport({ query: "", readout: [], entries, dropped: 0 });
    expect(report).toContain("         query   (none)");
  });

  it("lines a multi-delta action up under its first row", () => {
    const multi: ActionEntry[] = [
      {
        kind: "change",
        seq: 3,
        atMs: 2900,
        deltas: [
          { field: "side", from: "friendly", to: "enemy" },
          { field: "src", from: "2", to: "—" },
        ],
        query: "?side=enemy",
      },
    ];
    const report = formatReport({ query: "", readout: [], entries: multi, dropped: 0 });
    expect(report).toContain("  3 +2.9s side    friendly → enemy");
    expect(report).toContain("         src     2 → —");
  });

  it("admits what the ring buffer dropped instead of reading as a complete trail", () => {
    const report = formatReport({ query: "", readout: [], entries, dropped: 12 });
    expect(report).toContain("12 earlier actions dropped");
  });

  it("says the trail is empty rather than printing a bare heading", () => {
    const report = formatReport({ query: "?src=2", readout: [], entries: [], dropped: 0 });
    expect(report).toContain("ACTIONS (0)");
    expect(report).toContain("(nothing recorded)");
  });
});
