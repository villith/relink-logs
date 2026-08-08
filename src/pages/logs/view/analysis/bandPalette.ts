import type { GroupReference } from "@/types";

import { HP_SERIES_COLORS, mantineColorVar } from "../DetailCharts";
import type { RowKeying } from "../abilitySkills";

import { bandKeyOf } from "./machine/groupRows";

/** The hues, read off the chart palette itself so the two cannot drift. */
const BAND_HUES = HP_SERIES_COLORS.map((color) => color.split(".")[0]);

/** The shade each lap through the hues takes. Lap 0 is 6 — `HP_SERIES_COLORS`
 * exactly — so every index the old positional palette could reach still renders
 * the colour it always did. */
const BAND_SHADES = [6, 3, 8];

export const BAND_COLOR_COUNT = BAND_HUES.length * BAND_SHADES.length;

/** The colour for one chart band, by its rank in the REFERENCE ordering.
 *
 * Ranks index this directly, so its length is what decides whether two drawn
 * bands can share a colour: they collide only where their reference ranks are
 * congruent modulo it. At the bare twelve hues a busy fight reached that; laps
 * of shade put it out of reach without inventing hues that read as a band's
 * neighbour. */
export const bandColorAt = (index: number): string => {
  const at = ((index % BAND_COLOR_COUNT) + BAND_COLOR_COUNT) % BAND_COLOR_COUNT;
  return mantineColorVar(`${BAND_HUES[at % BAND_HUES.length]}.${BAND_SHADES[Math.floor(at / BAND_HUES.length)]}`);
};

/** Palette index per band key: its rank in the reference, or the next index
 * past the reference for a band the reference never produced.
 *
 * This is the whole fix. Colouring by the CURRENT rank repainted the chart
 * whenever a filter reordered it — the same fault `actorColor` already refuses
 * for enemies ("a position moves when the fight's damage ordering does").
 * Colouring by the reference rank moves with the actor and the grouping, which
 * genuinely change what the bands are, and with nothing else.
 *
 * An empty reference reproduces the drawn order, so a view with no reference
 * yet looks exactly as it did before this existed. */
export const paletteOrderOf = (referenceKeys: readonly string[], liveKeys: readonly string[]): Map<string, number> => {
  const order = new Map<string, number>();
  for (const key of referenceKeys) if (!order.has(key)) order.set(key, order.size);
  for (const key of liveKeys) if (!order.has(key)) order.set(key, order.size);
  return order;
};

/** The backend's whole-fight totals folded into BANDS and ranked largest-first
 * — the reference ordering `paletteOrderOf` colours by.
 *
 * Folded through `bandKeyOf`, the same grammar the plot's own bands use, and
 * summed BEFORE ranking: one band is often several aggregate keys, which is
 * exactly why the backend sends amounts rather than ranks of its own.
 *
 * Empty in, empty out — and the backend deliberately sends nothing when the
 * query narrowed no time, because the aggregates it did send already are this
 * ranking. */
export const referenceBandOrder = (reference: readonly GroupReference[], keying?: RowKeying): string[] => {
  const totals = new Map<string, number>();
  for (const { key, amount } of reference) {
    if (key.kind === "other") continue;
    const bandKey = bandKeyOf(key, keying);
    totals.set(bandKey, (totals.get(bandKey) ?? 0) + amount);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
};
