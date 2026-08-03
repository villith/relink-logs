import { describe, expect, it } from "vitest";
import { abilityIconForAction, abilityIconUrl } from "./abilityIcon";

describe("abilityIconUrl", () => {
  it("resolves a character's ability slot to its icon", () => {
    expect(abilityIconUrl("Pl0000", 1)).toMatch(/pl0000_01\.png/);
  });

  it("accepts the app's Pl#### spelling case-insensitively", () => {
    expect(abilityIconUrl("pl1400", 3)).toBe(abilityIconUrl("Pl1400", 3));
  });

  it("has slot-1 art for every id the lang table names", async () => {
    const characters = (await import("../src-tauri/lang/en/characters.json")).default;
    const missing = Object.keys(characters).filter((id) => abilityIconUrl(id, 1) === undefined);
    expect(missing).toEqual([]);
  });

  it("returns undefined for a slot the game never drew", () => {
    expect(abilityIconUrl("Pl0000", 99)).toBeUndefined();
  });

  it("returns undefined for an unknown character", () => {
    expect(abilityIconUrl("Pl9999", 1)).toBeUndefined();
  });
});

describe("abilityIconForAction", () => {
  /**
   * These pairs were each verified through two independent streams during the
   * action-id → ability derivation (game `pl####_action.msg` ability tags, and
   * the ability-name join; Pl2000 1100 additionally by live capture in the
   * status-cause investigation). If one regresses, the generated map is wrong,
   * not the test.
   */
  it("resolves verified action → ability pairs", () => {
    expect(abilityIconForAction("Pl2000", 1100)).toMatch(/pl2000_05\.png/); // Scourge (Dragonform), slot 02
    expect(abilityIconForAction("Pl2000", 1200)).toMatch(/pl2000_07\.png/); // Never Enough, slot 03
    expect(abilityIconForAction("Pl0000", 1001)).toMatch(/pl0000_08\.png/); // Overdrive Surge (Arts I)
    expect(abilityIconForAction("Pl0000", 1201)).toMatch(/pl0000_01\.png/); // Decimate (Arts I)
    expect(abilityIconForAction("Pl0400", 11000)).toMatch(/pl0400_06\.png/); // Concentration
  });

  it("overrides the game's junk tag on Io's empowered Gravity Well", () => {
    // pl0400_action.msg tags 7200-7203 with Gran's Decimate (AB_PL0000_01) —
    // dev copy-paste junk the generator adjudicates by ability name.
    expect(abilityIconForAction("Pl0400", 7200)).toMatch(/pl0400_04\.png/);
  });

  it("resolves upgraded ability entries to their reused base icon", () => {
    // Seofon's Chromatic Wings variants are their own ability rows (slot 13+)
    // whose ability.tbl icon points back at the base art.
    expect(abilityIconForAction("Pl2100", 3100)).toMatch(/pl2100_02\.png/);
  });

  it("returns undefined for actions that are not ability casts", () => {
    expect(abilityIconForAction("Pl0000", 100)).toBeUndefined(); // Attack 1
    expect(abilityIconForAction("Pl1700", 200)).toBeUndefined(); // Melas Unleashed (combo mechanic, not an ability)
    expect(abilityIconForAction("Pl9999", 1000)).toBeUndefined();
  });

  it("maps every entry to art that exists", async () => {
    const map = (await import("./assets/game-icons/ability-map.json")).default as Record<
      string,
      Record<string, string>
    >;
    const broken: string[] = [];
    for (const [char, actions] of Object.entries(map))
      for (const action of Object.keys(actions))
        if (abilityIconForAction(char, Number(action)) === undefined) broken.push(`${char}:${action}`);
    expect(broken).toEqual([]);
  });
});
