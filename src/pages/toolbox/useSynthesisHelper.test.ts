import { describe, expect, it } from "vitest";

import { buildQuery } from "./useSynthesisHelper";

describe("buildQuery", () => {
  it("parses hex trait values and maps the form to the backend query", () => {
    expect(
      buildQuery({ trait1: "0114dd91", trait2: "01b49f0d", anyOrder: true, requireLucky: false })
    ).toEqual({
      trait1: 0x0114dd91,
      trait2: 0x01b49f0d,
      anyOrder: true,
      requireLucky: false,
    });
  });

  it("returns null without a first trait, and null trait2 when unset", () => {
    expect(buildQuery({ trait1: null, trait2: null, anyOrder: false, requireLucky: false })).toBeNull();
    expect(
      buildQuery({ trait1: "0114dd91", trait2: null, anyOrder: false, requireLucky: true })
    ).toEqual({ trait1: 0x0114dd91, trait2: null, anyOrder: false, requireLucky: true });
  });
});
