import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATE,
  auraAnchorOf,
  auraPinKey,
  decodeState,
  encodeState,
  isPinned,
  type AnalysisState,
  type RawState,
} from "./state";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

/** Every RawState field null — the base each decode test overrides. */
const RAW_NONE: RawState = {
  metric: null,
  side: null,
  src: null,
  tgt: null,
  abil: null,
  from: null,
  to: null,
  by: null,
  aura: null,
};

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
      aura: "src:status:4:1",
    });
    expect(decodeState(encodeState(full))).toEqual(full);
  });

  it("decodes an empty query to the default state", () => {
    expect(decodeState(RAW_NONE)).toEqual(DEFAULT_STATE);
  });

  it("degrades each bad field alone, keeping the others", () => {
    const decoded = decodeState({
      ...RAW_NONE,
      metric: "nonsense",
      side: "enemy",
      src: "not-a-number",
      tgt: "-4",
      abil: "skill:1",
      from: "3",
      to: null, // half a window is no window
      by: "sideways",
      aura: "not-an-aura",
    });
    expect(decoded.metric).toBe("damage");
    expect(decoded.hostility).toBe("enemy");
    expect(decoded.source).toBeNull();
    expect(decoded.target).toBeNull();
    expect(decoded.ability).toBe("skill:1");
    expect(decoded.window).toBeNull();
    expect(decoded.by).toBeNull();
    expect(decoded.aura).toBeNull();

    // Empty strings degrade to null
    expect(decodeState({ ...RAW_NONE, src: "" }).source).toBeNull();
    expect(decodeState({ ...RAW_NONE, abil: "" }).ability).toBeNull();

    // Inverted window degrades
    expect(decodeState({ ...RAW_NONE, from: "9", to: "3" }).window).toBeNull();

    // Float rejects
    expect(decodeState({ ...RAW_NONE, src: "1.5" }).source).toBeNull();
  });
});

describe("aura grammar", () => {
  it("accepts only anchor:status keys", () => {
    expect(decodeState({ ...RAW_NONE, aura: "src:status:4:1" }).aura).toBe("src:status:4:1");
    expect(decodeState({ ...RAW_NONE, aura: "tgt:status:4:unknown" }).aura).toBe("tgt:status:4:unknown");
    // No anchor, wrong grammar, wrong anchor spelling — all degrade alone.
    expect(decodeState({ ...RAW_NONE, aura: "status:4:1" }).aura).toBeNull();
    expect(decodeState({ ...RAW_NONE, aura: "src:skill:9" }).aura).toBeNull();
    expect(decodeState({ ...RAW_NONE, aura: "source:status:4:1" }).aura).toBeNull();
  });

  it("names the anchoring dimension", () => {
    expect(auraAnchorOf("src:status:4:1")).toBe("source");
    expect(auraAnchorOf("tgt:status:4:unknown")).toBe("target");
    expect(auraAnchorOf(null)).toBeNull();
    expect(auraAnchorOf("garbage")).toBeNull();
  });

  it("extracts the status pin key", () => {
    expect(auraPinKey("src:status:4:1")).toBe("status:4:1");
    expect(auraPinKey("tgt:status:4:unknown")).toBe("status:4:unknown");
  });
});
