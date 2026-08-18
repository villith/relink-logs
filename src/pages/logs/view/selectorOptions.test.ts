import { describe, expect, it } from "vitest";

import type { SelectionFact } from "@/types";

import { deriveSelectorOptions } from "./selectorOptions";

const NARMAYA_HASH = 0x0a58fb4d;
const EUGEN_HASH = 0x91418145;
// Sources are pinned by actor INDEX, not by character hash.
const NARMAYA = 0;
const EUGEN = 1;
// Targets are pinned by SPAWN — an index into targetEntries — not by the game's
// actor id, which it reissues to a later boss.
const BOSS = 1;
const ADD = 2;

const fact = (sourceIndex: number, targetSegment: number, action: number): SelectionFact => ({
  sourceActorType: sourceIndex === NARMAYA ? NARMAYA_HASH : EUGEN_HASH,
  sourceIndex,
  targetSegment,
  ability: { Normal: action },
});

const FACTS: SelectionFact[] = [fact(NARMAYA, BOSS, 100), fact(NARMAYA, ADD, 200), fact(EUGEN, BOSS, 300)];

const NO_PINS = { source: null, targets: [], ability: null };

describe("deriveSelectorOptions", () => {
  it("offers every dimension when nothing is pinned", () => {
    const options = deriveSelectorOptions(FACTS, NO_PINS);
    expect(options.sources.map((o) => o.value)).toEqual([String(NARMAYA), String(EUGEN)]);
    expect(options.targets.map((o) => o.value)).toEqual([String(BOSS), String(ADD)]);
    expect(options.abilities.map((o) => o.value)).toEqual(["Normal:100", "Normal:200", "Normal:300"]);
  });

  it("condenses the ability list into skill groups, like the table", () => {
    // Against the REAL table: Gran's 100/110 are "normal-attack", 200 is
    // "power-raise". An uncondensed list is what put 27 entries in the dropdown
    // where the table beneath shows a handful.
    const grouped: SelectionFact[] = [
      { ...fact(NARMAYA, BOSS, 100), childCharacterType: "Pl0000" },
      { ...fact(NARMAYA, BOSS, 110), childCharacterType: "Pl0000" },
      { ...fact(NARMAYA, BOSS, 200), childCharacterType: "Pl0000" },
    ];

    const options = deriveSelectorOptions(grouped, NO_PINS);

    expect(options.abilities.map((o) => o.value)).toEqual([
      'Group:normal-attack@"Pl0000"',
      'Group:power-raise@"Pl0000"',
    ]);
  });

  /** THE ECHO FOLD. Live on log 1573 this listed 24 options all reading
   * "Supplementary Damage" against a table showing ONE row of 430.3m/260 hits;
   * picking any of them pinned a single payload and reported 105.7m/41 hits as
   * "100.0%". The parser folds every echo onto one row, so the list must too. */
  it("offers one supplementary-damage entry however many payloads occurred", () => {
    const echoes: SelectionFact[] = [1000, 1, 2, 3].map((payload) => ({
      ...fact(NARMAYA, BOSS, 0),
      ability: { SupplementaryDamage: payload },
    }));

    const options = deriveSelectorOptions([...echoes, fact(NARMAYA, BOSS, 100)], NO_PINS);

    expect(options.abilities.map((o) => o.value)).toEqual(["SupplementaryDamage:0", "Normal:100"]);
  });

  it("narrows to every echo payload when the folded echo row is pinned", () => {
    // The pin is one key, but it must survive the fact list unchanged — a fold
    // that dropped the other payloads would empty the table it just opened.
    const echoes: SelectionFact[] = [1000, 1].map((payload) => ({
      ...fact(NARMAYA, BOSS, 0),
      ability: { SupplementaryDamage: payload },
    }));

    const options = deriveSelectorOptions([...echoes, fact(EUGEN, BOSS, 300)], {
      ...NO_PINS,
      ability: "SupplementaryDamage:0",
    });

    expect(options.sources.map((o) => o.value)).toEqual([String(NARMAYA)]);
  });

  it("leaves the list ungrouped when the backend sends no child character", () => {
    // An older binary has no `childCharacterType`; grouping on a guess would
    // file skills under the wrong character.
    const options = deriveSelectorOptions(FACTS, NO_PINS);
    expect(options.abilities.map((o) => o.value)).toEqual(["Normal:100", "Normal:200", "Normal:300"]);
  });

  it("narrows abilities to the pinned source", () => {
    const options = deriveSelectorOptions(FACTS, { ...NO_PINS, source: NARMAYA });
    expect(options.abilities.map((o) => o.value)).toEqual(["Normal:100", "Normal:200"]);
  });

  it("narrows targets to the pinned source", () => {
    const options = deriveSelectorOptions(FACTS, { ...NO_PINS, source: EUGEN });
    expect(options.targets.map((o) => o.value)).toEqual([String(BOSS)]);
  });

  it("never narrows a dimension by its own pin", () => {
    // Pinning a source must not reduce the source list to that one source —
    // otherwise you could never change your mind without clearing first.
    const options = deriveSelectorOptions(FACTS, { ...NO_PINS, source: NARMAYA });
    expect(options.sources.map((o) => o.value)).toEqual([String(NARMAYA), String(EUGEN)]);
  });

  it("intersects multiple pins", () => {
    const options = deriveSelectorOptions(FACTS, { ...NO_PINS, source: NARMAYA, targets: [ADD] });
    expect(options.abilities.map((o) => o.value)).toEqual(["Normal:200"]);
  });

  it("keeps two players on the same character apart", () => {
    // An online party can hold two of the same character, so keying sources on
    // the character hash would merge them into one row and one pin.
    const twins: SelectionFact[] = [
      { sourceActorType: NARMAYA_HASH, sourceIndex: 0, targetSegment: BOSS, ability: { Normal: 100 } },
      { sourceActorType: NARMAYA_HASH, sourceIndex: 2, targetSegment: BOSS, ability: { Normal: 900 } },
    ];

    expect(deriveSelectorOptions(twins, NO_PINS).sources.map((o) => o.value)).toEqual(["0", "2"]);
    expect(deriveSelectorOptions(twins, { ...NO_PINS, source: 2 }).abilities.map((o) => o.value)).toEqual([
      "Normal:900",
    ]);
  });

  /** THE RECYCLED-ID CASE (live: "Four Dragons of the Apocalypse"). Wilinus
   * Icewyrm and Vrazarek Firewyrm both arrived as actor id 3926405961, so a
   * fact keyed by that id offered ONE entry for two bosses — the second dragon
   * never appeared, and pinning the first also returned the second's damage.
   * Keyed by spawn, they are two entries that narrow independently. */
  it("offers one entry per spawn even when the game reissued the actor id", () => {
    const wilinus = 0;
    const vrazarek = 2;
    const dragons: SelectionFact[] = [fact(NARMAYA, wilinus, 100), fact(EUGEN, vrazarek, 900)];

    const options = deriveSelectorOptions(dragons, NO_PINS);
    expect(options.targets.map((o) => o.value)).toEqual([String(wilinus), String(vrazarek)]);

    // ...and pinning one names only that dragon's attacker.
    const pinned = deriveSelectorOptions(dragons, { ...NO_PINS, targets: [vrazarek] });
    expect(pinned.sources.map((o) => o.value)).toEqual([String(EUGEN)]);
    expect(pinned.abilities.map((o) => o.value)).toEqual(["Normal:900"]);
  });

  it("returns empty lists for an empty fact set", () => {
    const options = deriveSelectorOptions([], NO_PINS);
    expect(options.sources).toEqual([]);
    expect(options.targets).toEqual([]);
    expect(options.abilities).toEqual([]);
  });

  /** THE SIDE TOGGLE. It is not a filter: it swaps which population each of the
   * two actor dimensions draws from (`universeOf`), exactly as the backend's own
   * group query swaps them. Read straight off the fact's fields, both selectors
   * offered the friendly universes on both sides — so the toggle appeared to do
   * nothing to the two controls it is meant to swap. */
  describe("under the enemy side", () => {
    it("offers enemy spawns as SOURCES and the party as TARGETS", () => {
      const options = deriveSelectorOptions(FACTS, NO_PINS, "enemy");

      expect(options.sources.map((o) => o.value)).toEqual([String(BOSS), String(ADD)]);
      expect(options.targets.map((o) => o.value)).toEqual([String(NARMAYA), String(EUGEN)]);
    });

    // The cascade has to narrow the dimension the pin actually names. A source
    // pin is a SPAWN here, so applying it to the fact's `sourceIndex` would
    // narrow by a player index that spawn number happens to collide with.
    it("cascades a source pin as the spawn it now names", () => {
      const options = deriveSelectorOptions(FACTS, { ...NO_PINS, source: ADD }, "enemy");

      expect(options.targets.map((o) => o.value)).toEqual([String(NARMAYA)]);
      expect(options.abilities.map((o) => o.value)).toEqual(["Normal:200"]);
    });

    it("cascades a target pin as the player it now names", () => {
      const options = deriveSelectorOptions(FACTS, { ...NO_PINS, targets: [EUGEN] }, "enemy");

      expect(options.sources.map((o) => o.value)).toEqual([String(BOSS)]);
      expect(options.abilities.map((o) => o.value)).toEqual(["Normal:300"]);
    });

    // The friendly side is the default, so nothing that omits the argument moves.
    it("leaves the friendly side exactly where it was", () => {
      expect(deriveSelectorOptions(FACTS, NO_PINS, "friendly")).toEqual(deriveSelectorOptions(FACTS, NO_PINS));
    });
  });
});
