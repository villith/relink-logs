import { HP_SERIES_COLORS, mantineColorVar } from "../DetailCharts";

/** Categorical colours for the status tables' slotless rows (effect rows, and
 * enemy holder rows), assigned in table order from the same palette the chart
 * bands and the stacks plot already draw with — so a row, its uptime pieces
 * and its shaded band are one colour.
 *
 * Player holder rows are skipped entirely: they keep their party colour, and
 * they must not consume a categorical position either. */
export const statusRowColors = (rows: { key: string; colorSlot: number }[]): Map<string, string> => {
  const colors = new Map<string, string>();
  let position = 0;
  for (const row of rows) {
    if (row.colorSlot >= 0) continue;
    colors.set(row.key, mantineColorVar(HP_SERIES_COLORS[position % HP_SERIES_COLORS.length]));
    position += 1;
  }
  return colors;
};
