import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { statusIconUrl } from "@/statusIcon";
import type { ChartWindow, StatusInterval } from "@/types";
import { millisecondsToElapsedFormat } from "@/utils";

import type { Hostility } from "../../metrics/types";
import { clipToWindow, uptimeMs } from "../../statusUptime";
import type { AuraChip } from "../AuraStrip";
import { auraHolderFor, auraHolderIntervals, heldBy } from "../auraWindows";
import { WINDOW_LABEL_KEY } from "../chartWindowBands";
import { intersectWireWindows, maskStatusIntervals, selectedChartWindows } from "../chartWindowFilter";
import { auraAnchorOf, auraPinKey, type AnalysisState } from "../machine/state";
import { statusIdOfKey } from "../statusLabel";
import { windowChips, type WindowChip } from "../windowChips";
import { wireWindowsFrom, type WireWindow } from "../wireWindows";

import { groupByPinKey } from "./useStatusNaming";

/** The aura filter and the battle-window filter, combined into the ONE mask
 * every consumer reads — the group query, the derived reparse, the uptime
 * tables and the excluded shading — so the table, the hover cards and the plot
 * all answer for the same filtered fight.
 *
 * `undefined` means "no filter at all" and leaves the fight whole. An EMPTY
 * array is a real mask, not an absent one: the effect was never up inside the
 * window, or a chip resolved to a stale index, and the aggregator masks
 * everything for it. Treating `[]` as falsy here would widen the fight back to
 * the other filter's spans and show damage the active filter excluded — which
 * is why the two are tested against `undefined` rather than for truthiness.
 *
 * Either filter alone passes through BY REFERENCE: the caller memoises these,
 * and rebuilding one would hand every consumer a fresh identity each render. */
export const combineMasks = (
  aura: WireWindow[] | undefined,
  windows: WireWindow[] | undefined
): WireWindow[] | undefined => {
  if (aura === undefined) return windows;
  if (windows === undefined) return aura;
  return intersectWireWindows(aura, windows);
};

/** The WINDOW half: everything the fetches need, and nothing that needs a
 * name.
 *
 * Split from the chip half below because the view's ordering forces it. The
 * masks ride the group query, so they must be resolved BEFORE the fetch
 * effects; the chips are labelled through `statusDisplayLabel`, which needs the
 * party the fetch returns. One hook spanning both would have to be called
 * before its own inputs existed. */
export type ChartWindowModel = {
  /** The window the status tables measure, in ms from the fight's start. */
  statusWindow: { startMs: number; endMs: number };
  /** That window's own length — the uptime denominator, so a scrubbed table
   * reports uptime WITHIN the window rather than diluting it across a fight
   * the chart is no longer showing. */
  fightDurationMs: number;
  /** Intervals cropped to the window, so numerator and denominator measure one
   * span. The chips and selector options read THIS, not the masked form: they
   * are pick lists, and a filter must not hide the things that operate it. */
  windowedIntervals: StatusInterval[];
  /** The combined aura ∩ window mask, or undefined for no filter. */
  maskWindows: WireWindow[] | undefined;
  /** The masked intervals the buffs/debuffs tables measure. */
  maskedIntervals: StatusInterval[];
};

/** The CHIP half: the filter UI, which needs the naming the fetch enables. */
export type FilterChips = {
  sourceAuraChips: AuraChip[];
  targetAuraChips: AuraChip[];
  windowFilterChips: WindowChip[];
};

export type ChartWindowInput = {
  state: AnalysisState;
  /** The committed scrub, as [start, end] bucket indexes; null = whole fight. */
  range: [number, number] | null;
  chartLen: number;
  bucketMs: number;
  statusIntervals: StatusInterval[];
  chartWindows: ChartWindow[];
  /** The EFFECTIVE side — a metric with no enemy side reads friendly. */
  hostility: Hostility;
  /** The resolved fetch's aura, or null — the resolver has already decided
   * whether a hand-edited URL's aura belongs in the query at all. */
  fetchAura: string | null;
};

export const useChartWindow = ({
  state,
  range,
  chartLen,
  bucketMs,
  statusIntervals,
  chartWindows,
  hostility,
  fetchAura,
}: ChartWindowInput): ChartWindowModel => {
  // The window the status tables measure, in milliseconds from the fight's
  // start. Buckets are inclusive at both ends, so the last one runs to the
  // start of the one after it — the same conversion the scoped fetch and the
  // chart bands use, kept in one place so the three cannot drift.
  const statusWindow = useMemo(
    () => ({
      startMs: (range === null ? 0 : range[0]) * bucketMs,
      endMs: (range === null ? chartLen : range[1] + 1) * bucketMs,
    }),
    [range, chartLen, bucketMs]
  );

  // The uptime denominator: the window's own length. The window spans whole
  // buckets, so it is never SHORTER than the intervals inside it — which is
  // what a `(chartLen - 1)` denominator was, against intervals the backend
  // closes at the exact final millisecond.
  const fightDurationMs = statusWindow.endMs - statusWindow.startMs;

  // Cropped to that same window, so numerator and denominator measure one span.
  const windowedIntervals = useMemo(
    () => clipToWindow(statusIntervals, statusWindow.startMs, statusWindow.endMs),
    [statusIntervals, statusWindow]
  );

  // The active aura's admitted windows — the pinned holder's intervals of the
  // chosen effect, clipped to the chart window. Undefined = no aura in the
  // query; an EMPTY array is a real mask and narrows to nothing.
  const auraWindows = useMemo(() => {
    if (fetchAura === null) return undefined;
    const anchor = auraAnchorOf(fetchAura);
    const index = anchor === "source" ? state.source : state.target;
    if (anchor === null || index === null) return undefined;
    const holder = auraHolderFor(anchor, hostility, index);
    return wireWindowsFrom(auraHolderIntervals(statusIntervals, auraPinKey(fetchAura), holder), statusWindow);
  }, [fetchAura, state.source, state.target, hostility, statusIntervals, statusWindow]);

  // The window filter's admitted spans. Undefined = no filter; an EMPTY array
  // is a real mask (a stale individual index) and narrows to nothing.
  const windowFilterWindows = useMemo(
    () =>
      state.win === null ? undefined : wireWindowsFrom(selectedChartWindows(chartWindows, state.win), statusWindow),
    [state.win, chartWindows, statusWindow]
  );

  const maskWindows = useMemo(() => combineMasks(auraWindows, windowFilterWindows), [auraWindows, windowFilterWindows]);

  // The buffs/debuffs tables under the filter: intervals clipped to the
  // admitted spans, so uptime reports only masked time. `applications` is
  // re-counted per `maskStatusIntervals`'s start-attribution rule — a piece
  // counts only in the span containing the interval's original apply moment —
  // so a buff spanning several admitted spans is still Count 1, not one per
  // piece.
  const maskedIntervals = useMemo(
    () => (maskWindows === undefined ? windowedIntervals : maskStatusIntervals(windowedIntervals, maskWindows)),
    [windowedIntervals, maskWindows]
  );

  return { statusWindow, fightDurationMs, windowedIntervals, maskWindows, maskedIntervals };
};

export type FilterChipsInput = {
  state: AnalysisState;
  hostility: Hostility;
  /** Whether this metric's aura chip strips operate at all. */
  supportsAuraFilter: boolean;
  /** From `useChartWindow` — the chips read the UNmasked window, because they
   * are pick lists and a filter must not hide the things that operate it. */
  windowedIntervals: StatusInterval[];
  fightDurationMs: number;
  chartWindows: ChartWindow[];
  statusDisplayLabel: (key: string) => string;
  breakEnemyOf: (actorIndex: number | null, span: { startMs: number; endMs: number }) => string | null;
};

export const useFilterChips = ({
  state,
  hostility,
  supportsAuraFilter,
  windowedIntervals,
  fightDurationMs,
  chartWindows,
  statusDisplayLabel,
  breakEnemyOf,
}: FilterChipsInput): FilterChips => {
  const { t, i18n } = useTranslation();

  // The aura chip strips (WCL's Source/Target Auras Filter): the effects the
  // pinned actor held inside the current chart window, uptime measured against
  // that same window. Which universe the pin names follows the hostility
  // role-mapping (`universeOf`), the same rule the group query's refs use — so
  // a source chip strip on the enemy side is that SPAWN's effects, not a
  // player's.
  const auraChipsFor = useCallback(
    (anchor: "src" | "tgt"): AuraChip[] => {
      const dim = anchor === "src" ? ("source" as const) : ("target" as const);
      const index = anchor === "src" ? state.source : state.target;
      if (index === null) return [];
      const holder = auraHolderFor(dim, hostility, index);
      const held = windowedIntervals.filter((interval) => heldBy(interval, holder));
      // The same one-pass grouping the row labels use (see `groupByPinKey`),
      // over this holder's windowed subset rather than the whole fight.
      return [...groupByPinKey(held).entries()]
        .map(([key, group]) => {
          // The same art the effects table shows beside the same name — the
          // chip is that row's filter form, so the two must wear one picture.
          const statusId = statusIdOfKey(key);
          const iconUrl = statusId === null ? undefined : statusIconUrl(statusId);
          return {
            aura: `${anchor}:${key}`,
            label: statusDisplayLabel(key),
            uptimePercent:
              fightDurationMs === 0 ? 0 : Math.min(100, Math.round((uptimeMs(group) / fightDurationMs) * 100)),
            selected: state.aura === `${anchor}:${key}`,
            ...(iconUrl === undefined ? {} : { iconUrl }),
          };
        })
        .sort((a, b) => b.uptimePercent - a.uptimePercent);
    },
    [state.source, state.target, state.aura, hostility, windowedIntervals, statusDisplayLabel, fightDurationMs]
  );

  const sourceAuraChips = useMemo(
    () => (supportsAuraFilter ? auraChipsFor("src") : []),
    [supportsAuraFilter, auraChipsFor]
  );
  const targetAuraChips = useMemo(
    () => (supportsAuraFilter ? auraChipsFor("tgt") : []),
    [supportsAuraFilter, auraChipsFor]
  );

  // The Windows strip's chips: the filter UI for the battle windows.
  const windowFilterChips = useMemo(
    () =>
      windowChips(chartWindows, state.win, {
        kindLabel: (kind) => t(WINDOW_LABEL_KEY[kind]),
        kindChipLabel: (label, count) => t("ui.logs.window-chip-kind", { label, count }),
        rangeLabel: (startMs, endMs) => `${millisecondsToElapsedFormat(startMs)}–${millisecondsToElapsedFormat(endMs)}`,
        durationLabel: (ms) => t("ui.logs.window-chip-duration", { seconds: Math.round(ms / 1000) }),
        breakEnemyLabel: (actorIndex, span) => breakEnemyOf(actorIndex, span),
      }),
    // i18n.language: the kind and duration labels are translated.
    [chartWindows, state.win, t, breakEnemyOf, i18n.language]
  );

  return { sourceAuraChips, targetAuraChips, windowFilterChips };
};
