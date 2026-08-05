import { describe, expect, it } from "vitest";

import { DEFAULT_STATE, decodeState, encodeState, isPinned, type AnalysisState } from "./state";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

describe("isPinned", () => {
  it("reads each dimension's own pin", () => {
    expect(isPinned(state({ source: 2 }), "source")).toBe(true);
    expect(isPinned(state({ source: 2 }), "ability")).toBe(false);
    expect(isPinned(state({ ability: "skill:1" }), "ability")).toBe(true);
    expect(isPinned(state({ target: 0 }), "target")).toBe(true);
    expect(isPinned(DEFAULT_STATE, "target")).toBe(false);
  });

  it("treats target 0 as pinned — falsy-index bug guard", () => {
    expect(isPinned(state({ target: 0 }), "target")).toBe(true);
  });
});

describe("URL codec", () => {
  it("round-trips every field", () => {
    const full = state({
      metric: "taken",
      hostility: "enemy",
      source: 3,
      target: 0,
      ability: "skill:42",
      window: [10, 95],
      by: "target",
    });
    expect(decodeState(encodeState(full))).toEqual(full);
  });

  it("decodes an empty query to the default state", () => {
    expect(
      decodeState({ metric: null, side: null, src: null, tgt: null, abil: null, from: null, to: null, by: null })
    ).toEqual(DEFAULT_STATE);
  });

  it("degrades each bad field alone, keeping the others", () => {
    const decoded = decodeState({
      metric: "nonsense",
      side: "enemy",
      src: "not-a-number",
      tgt: "-4",
      abil: "skill:1",
      from: "3",
      to: null, // half a window is no window
      by: "sideways",
    });
    expect(decoded.metric).toBe("damage");
    expect(decoded.hostility).toBe("enemy");
    expect(decoded.source).toBeNull();
    expect(decoded.target).toBeNull();
    expect(decoded.ability).toBe("skill:1");
    expect(decoded.window).toBeNull();
    expect(decoded.by).toBeNull();
  });
});
