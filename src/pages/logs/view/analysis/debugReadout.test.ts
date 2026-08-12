import { describe, expect, it } from "vitest";

import type { ChartWindow } from "@/types";

import { buildDebugReadout, type DebugReadoutInput } from "./debugReadout";
import { CAPABILITIES } from "./machine/capabilities";
import { resolveViewSpec } from "./machine/resolve";
import { DEFAULT_STATE, type AnalysisState, type MetricKey } from "./machine/state";

const window_ = (kind: ChartWindow["kind"]): ChartWindow => ({ kind, startMs: 0, endMs: 1, actorIndex: null });

/** A readout over real capabilities and a real resolved spec — the two things
 * whose disagreement the panel exists to expose. */
const build = (over: Partial<DebugReadoutInput> = {}, state: AnalysisState = DEFAULT_STATE) => {
  const caps = CAPABILITIES[state.metric];
  const lines = buildDebugReadout({
    state,
    caps,
    spec: resolveViewSpec(state, caps),
    body: "table",
    settled: true,
    chartFormat: "amount",
    smoothing: 1,
    merge: false,
    streamer: false,
    displayNames: true,
    rows: 12,
    mask: undefined,
    windows: [],
    ...over,
  });
  return Object.fromEntries(lines.map((line) => [line.label, line.value]));
};

const metric = (key: MetricKey): AnalysisState => ({ ...DEFAULT_STATE, metric: key });

describe("buildDebugReadout", () => {
  it("prints the whole machine state as one JSON line", () => {
    // Beside the query string, not instead of it: the JSON is what the codec
    // MADE of the URL, and the two disagreeing is itself the bug.
    expect(build().state).toBe(JSON.stringify(DEFAULT_STATE));
  });

  it("names the resolved grouping, the body and whether the rows answer it", () => {
    expect(build().spec).toBe("groupBy=source body=table settled=yes");
  });

  it("says so when the rows still answer the previous grouping", () => {
    // The groups path draws the PREVIOUS aggregates until the fetch lands. A
    // report taken mid-flight without this reads as wrong rows.
    expect(build({ settled: false }).spec).toContain("settled=no");
  });

  it("prints the fetch the view actually sent, not merely that it sent one", () => {
    const state = { ...DEFAULT_STATE, source: 2 };
    const parsed = JSON.parse(build({}, state).fetch);
    expect(parsed).toMatchObject({ metric: "damage", groupBy: "ability", source: { kind: "player", index: 2 } });
  });

  it("says which path answered instead when there is no fetch", () => {
    expect(build({}, metric("stun")).fetch).toBe("(none — derived path)");
  });

  it("prints the capability flags that decide what the tab offers", () => {
    expect(build().caps).toBe("dataPath=groups hostility=yes supp=yes aura=yes");
    expect(build({}, metric("buffs")).caps).toBe("dataPath=intervals hostility=yes supp=no aura=no");
  });

  it("prints the chart's own reading", () => {
    expect(build({ chartFormat: "level", smoothing: 5 }).chart).toBe("source=groups format=level smoothing=5");
  });

  it("prints the stored settings that change what a row reads as", () => {
    // Not URL state and not recorded as actions, but the usual cause of a bar
    // with no name and of damage totals that will not reconcile.
    expect(build().view).toBe("merge=off streamer=off names=on");
    expect(build({ merge: true, streamer: true, displayNames: false }).view).toBe("merge=on streamer=on names=off");
  });

  it("counts the rows and the windows on offer", () => {
    const windows = [window_("sba"), window_("sba"), window_("link"), window_("break")];
    expect(build({ rows: 4, windows }).counts).toBe("rows=4 mask=none windows=sba:2 link:1 break:1");
  });

  it("says there are no windows rather than printing a bare label", () => {
    expect(build().counts).toContain("windows=—");
  });

  it("tells an absent mask apart from one that admits nothing", () => {
    // `undefined` is "no filter"; `[]` is a real mask matching no time at all,
    // and on screen the two are the same empty table.
    expect(build({ mask: [] }).counts).toContain("mask=0 (admits nothing)");
    expect(build({ mask: [{ fromMs: 0, upToMs: 9 }] }).counts).toContain("mask=1");
  });
});
