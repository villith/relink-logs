import { describe, expect, it } from "vitest";

import type { SelectionFact } from "@/types";

import { deriveSelectorOptions } from "./selectorOptions";

const NARMAYA_HASH = 0x0a58fb4d;
const EUGEN_HASH = 0x91418145;
// Sources are pinned by actor INDEX, not by character hash.
const NARMAYA = 0;
const EUGEN = 1;
const BOSS = 1;
const ADD = 2;

const fact = (sourceIndex: number, targetId: number, action: number): SelectionFact => ({
  sourceActorType: sourceIndex === NARMAYA ? NARMAYA_HASH : EUGEN_HASH,
  sourceIndex,
  targetId,
  ability: { Normal: action },
});

const FACTS: SelectionFact[] = [fact(NARMAYA, BOSS, 100), fact(NARMAYA, ADD, 200), fact(EUGEN, BOSS, 300)];

const NO_PINS = { source: null, targetIds: [], ability: null };

describe("deriveSelectorOptions", () => {
  it("offers every dimension when nothing is pinned", () => {
    const options = deriveSelectorOptions(FACTS, NO_PINS);
    expect(options.sources.map((o) => o.value)).toEqual([String(NARMAYA), String(EUGEN)]);
    expect(options.targets.map((o) => o.value)).toEqual([String(BOSS), String(ADD)]);
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
    const options = deriveSelectorOptions(FACTS, { ...NO_PINS, source: NARMAYA, targetIds: [ADD] });
    expect(options.abilities.map((o) => o.value)).toEqual(["Normal:200"]);
  });

  it("keeps two players on the same character apart", () => {
    // An online party can hold two of the same character, so keying sources on
    // the character hash would merge them into one row and one pin.
    const twins: SelectionFact[] = [
      { sourceActorType: NARMAYA_HASH, sourceIndex: 0, targetId: BOSS, ability: { Normal: 100 } },
      { sourceActorType: NARMAYA_HASH, sourceIndex: 2, targetId: BOSS, ability: { Normal: 900 } },
    ];

    expect(deriveSelectorOptions(twins, NO_PINS).sources.map((o) => o.value)).toEqual(["0", "2"]);
    expect(deriveSelectorOptions(twins, { ...NO_PINS, source: 2 }).abilities.map((o) => o.value)).toEqual([
      "Normal:900",
    ]);
  });

  it("returns empty lists for an empty fact set", () => {
    const options = deriveSelectorOptions([], NO_PINS);
    expect(options.sources).toEqual([]);
    expect(options.targets).toEqual([]);
    expect(options.abilities).toEqual([]);
  });
});
