import { describe, expect, it } from "vitest";

import {
  PANE_FIELDS,
  SHARED_FIELDS,
  decodeCompare,
  encodeCompare,
  paneParamName,
  paneParamNames,
  removeCompareAt,
} from "./paneParams";
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
  // vitest transpiles without typechecking, so `Object.keys` here returns the ten
  // keys someone TYPED, never the eleven the type may have grown. This guards the
  // list side only; `tsc` guards the type side, via `_paneFieldsExhaustive`.
  it("partitions every RawState field into exactly one scope (list side)", () => {
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

describe("decodeCompare", () => {
  it("reads a comma list of ids", () => {
    expect(decodeCompare("2661,2664")).toEqual([2661, 2664]);
  });

  it("is empty when the param is absent", () => {
    expect(decodeCompare(null)).toEqual([]);
  });

  it("drops an entry that cannot name a log, keeping the rest", () => {
    expect(decodeCompare("2661,banana,2664")).toEqual([2661, 2664]);
  });

  it("keeps an id equal to the path log — one run against itself is a real comparison", () => {
    expect(decodeCompare("2657")).toEqual([2657]);
  });

  it("drops a repeated id, because two panes on one log with one pin set is not two panes", () => {
    expect(decodeCompare("2661,2661")).toEqual([2661]);
  });
});

describe("encodeCompare", () => {
  it("drops the param entirely when nothing is compared", () => {
    expect(encodeCompare([])).toBeNull();
  });

  it("writes the ids in pane order", () => {
    expect(encodeCompare([2661, 2664])).toBe("2661,2664");
  });
});

describe("removeCompareAt", () => {
  it("removes the named pane, counting pane 0 as the path log", () => {
    expect(removeCompareAt([2661, 2664], 1)).toEqual([2664]);
  });

  it("splices from the middle so the panes above shift down", () => {
    expect(removeCompareAt([2661, 2664, 2670], 2)).toEqual([2661, 2670]);
  });

  it("refuses to remove pane 0 — the path log is the page", () => {
    expect(removeCompareAt([2661], 0)).toEqual([2661]);
  });
});

describe("paneParamNames", () => {
  it("names every pane-scoped key for a pane, so a remover can clear them all", () => {
    expect(paneParamNames(1)).toEqual(["src1", "tgt1", "abil1", "by1", "aura1"]);
  });

  it("names pane 0's bare keys", () => {
    expect(paneParamNames(0)).toEqual(["src", "tgt", "abil", "by", "aura"]);
  });

  it("covers every pane field, so adding one cannot be forgotten here", () => {
    expect(paneParamNames(1)).toHaveLength(PANE_FIELDS.length);
  });
});
