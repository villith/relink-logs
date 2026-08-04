import type { MetricDescriptor, MetricRow } from "./types";

/** Shown where the backend served no generated total — a log served by a
 * binary older than the field. A zero would claim the player built no gauge. */
const NOT_RECORDED = "—";

/** Gauge units are tenths of a percent; sub-unit precision is noise at the
 * magnitudes a fight produces, and a suffix would only lose precision. */
const whole = (value: number): string => String(Math.round(value));

/** SBA is a per-player gauge. The rows rank by the gauge each player
 * GENERATED — the level they happen to hold at the end of the fight is what
 * made every row read 0.0, because a player who burst finishes at zero.
 *
 * No pin: there is no per-ability attribution on the wire yet, so there is
 * nothing more specific to descend into. */
export const sba: MetricDescriptor = {
  labelKey: "ui.logs.metric-sba",

  columnKeys: () => ["ui.meter-columns.sba-generated", "ui.meter-columns.sba"],

  labelKind: () => "player",

  rows: ({ players }): MetricRow[] =>
    [...players]
      .map((player) => ({ player, generated: player.sbaGenerated }))
      .sort((a, b) => (b.generated ?? b.player.sba) - (a.generated ?? a.player.sba))
      .map(({ player, generated }) => ({
        key: `player:${player.index}`,
        label: String(player.index),
        // The bar ranks by contribution where it is known, and by the level
        // where it is not — the honest fallback for an older payload.
        value: generated ?? player.sba,
        columns: [generated === undefined ? NOT_RECORDED : whole(generated), whole(player.sba)],
        pinOnClick: null,
        colorSlot: player.partyIndex,
      })),
};
