import { describe, expect, it } from "vitest";

import { useMeterSettingsStore } from "./useMeterSettingsStore";

describe("meter damage-source filters", () => {
  it("leaves Primal Burst out of the meters by default", () => {
    // Off by default is the shipped behaviour: whether a Primal Burst belongs
    // in a DPS number is still an open question, so the app does not decide it
    // for the user.
    expect(useMeterSettingsStore.getState().include_primal_burst).toBe(false);
  });

  it("keeps the default for a persisted state saved before the field existed", () => {
    // `merge` spreads the current defaults under the persisted state, so an
    // older localStorage copy must hydrate to false rather than to undefined.
    const merged = { ...useMeterSettingsStore.getState(), ...{ transparency: 0.9 } };
    expect(merged.include_primal_burst).toBe(false);
  });
});
