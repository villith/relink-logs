import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEFAULT_STATE, type AnalysisState } from "./state";
import { ACTION_LOG_LIMIT, useActionLog } from "./useActionLog";

const state = (over: Partial<AnalysisState> = {}): AnalysisState => ({ ...DEFAULT_STATE, ...over });

type Props = { state: AnalysisState; tab: string | null };

const setup = (initial: Props = { state: state(), tab: null }) =>
  renderHook((props: Props) => useActionLog(props.state, props.tab), { initialProps: initial });

describe("useActionLog", () => {
  it("records where the session started, so later deltas have an origin", () => {
    // A shared or hand-edited address can land already pinned; without this
    // entry every delta after it is measured from an unknown state.
    const { result } = setup({ state: state({ metric: "taken", source: 2 }), tab: null });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      kind: "opened",
      seq: 0,
      summary: expect.stringContaining("metric=taken"),
      query: "?metric=taken&src=2",
    });
  });

  it("appends one entry per transition, carrying the deltas and the query it produced", () => {
    const { result, rerender } = setup();
    rerender({ state: state({ metric: "taken" }), tab: null });
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[1]).toMatchObject({
      kind: "change",
      seq: 1,
      deltas: [{ field: "metric", from: "damage", to: "taken" }],
      query: "?metric=taken",
    });
  });

  it("records the body switch, which is not part of the machine state", () => {
    const { result, rerender } = setup();
    rerender({ state: state(), tab: "timeline" });
    expect(result.current.entries[1]).toMatchObject({
      deltas: [{ field: "tab", from: "table", to: "timeline" }],
    });
  });

  it("ignores a re-render that changed nothing", () => {
    // The state object is rebuilt on any render that touches an unrelated URL
    // key; recording by identity rather than by value would fill the trail with
    // actions nobody took.
    const { result, rerender } = setup();
    rerender({ state: state(), tab: null });
    rerender({ state: state(), tab: null });
    expect(result.current.entries).toHaveLength(1);
  });

  it("stamps each entry against the mount", () => {
    const { result, rerender } = setup();
    rerender({ state: state({ source: 1 }), tab: null });
    for (const entry of result.current.entries) expect(entry.atMs).toBeGreaterThanOrEqual(0);
  });

  it("starts a fresh trail on a remount", () => {
    const first = setup();
    first.rerender({ state: state({ source: 1 }), tab: null });
    expect(first.result.current.entries).toHaveLength(2);
    first.unmount();

    const second = setup();
    expect(second.result.current.entries).toHaveLength(1);
    expect(second.result.current.entries[0]).toMatchObject({ kind: "opened", seq: 0 });
  });

  it("drops the oldest steps past the cap and counts what it dropped", () => {
    // An unbounded dev buffer left open all evening is a leak; a truncated one
    // that reads as complete is a misleading report. Bounded, and it says so.
    const { result, rerender } = setup();
    for (let index = 1; index <= ACTION_LOG_LIMIT + 5; index++)
      rerender({ state: state({ source: index }), tab: null });

    expect(result.current.entries).toHaveLength(ACTION_LOG_LIMIT);
    expect(result.current.dropped).toBe(6);
    // Numbering keeps counting past a drop, so the trail cannot read as though
    // it began at the first entry still held.
    expect(result.current.entries[0].seq).toBe(6);
    expect(result.current.entries.at(-1)).toMatchObject({ seq: ACTION_LOG_LIMIT + 5 });
  });

  it("reports nothing dropped while it is under the cap", () => {
    const { result, rerender } = setup();
    rerender({ state: state({ source: 1 }), tab: null });
    expect(result.current.dropped).toBe(0);
  });
});
