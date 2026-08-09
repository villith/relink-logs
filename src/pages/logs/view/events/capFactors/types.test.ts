import { describe, expect, it } from "vitest";

import { activeResult, inactiveResult, notApplicableResult, unknownResult } from "./types";

describe("cap factor results", () => {
  it("an active factor contributes its own value", () => {
    expect(activeResult(30)).toEqual({ percent: 30, potential: 30, state: "active", missing: [] });
  });

  it("an inactive factor contributes nothing but keeps its potential visible", () => {
    // The gate was evaluated and failed. The potential still renders, because
    // "this trait would have given +500% had you been below 25% HP" is the
    // whole reason the row is worth showing.
    expect(inactiveResult(500)).toEqual({ percent: 0, potential: 500, state: "inactive", missing: [] });
  });

  it("an unknown factor names the params it was not given", () => {
    // Neither zero nor its maximum: counting the maximum would shrink
    // Unaccounted by a number the formula did not necessarily use.
    expect(unknownResult(50, ["hpRatio"])).toEqual({
      percent: 0,
      potential: 50,
      state: "unknown",
      missing: ["hpRatio"],
    });
  });

  it("a factor for another attack class contributes nothing and has no potential", () => {
    expect(notApplicableResult()).toEqual({ percent: 0, potential: 0, state: "not-applicable", missing: [] });
  });
});
