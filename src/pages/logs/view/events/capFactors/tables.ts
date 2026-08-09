import capUpSources from "@/assets/cap-up-sources.json";
import { toHashString } from "@/utils";

import type { CapClass } from "../capSources";

/** Which slot of a table row holds each attack class's value. */
const SLOT: Record<CapClass, number> = { normal: 0, skill: 1, sba: 2 };

export const traitTable = capUpSources.traits as Record<string, number[][]>;
export const conditionalTraitTable = capUpSources.conditionalTraits as Record<string, number[][]>;
/** The extra cap-up block the three boundary weapon traits carry, which applies
 * only while the equipped weapon is transcended. */
export const transcendedTraitTable = capUpSources.transcendedTraits as Record<string, number[][]>;
export const overmasteryClass = capUpSources.overmasteries as Record<string, CapClass>;
export const summonBonusClass = capUpSources.summonBonuses as Record<string, CapClass>;

/** A conditional trait's gate columns, per level — the thresholds and band ends
 * its own effect text points at. See `gen-cap-up-sources.py`. */
const conditionalInputs = capUpSources.conditionalTraitInputs as Record<string, Record<string, number[]>>;

/** The whole three-class row a trait table holds at a combined level, or `null`
 * when the table has no row to offer.
 *
 * Levels past the trait's top row are wasted, not extrapolated — the game stops
 * scaling at its last row, which is what the Builds tab flags. */
export const traitRow = (table: Record<string, number[][]>, id: number, level: number): number[] | null => {
  const levels = table[toHashString(id)];
  if (levels === undefined) return null;
  return levels[Math.min(level, levels.length) - 1] ?? null;
};

/** One class's percentage out of that row. */
export const traitRowValue = (
  table: Record<string, number[][]>,
  id: number,
  level: number,
  capClass: CapClass
): number => traitRow(table, id, level)?.[SLOT[capClass]] ?? 0;

/**
 * One named gate column of a conditional trait at a combined level.
 *
 * Clamped to the table's last row for the same reason the value rows are: past
 * its top level a trait stops scaling rather than extrapolating, and a gate
 * read off the end would be `undefined` — which compares false against every
 * threshold and would silently switch the trait off.
 */
export const traitInput = (id: number, level: number, name: string): number | null => {
  const values = conditionalInputs[toHashString(id)]?.[name];
  if (values === undefined || values.length === 0) return null;
  return values[Math.min(level, values.length) - 1];
};
