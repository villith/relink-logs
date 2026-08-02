import { describe, expect, it } from "vitest";

import { withStatusOption } from "./statusOption";

const label = (key: string) => `named:${key}`;

const OPTIONS = [
  { value: "skill:100", label: "Normal Attack" },
  { value: "skill:200", label: "Link Attack" },
];

describe("withStatusOption", () => {
  it("returns the options untouched when nothing is pinned", () => {
    expect(withStatusOption(OPTIONS, null, label)).toEqual(OPTIONS);
  });

  it("returns the options untouched for a damage-ability pin", () => {
    expect(withStatusOption(OPTIONS, "skill:100", label)).toEqual(OPTIONS);
  });

  it("prepends the pinned status effect, labelled", () => {
    expect(withStatusOption(OPTIONS, "status:1001:1100", label)).toEqual([
      { value: "status:1001:1100", label: "named:status:1001:1100" },
      ...OPTIONS,
    ]);
  });

  it("does not add a second entry when the pin is already an option", () => {
    const withIt = [{ value: "status:1001:1100", label: "Burn" }, ...OPTIONS];
    expect(withStatusOption(withIt, "status:1001:1100", label)).toEqual(withIt);
  });

  it("keeps the pinned effect first across repeated calls", () => {
    const once = withStatusOption(OPTIONS, "status:10:20", label);
    expect(withStatusOption(once, "status:10:20", label)).toEqual(once);
  });
});

