import type { ChartWindow } from "@/types";

import type { ReportLine } from "./machine/actionLog";
import type { MetricCapabilities } from "./machine/capabilities";
import type { ViewSpec } from "./machine/resolve";
import type { AnalysisState } from "./machine/state";
import type { WireWindow } from "./wireWindows";

export type DebugReadoutInput = {
  state: AnalysisState;
  spec: ViewSpec;
  caps: MetricCapabilities;
  /** The resolved body, not the raw `tab` param. */
  body: string;
  /** Whether the rows on screen answer the CURRENT grouping. */
  settled: boolean;
  /** `chartPresentation`'s answer, which is decided by the series that won
   * rather than by the state that asked — so it can differ from the spec. */
  chartFormat: string;
  smoothing: number;
  merge: boolean;
  streamer: boolean;
  displayNames: boolean;
  rows: number;
  mask: WireWindow[] | undefined;
  windows: ChartWindow[];
};

const yesNo = (value: boolean): string => (value ? "yes" : "no");
const onOff = (value: boolean): string => (value ? "on" : "off");

/** The mask, with "no filter" told apart from "a filter admitting nothing".
 * They render identically — an empty table — and mean opposite things. */
const maskText = (mask: WireWindow[] | undefined): string => {
  if (mask === undefined) return "none";
  return mask.length === 0 ? "0 (admits nothing)" : String(mask.length);
};

/** How many battle windows of each kind the fight offers, in the strip's own
 * order. Zero-count kinds drop out; nothing at all says so. */
const windowsText = (windows: ChartWindow[]): string => {
  const kinds: ChartWindow["kind"][] = ["sba", "link", "break"];
  const counted = kinds
    .map((kind) => ({ kind, count: windows.filter((window) => window.kind === kind).length }))
    .filter(({ count }) => count > 0);
  return counted.length === 0 ? "—" : counted.map(({ kind, count }) => `${kind}:${count}`).join(" ");
};

/** The state block above the action trail: what the view is asking for right
 * now, in the terms that decide it.
 *
 * Every line answers a question the query string alone cannot. The URL says
 * which pins are set; this says what the machine resolved them INTO, what it
 * asked the backend for, whether the rows have caught up, and which stored
 * settings are colouring the reading. A report carrying only the address makes
 * the reader re-run the resolver in their head. */
export const buildDebugReadout = ({
  state,
  spec,
  caps,
  body,
  settled,
  chartFormat,
  smoothing,
  merge,
  streamer,
  displayNames,
  rows,
  mask,
  windows,
}: DebugReadoutInput): ReportLine[] => [
  { label: "state", value: JSON.stringify(state) },
  { label: "spec", value: `groupBy=${spec.groupBy} body=${body} settled=${yesNo(settled)}` },
  { label: "chart", value: `source=${spec.chart.source} format=${chartFormat} smoothing=${smoothing}` },
  {
    label: "fetch",
    // The whole query, not a boolean: which ActorRefs it names, whether the
    // ability pin survived into it and which auras rode along are exactly what
    // explains a table nobody expected.
    value: spec.fetch === null ? `(none — ${caps.dataPath} path)` : JSON.stringify(spec.fetch),
  },
  {
    label: "caps",
    value: [
      `dataPath=${caps.dataPath}`,
      `hostility=${yesNo(caps.supportsHostility)}`,
      `supp=${yesNo(caps.recordsSupplementary)}`,
      `aura=${yesNo(caps.supportsAuraFilter)}`,
    ].join(" "),
  },
  {
    label: "view",
    value: `merge=${onOff(merge)} streamer=${onOff(streamer)} names=${onOff(displayNames)}`,
  },
  { label: "counts", value: `rows=${rows} mask=${maskText(mask)} windows=${windowsText(windows)}` },
];
