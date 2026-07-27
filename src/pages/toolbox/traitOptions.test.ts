import { describe, expect, it } from "vitest";

import { orderedTraitOptions, POPULAR_TRAITS } from "./traitOptions";

const label = (hex: string) => `t:${hex}`;

describe("orderedTraitOptions", () => {
  it("leads with popular candidates in their fixed order, rest alphabetized behind a divider group", () => {
    const [popularA, , popularC] = POPULAR_TRAITS;
    const result = orderedTraitOptions(["cc000001", popularC, "aa000001", popularA], label);
    expect(result).toEqual([
      { value: popularA, label: label(popularA) },
      { value: popularC, label: label(popularC) },
      {
        group: " ",
        items: [
          { value: "aa000001", label: "t:aa000001" },
          { value: "cc000001", label: "t:cc000001" },
        ],
      },
    ]);
  });

  it("alphabetizes by label, not by hex value", () => {
    const byLabel = (hex: string) => (hex === "aa000001" ? "zzz" : "aaa");
    const result = orderedTraitOptions(["aa000001", "cc000001"], byLabel);
    expect(result).toEqual([
      {
        group: " ",
        items: [
          { value: "cc000001", label: "aaa" },
          { value: "aa000001", label: "zzz" },
        ],
      },
    ]);
  });

  it("returns only the group when no candidate is popular", () => {
    const result = orderedTraitOptions(["bb000001", "aa000001"], label);
    expect(result).toEqual([
      {
        group: " ",
        items: [
          { value: "aa000001", label: "t:aa000001" },
          { value: "bb000001", label: "t:bb000001" },
        ],
      },
    ]);
  });
});
