import { describe, expect, it } from "vitest";

import { buffs } from "./buffs";
import { damageDone } from "./damageDone";
import { damageTaken } from "./damageTaken";
import { debuffs } from "./debuffs";
import { sba } from "./sba";
import { stun } from "./stun";

describe("hostility support declarations", () => {
  it("every tab except SBA and Stun supports the Friendlies/Enemies toggle", () => {
    expect(damageDone.supportsHostility).toBe(true);
    expect(damageTaken.supportsHostility).toBe(true);
    expect(buffs.supportsHostility).toBe(true);
    expect(debuffs.supportsHostility).toBe(true);
    expect(sba.supportsHostility).toBeUndefined();
    expect(stun.supportsHostility).toBeUndefined();
  });
});
