import { describe, expect, it } from "vitest";

import { statusClassName } from "./statusClassName";

const TABLE = { "43981": { class: "StatusPl1200UniqueBuffGuardpoint", name: "Guardpoint" } };

describe("statusClassName", () => {
  it("names a class from the generated table", () => {
    expect(statusClassName(43981, () => "", TABLE)).toBe("Guardpoint");
  });

  it("prefers a ui.json override over the generated name", () => {
    // The generated name is mechanical — it comes from splitting the RTTI
    // symbol — so a human improving it must win. Keyed by CLASS NAME rather
    // than by hash so the override stays readable and survives a regeneration.
    const t = (key: string) => (key === "causes.classes.StatusPl1200UniqueBuffGuardpoint" ? "Guard Point" : "");
    expect(statusClassName(43981, t, TABLE)).toBe("Guard Point");
  });

  it("answers empty for null and for a hash the table does not know", () => {
    // An unknown hash is the ordinary post-patch case, not a failure: the hook
    // resolves a class name this build's table has no entry for, and the row
    // falls through to the next rung rather than showing a number.
    expect(statusClassName(null, () => "", {})).toBe("");
    expect(statusClassName(1, () => "", {})).toBe("");
  });

  it("resolves against the real shipped table", () => {
    // The default argument is the generated asset, so this is also the check
    // that the generator's key spelling (decimal hash strings) still matches
    // what the parser sends.
    expect(statusClassName(2432047135, () => "")).toBe("Guardpoint");
    expect(statusClassName(3983034647, () => "")).toBe("Ares");
  });
});
