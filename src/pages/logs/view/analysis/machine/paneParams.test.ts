import { describe, expect, it } from "vitest";

import { PANE_FIELDS, SHARED_FIELDS, paneParamName } from "./paneParams";

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
  it("scopes the pins, the grouping override and the aura filter to a pane", () => {
    expect([...PANE_FIELDS]).toEqual(["src", "tgt", "abil", "by", "aura"]);
  });

  it("keeps the metric, side, zoom and window filter shared", () => {
    expect([...SHARED_FIELDS]).toEqual(["metric", "side", "from", "to", "win"]);
  });
});
