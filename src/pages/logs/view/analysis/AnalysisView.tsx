import { Box } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { PillGroup } from "@/components/ui/PillGroup";
import { useAnalysisPanesStore } from "@/stores/useAnalysisPanesStore";
import { useLogLibraryStore } from "@/stores/useLogLibraryStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore, type CompareChartMode } from "@/stores/useMeterSettingsStore";
import { toggled } from "@/utils";

import { DPS_SMOOTHING_WINDOW } from "../DetailCharts";
import type { Hostility } from "../metrics/types";

import { ActorBar } from "./ActorBar";
import { AnalysisPane } from "./AnalysisPane";
import { AnalysisTopBar } from "./AnalysisTopBar";
import { CollapseSupplementaryToggle } from "./CollapseSupplementaryToggle";
import { CompareChart } from "./CompareChart";
import { type EndLine, type StackMode } from "./DpsChart";
import { HostilityToggle } from "./HostilityToggle";
import { MetricTabs } from "./MetricTabs";
import "./analysis.css";
import { METRIC_TABS, TABLE_TAB, VIEW_TABS, bodyFor } from "./analysisTabs";
import type { MarkerKind } from "./chartMarkers";
import type { WindowKind } from "./chartWindowBands";
import { paneSeriesColor, paneSeriesLabel } from "./compareSeries";
import { CAPABILITIES } from "./machine/capabilities";
import { SHARED_FIELDS, decodeCompare, encodeCompare, paneParamNames, removeCompareAt } from "./machine/paneParams";
import { paneRemovalWrites, sharedControlWrites } from "./machine/paneWrites";
import type { MetricKey } from "./machine/state";
import { setHostility as hostilityTransition, setMetric as metricTransition, scrubWindow } from "./machine/transitions";
import { useAnalysisState } from "./machine/useAnalysisState";

/** Hoisted so the initial states are one identity across renders. */
const EMPTY_MARKER_KINDS: ReadonlySet<MarkerKind> = new Set();
const EMPTY_WINDOW_KINDS: ReadonlySet<WindowKind> = new Set();

/** **+ Compare**, and the ✕ that undoes it, in the view's own palette rather
 * than Mantine's stock button — they ride the actor bar, a row built entirely
 * from these tokens.
 *
 * ONE class for both because they are one control in two states: the row's
 * right edge opens a second log, and once open, closes it again. A ✕ that
 * lived somewhere else would make the reader look for the undo of something
 * they had just done here. */
const PANE_BUTTON_CLASS = [
  "inline-flex h-control min-h-control cursor-pointer items-center rounded-sm px-2.5",
  "border border-line bg-panel text-sm font-semibold text-ink-2",
  "hover:border-line-strong hover:text-ink focus:border-accent",
].join(" ");

/** The Analysis view's frame: the shared actor bar, the controls every pane
 * shares, and one `<AnalysisPane>` per log.
 *
 * Everything about a log — its fetches, its pins, its chart and its body —
 * belongs to the pane, so a second log is a second pane rather than a second
 * copy of the view. What stays here is what the panes SHARE: which metric,
 * which side, which body, and the comparison itself.
 *
 * The log in the path is pane 0, whose URL keys are the BARE ones every link
 * written before compare existed already carries (see `paneParamName`); the
 * rest ride the `compare` list. */
export const AnalysisView = () => {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const filters = useMeterFilters();

  const logs = useLogLibraryStore((state) => state.logs);
  const loadLibrary = useLogLibraryStore((state) => state.load);
  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const [compare, setCompare] = useQueryState("compare", { history: "replace" });
  // Pane 0 is the log in the path; the rest are the comparison list.
  const paneLogIds = useMemo(() => [Number(id), ...decodeCompare(compare)], [id, compare]);
  const paneCount = paneLogIds.length;

  const setPaneLogs = useAnalysisPanesStore((state) => state.setPaneLogs);
  // Seeded during RENDER, not in an effect: a pane's fetch is dispatched from
  // its own mount effect, which React runs before the parent's, and a response
  // aimed at a pane the store does not know about is dropped rather than
  // resurrecting a closed pane (see `writeAt`). Doing it here means the slices
  // exist before any pane has rendered, let alone fetched.
  //
  // It cannot loop because the memo re-runs only when `paneLogIds` changes and
  // the write is idempotent — NOT because nothing here is subscribed: this
  // component reads `panes` twice below (`paneCharts`, `paneSources`) and every
  // mounted pane reads its own slice. Both selectors are `useShallow`ed and
  // `setPaneLogs` reuses an unchanged slice by identity, which is what keeps
  // the render-phase write from notifying anyone. A selector added here without
  // `useShallow` would break that.
  useMemo(() => setPaneLogs(paneLogIds), [paneLogIds, setPaneLogs]);

  // EVERY pane's keys, in one subscription. The frame needs a bulk reader and a
  // bulk writer for the two jobs no single pane can do: applying a shared
  // control to all of them at once, and shifting the suffixed keys down when a
  // pane in the middle closes. One `setQueryStates` call is also one history
  // entry, so a removal cannot half-apply.
  //
  // One index PAST the open panes is registered too: `addPane` clears the keys
  // of the index it is about to open, and a `useQueryStates` setter only writes
  // keys its own map declares.
  const paneParamKeys = useMemo(
    () =>
      Object.fromEntries(
        [...SHARED_FIELDS, ...Array.from({ length: paneCount + 1 }, (_, index) => paneParamNames(index)).flat()].map(
          (key) => [key, parseAsString]
        )
      ),
    [paneCount]
  );
  const [paneParams, setPaneParams] = useQueryStates(paneParamKeys, { history: "replace" });
  // Coalesced: nuqs reports `undefined` for one render after its key set
  // changes, which adding a pane still does, and the writers below read every
  // key of every pane.
  const readParam = useCallback((key: string) => paneParams[key] ?? null, [paneParams]);

  // The frame's own reading of the SHARED fields. Pane 0's state carries them
  // (they are unsuffixed, so every pane's does) — this is a read, and the write
  // goes through `applyShared` so no pane is left behind.
  const [state] = useAnalysisState(0);
  const caps = CAPABILITIES[state.metric];
  const hostility: Hostility = caps.supportsHostility ? state.hostility : "friendly";
  const [tab, setTab] = useQueryState("tab", { history: "replace" });

  // How the comparison is plotted. Inert with one log open — there is nothing
  // to overlay, and the pane draws its own full chart either way.
  const compareChartMode = useMeterSettingsStore((settings) => settings.compare_chart_mode);
  const collapseSupplementary = useMeterSettingsStore((settings) => settings.merge_supplementary);
  const setSettings = useMeterSettingsStore((settings) => settings.set);
  const comparing = paneCount > 1;
  // One entry per pane, published by the panes themselves (see `PaneChart`).
  const paneCharts = useAnalysisPanesStore(useShallow((panes) => panes.panes.map((pane) => pane.chart)));

  // What the overlay's ONE axis would be read in — and whether there is one.
  //
  // `format` is not a property of the metric: `chartPresentation` derives it
  // from each pane's own `chartSource`, which the PANE-scoped pins and grouping
  // decide. Undrilled SBA is a percent (the gauge LEVEL); drilled by ability it
  // is an amount (gauge GENERATED per bucket), and the two also smooth
  // differently. Plotting one under the other's axis is not a comparison, so a
  // disagreement falls back to the split layout, where each reading keeps its
  // own axis. Panes that have not published a plot yet are ignored rather than
  // counted as a disagreement — the layout must not flip while the fights load,
  // and an empty set trivially agrees.
  const drawnFormats = paneCharts.filter((chart) => chart.totals.length > 0).map((chart) => chart.format);
  const formatsAgree = drawnFormats.every((format) => format === drawnFormats[0]);
  const sharedFormat = drawnFormats[0] ?? "amount";
  const overlaid = comparing && compareChartMode === "overlay" && formatsAgree;
  // Likewise for the shared actor bar: each pane's source universe, its pin and
  // its own handler for moving it (see `PaneSources`).
  const paneSources = useAnalysisPanesStore(useShallow((panes) => panes.panes.map((pane) => pane.sources)));

  // The chart controls EVERY pane's plot shares. Held here rather than per pane:
  // two runs drawn under different smoothing windows, or one stacked against one
  // overlapped, are two readings and not a comparison — the split layout draws
  // two plots of the same thing, so it must not offer two sets of knobs.
  //
  // Reset per metric, because a mode chosen for one chart says nothing about the
  // next. Deliberately NOT reset per log any more: with two logs open, swapping
  // one of them is not a reason to re-read the other.
  const [stackMode, setStackMode] = useState<StackMode>("normal");
  const [rateSmoothing, setRateSmoothing] = useState<number>(DPS_SMOOTHING_WINDOW);
  const [hiddenMarkerKinds, setHiddenMarkerKinds] = useState<ReadonlySet<MarkerKind>>(EMPTY_MARKER_KINDS);
  const [hiddenWindowKinds, setHiddenWindowKinds] = useState<ReadonlySet<WindowKind>>(EMPTY_WINDOW_KINDS);
  useEffect(() => setStackMode("normal"), [state.metric]);

  const toggleMarkerKind = useCallback((kind: MarkerKind) => setHiddenMarkerKinds((set) => toggled(set, kind)), []);
  const toggleWindowKind = useCallback((kind: WindowKind) => setHiddenWindowKinds((set) => toggled(set, kind)), []);

  const chartControls = useMemo(
    () => ({
      stackMode,
      setStackMode,
      rateSmoothing,
      setRateSmoothing,
      hiddenMarkerKinds,
      toggleMarkerKind,
      hiddenWindowKinds,
      toggleWindowKind,
    }),
    [stackMode, rateSmoothing, hiddenMarkerKinds, toggleMarkerKind, hiddenWindowKinds, toggleWindowKind]
  );

  // Where each pane's fight ran out, on the shared axis. A run that is the
  // longest has nothing to mark — `DpsChart` drops a line at or past its own
  // last bucket — so this is built for every pane and filtered there, in one
  // place, rather than each caller deciding what "shorter" means. That also
  // covers a chart's OWN end: its bucket is its own last one by construction,
  // so every pane can be handed the whole list.
  //
  // Colour and label come from `compareSeries`, the same authors the overlay's
  // lines use — the rule wears its series' colour and name, so resolving either
  // a second time here would silently decouple the rule from the line it marks.
  const paneEnds: EndLine[] = useMemo(
    () =>
      paneCharts.map((chart, paneIndex) => ({
        bucket: chart.totals.length - 1,
        color: paneSeriesColor(paneIndex),
        label: paneSeriesLabel(paneLogIds, paneIndex),
      })),
    [paneCharts, paneLogIds]
  );

  // Memoised, not spelled inline in the JSX: `CompareChart` memoises its whole
  // dataset on this array's identity, and the frame re-renders on every param
  // change in either pane.
  const perPaneTotals = useMemo(() => paneCharts.map((chart) => chart.totals), [paneCharts]);

  /** A shared control's transition, applied to every pane. Both of them also
   * clear PANE fields — a side swap invalidates every pane's actor pins — so
   * rewriting only pane 0 would leave the others pinned to a universe they are
   * no longer showing. */
  const applyShared = useCallback(
    (transition: Parameters<typeof sharedControlWrites>[2]) => {
      void setPaneParams(sharedControlWrites(paneCount, readParam, transition));
    },
    [paneCount, readParam, setPaneParams]
  );

  const changePaneLog = useCallback(
    (paneIndex: number, logId: number) => {
      // The pane's OWN keys go with the log they were resolved against. `tgt`
      // is an index into that log's spawn table, `abil` a group key its party
      // used, `win` an ordinal within its battle windows, `by` a grouping the
      // next fight need not support — carried across, they narrow the new log
      // to an unrelated enemy or to nothing, with the pin bar naming whatever
      // now sits at that index and nothing on screen saying a stale filter is
      // applied. The side and metric transitions clear these for the weaker
      // reason that the universe changed; a log swap is the stronger case of
      // it. Every OTHER pane's keys stay exactly where they are.
      const cleared = paneParamNames(paneIndex);

      // Pane 0 IS the address, so changing it is a navigation; the rest are a
      // query param.
      if (paneIndex === 0) {
        const search = new URLSearchParams(window.location.search);
        cleared.forEach((key) => search.delete(key));
        const query = search.toString();
        navigate({ pathname: `/logs/${logId}`, search: query === "" ? "" : `?${query}` }, { replace: true });
        return;
      }
      const next = [...decodeCompare(compare)];
      next[paneIndex - 1] = logId;
      void setPaneParams(Object.fromEntries(cleared.map((key) => [key, null])));
      void setCompare(encodeCompare(next));
    },
    [compare, navigate, setCompare, setPaneParams]
  );

  const removePane = useCallback(
    (paneIndex: number) => {
      const ids = decodeCompare(compare);
      const after = removeCompareAt(ids, paneIndex);
      // Derived from the RESULT: `removeCompareAt` is total, and an index that
      // removed nothing must write nothing — a blind shift-and-clear would wipe
      // a live pane's keys.
      if (after.length === ids.length) return;
      void setPaneParams(paneRemovalWrites(ids.length + 1, paneIndex, readParam));
      void setCompare(encodeCompare(after));
    },
    [compare, readParam, setCompare, setPaneParams]
  );

  const addPane = useCallback(() => {
    // Seeded with the log already open, so the new pane appears populated and
    // the user swaps it rather than facing an empty column.
    //
    // The new index's keys are cleared first — the add-side mirror of what a
    // removal does. nuqs keeps a param nothing reads, so a `src1` standing in a
    // bookmarked or hand-edited URL with no `compare` would be revived here as
    // a filter belonging to a log that is not open, which is the dormant-key
    // hazard `clearablePaneParamNames` exists to close on the other side.
    void setPaneParams(Object.fromEntries(paneParamNames(paneCount).map((key) => [key, null])));
    void setCompare(encodeCompare([...decodeCompare(compare), paneLogIds[0]]));
  }, [compare, paneCount, paneLogIds, setCompare, setPaneParams]);

  return (
    <Box className="analysis">
      <AnalysisTopBar />

      {/* WHO the view is about, one selector per log — a SHARED row, because
          "which actor" is one question asked once even when two fights answer
          it separately. The panes still own their pins and publish the handler
          that moves them (see `PaneSources`); this row only draws them side by
          side. The compare control rides its right edge: opening a second log
          is what adds a second selector here. */}
      <ActorBar
        panes={paneSources}
        trailing={
          paneCount === 1 ? (
            <button type="button" className={PANE_BUTTON_CLASS} onClick={addPane}>
              {t("ui.logs.compare-add")}
            </button>
          ) : (
            // Closing a comparison happens where opening one did. It closes the
            // LAST pane, which is what lets one control stand for the job: a ✕
            // per column would put a second one back down in the panes, which
            // is where this came from.
            <button
              type="button"
              className={PANE_BUTTON_CLASS}
              aria-label={t("ui.logs.compare-remove")}
              onClick={() => removePane(paneCount - 1)}
            >
              <X size={14} weight="bold" aria-hidden />
            </button>
          )
        }
      />

      {/* Above the metric tabs, where Warcraft Logs puts it: rendering it below
          the switcher shifted every control under it each time the metric
          changed. Only metrics that declare `supportsHostility` can operate it
          — see HostilityToggle's `disabled`. The body switch rides the same
          row: one of each for the view, whatever the pane count. */}
      <Box style={{ padding: "8px 16px 0", display: "flex", alignItems: "center", gap: 16 }}>
        <HostilityToggle
          value={hostility}
          onChange={(side) => applyShared((paneState) => hostilityTransition(paneState, side))}
          disabled={!caps.supportsHostility}
        />
        {/* Only while comparing: with one log open there is nothing to lay out
            two ways, and a control that did nothing would still invite a
            click. */}
        {comparing && (
          // A `PillGroup`, not Mantine's `SegmentedControl`: it shares this row
          // with the hostility toggle, which IS one, and the stock control put
          // a second design's border, fill and font right beside it.
          <PillGroup
            options={[
              { value: "overlay", label: t("ui.logs.compare-chart-overlay") },
              { value: "split", label: t("ui.logs.compare-chart-split") },
            ]}
            value={compareChartMode}
            onChange={(value: CompareChartMode) => setSettings({ compare_chart_mode: value })}
            ariaLabel={t("ui.logs.compare-chart-label")}
          />
        )}
        <Box style={{ marginLeft: "auto" }}>
          <MetricTabs
            variant="inline"
            ariaLabelKey="ui.logs.view-tablist-label"
            tabs={VIEW_TABS}
            value={bodyFor(tab)}
            onChange={(value) =>
              // Selecting the DEFAULT body clears the param rather than storing
              // "table": the table is the default, and a default in the URL is
              // noise. Anything else is written as-is. The metric the table was
              // last on is untouched either way — it lives in the machine, not
              // here.
              setTab(value === TABLE_TAB ? null : value)
            }
          />
        </Box>
      </Box>

      {/* Live in BOTH views, because Events is a display MODE and not a view of
          its own: the metric tab is what says which events the stream lists —
          Buffs → applies and removes, Damage Taken → incoming hits (see
          `eventScope`). Warcraft Logs' model, and the reason this frame is
          shared rather than swapped. */}
      <MetricTabs
        tabs={METRIC_TABS}
        value={state.metric}
        onChange={(value) => applyShared((paneState) => metricTransition(paneState, value as MetricKey))}
      />

      {/* One plot for the comparison, one line per log. Only while comparing:
          a single log keeps its pane's own chart, bands and all. */}
      {overlaid && (
        <CompareChart
          perPaneTotals={perPaneTotals}
          paneLogIds={paneLogIds}
          // The format every drawn pane agreed on — `overlaid` is false without
          // one, so there is no reading here of a pane that disagrees.
          format={sharedFormat}
          // Where the plotted buckets START on the fight clock. The panes publish
          // their WINDOWED totals, so with a zoom committed bucket 0 of this
          // data is `from`, not 0:00 — labelling from zero here would put a
          // different clock under the same points than the split layout does.
          startBucket={state.window === null ? 0 : state.window[0]}
          // Every pane's end, so the run that stopped first says so rather than
          // appearing to go quiet while the other carries on.
          endLines={paneEnds}
          // The chart controls that fold more than this plot. Withheld while
          // overlaid they had nowhere else to live: `CollapseSupplementaryToggle`
          // has exactly one render site and folds the TABLE as well, so a
          // comparison could not turn echo-merging off at all.
          smoothing={rateSmoothing}
          onSmoothingChange={sharedFormat === "amount" ? setRateSmoothing : undefined}
          controls={
            <CollapseSupplementaryToggle
              value={collapseSupplementary}
              onChange={(next) => setSettings({ merge_supplementary: next })}
              disabled={!caps.recordsSupplementary}
            />
          }
          // The zoom is shared, so a drag here commits for every pane — through
          // the same rule a pane's own plot commits one with, and through
          // `applyShared` so the frame keeps ONE write path. `from`/`to` are
          // unsuffixed, so writing them via pane 0 would work today; the next
          // shared control wired here will copy this line, and if its transition
          // touches a pane field (as the metric and hostility ones both do) only
          // pane 0 would get it.
          onScope={(next) => applyShared((paneState) => scrubWindow(paneState, next))}
        />
      )}

      {/* One column per log. A single pane is a one-column grid, which is the
          layout the view has always had. */}
      <Box className="analysis-panes" style={{ gridTemplateColumns: `repeat(${paneCount}, minmax(0, 1fr))` }}>
        {paneLogIds.map((logId, paneIndex) => (
          // The CELL is the frame's, not the pane's. A pane draws a stack of
          // sections — header, selector bar, chart, body — as siblings, and a
          // grid places every child it is given as an item of its own: without
          // this wrapper the sections auto-flow across the columns row by row,
          // so pane 0's header lands beside pane 0's actor bar and the two logs
          // interleave all the way down the page. Wrapping HERE rather than
          // inside the pane keeps the rule with the layout that needs it — the
          // frame owns the grid, so the frame owns its cells.
          //
          // `key={paneIndex}` is load-bearing — NOT `key={logId}`. Reindexing a
          // live pane changes the keys its `useQueryState` calls subscribe to,
          // and nuqs returns `undefined` for one render after a key change (its
          // reconcile is a render-phase update, so that render still reads
          // internal state keyed by the old name). `decodeState` throws on that
          // `undefined`, and nuqs's own `string | null` types hide it from
          // `tsc`. Keying by index makes a reindex unmount and remount, so the
          // pane mounts with the right keys on its first render.
          <Box key={paneIndex} className="analysis-pane">
            <AnalysisPane
              paneIndex={paneIndex}
              logId={logId}
              filters={filters}
              drawsChart={!overlaid}
              chartControls={chartControls}
              logs={logs}
              onChangeLog={(next) => changePaneLog(paneIndex, next)}
              // Every pane's end, its own included: a pane's end bucket IS its
              // chart's last bucket, and `visibleEndLines` already drops a rule
              // at or past that — so excluding it here would be a second author
              // for one rule.
              paneEnds={paneEnds}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
};
