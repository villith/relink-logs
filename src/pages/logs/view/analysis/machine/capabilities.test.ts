import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { METRIC_KEYS } from "./state";

describe("CAPABILITIES", () => {
  it("declares every metric", () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...METRIC_KEYS].sort());
  });

  it("orders dimensions source-first for the event metrics", () => {
    expect(CAPABILITIES.damage.dimensionOrder).toEqual(["source", "ability", "target"]);
    expect(CAPABILITIES.taken.dimensionOrder).toEqual(["source", "ability", "target"]);
  });

  it("declares the honest limits", () => {
    expect(CAPABILITIES.sba.dimensions.ability.supported).toBe(false);
    expect(CAPABILITIES.sba.dimensions.ability.disabledReasonKey).toBe("ui.logs.sba-no-breakdown");
    expect(CAPABILITIES.stun.dimensions.target.supported).toBe(false);
    expect(CAPABILITIES.stun.supportsHostility).toBe(false);
    expect(CAPABILITIES.sba.supportsHostility).toBe(false);
  });

  it("routes each metric to its data path", () => {
    expect(CAPABILITIES.damage.dataPath).toBe("groups");
    expect(CAPABILITIES.taken.dataPath).toBe("groups");
    expect(CAPABILITIES.stun.dataPath).toBe("derived");
    expect(CAPABILITIES.sba.dataPath).toBe("derived");
    expect(CAPABILITIES.buffs.dataPath).toBe("intervals");
    expect(CAPABILITIES.debuffs.dataPath).toBe("intervals");
  });

  it("names every supported dimension's regroup tab on both sides", () => {
    for (const caps of Object.values(CAPABILITIES)) {
      for (const dim of caps.dimensionOrder) {
        const decl = caps.dimensions[dim];
        if (!decl.supported) continue;
        expect(decl.groupLabelKey.friendly).toMatch(/^ui\.logs\./);
        expect(decl.groupLabelKey.enemy).toMatch(/^ui\.logs\./);
      }
    }
  });
});
