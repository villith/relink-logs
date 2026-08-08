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
import { windowChips, type WindowChipGroup } from "../windowChips";
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

/** Several auras' masks, folded into the time they were ALL up.
 *
 * Intersection is what the multi-select is for: three effects ticked asks "what
 * did we do under all three", and a union would answer "under any of them",
 * which the tiles can already say one at a time. An empty result is a real
 * answer — the stack never lined up — and narrows the view to nothing, which is
 * the honest reading rather than a reason to fall back to a wider mask.
 *
 * No masks at all is `undefined` ("no aura filter"), and exactly one passes
 * through BY REFERENCE for the same memoisation reason `combineMasks` does. */
export const intersectMasks = (masks: WireWindow[][]): WireWindow[] | undefined => {
  if (masks.length === 0) return undefined;
  return masks.reduce((left, right) => intersectWireWindows(left, right));
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
  /** How much of the chart window the AURAS alone admit, 0–100 (rounded) —
   * null with fewer than two selected, where each tile's own uptime already
   * says it and a second figure repeating one tile would only confuse.
   *
   * Auras only, not the combined mask: this answers "how much of the fight had
   * the whole stack up", and folding the battle-window filter in would make one
   * number move when an unrelated control changed. */
  auraStackPercent: number | null;
};

/** The CHIP half: the filter UI, which needs the naming the fetch enables. */
export type FilterChips = {
  sourceAuraChips: AuraChip[];
  targetAuraChips: AuraChip[];
  windowFilterGroups: WindowChipGroup[];
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
  /** The resolved fetch's auras, possibly empty — the resolver has already
   * decided which of a hand-edited URL's auras belong in the query at all. */
  fetchAuras: string[];
};

export const useChartWindow = ({
  state,
  range,
  chartLen,
  bucketMs,
  statusIntervals,
  chartWindows,
  hostility,
  fetchAuras,
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

  // The active auras' admitted windows — for each, the pinned holder's
  // intervals of that effect clipped to the chart window, then INTERSECTED into
  // the time they were all up together. Undefined = no aura in the query; an
  // EMPTY array is a real mask and narrows to nothing.
  //
  // An aura whose anchor resolves to no pin contributes NOTHING rather than an
  // empty mask: the resolver has already dropped those, so reaching one here
  // means a pin cleared mid-render, and masking the fight to nothing over it
  // would blank the view for a filter no chip is showing.
  const auraWindows = useMemo(() => {
    const masks = fetchAuras.flatMap((aura) => {
      const anchor = auraAnchorOf(aura);
      const index = anchor === "source" ? state.source : state.target;
      if (anchor === null || index === null) return [];
      const holder = auraHolderFor(anchor, hostility, index);
      return [wireWindowsFrom(auraHolderIntervals(statusIntervals, auraPinKey(aura), holder), statusWindow)];
    });
    return intersectMasks(masks);
  }, [fetchAuras, state.source, state.target, hostility, statusIntervals, statusWindow]);

  // The window filter's admitted spans — the UNION of every selected window
  // (`selectedChartWindows`), merged by `wireWindowsFrom`. Undefined = no
  // filter; an EMPTY array is a real mask (every selected index went stale) and
  // narrows to nothing.
  const windowFilterWindows = useMemo(
    () =>
      state.win.length === 0 ? undefined : wireWindowsFrom(selectedChartWindows(chartWindows, state.win), statusWindow),
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

  // Measured off the folded mask rather than by summing the tiles': two effects
  // each up 60% of the fight overlap somewhere between 20% and 60% of it, and
  // only the intersection knows where.
  const auraStackPercent = useMemo(() => {
    if (fetchAuras.length < 2 || auraWindows === undefined || fightDurationMs === 0) return null;
    const held = auraWindows.reduce((sum, span) => sum + (span.upToMs - span.fromMs), 0);
    return Math.min(100, Math.round((held / fightDurationMs) * 100));
  }, [fetchAuras.length, auraWindows, fightDurationMs]);

  return { statusWindow, fightDurationMs, windowedIntervals, maskWindows, maskedIntervals, auraStackPercent };
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
            selected: state.aura.includes(`${anchor}:${key}`),
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

  // The Windows strip's chips: the filter UI for the battle windows, one group
  // per kind present.
  const windowFilterGroups = useMemo(
    () =>
      windowChips(chartWindows, state.win, {
        kindLabel: (kind) => t(WINDOW_LABEL_KEY[kind]),
        totalLabel: (count) => t("ui.logs.window-chip-total", { count }),
        selectedLabel: (selected, total) => t("ui.logs.window-chip-selected", { selected, total }),
        rangeLabel: (startMs, endMs) => `${millisecondsToElapsedFormat(startMs)}–${millisecondsToElapsedFormat(endMs)}`,
        durationLabel: (ms) => t("ui.logs.window-chip-duration", { seconds: Math.round(ms / 1000) }),
        breakEnemyLabel: (actorIndex, span) => breakEnemyOf(actorIndex, span),
      }),
    // i18n.language: the kind and duration labels are translated.
    [chartWindows, state.win, t, breakEnemyOf, i18n.language]
  );

  return { sourceAuraChips, targetAuraChips, windowFilterGroups };
};
