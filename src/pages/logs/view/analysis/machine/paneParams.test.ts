import { describe, expect, it } from "vitest";

import { PANE_FIELDS, SHARED_FIELDS, paneParamName } from "./paneParams";
import type { RawState } from "./state";

describe("paneParamName", () => {
  it("leaves pane 0 on the bare keys, so today's URLs keep working", () => {
    expect(paneParamName("src", 0)).toBe("src");
    expect(paneParamName("abil", 0)).toBe("abil");
  });

  it("suffixes later panes with their index", () => {
    expect(paneParamName("src", 1)).toBe("src1");
    expect(paneParamName("aura", 2)).toBe("aura2");
  });
});

describe("field split", () => {
  it("partitions every RawState field into exactly one scope", () => {
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
      win: null,
    };
    expect([...SHARED_FIELDS, ...PANE_FIELDS].sort()).toEqual(Object.keys(RAW_NONE).sort());
  });
});
