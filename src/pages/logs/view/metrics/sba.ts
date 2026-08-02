import type { MetricDescriptor, MetricRow } from "./types";

/** SBA is a per-player gauge with no ability decomposition, so this descriptor
 * ignores `level` entirely and never offers a pin. The governing rule still
 * holds — there is simply no more specific dimension to descend into. */
export const sba: MetricDescriptor = {
  labelKey: "ui.logs.metric-sba",

  columnKeys: () => ["ui.meter-columns.sba"],

  labelKind: () => "player",

  rows: ({ players }): MetricRow[] =>
    [...players]
      .sort((a, b) => b.sba - a.sba)
      .map((p) => ({
        key: `player:${p.index}`,
        label: String(p.index),
        value: p.sba,
        columns: [p.sba.toFixed(2)],
        pinOnClick: null,
        colorSlot: p.partyIndex,
      })),
};

