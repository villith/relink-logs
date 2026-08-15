import { Box, SegmentedControl } from "@mantine/core";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { useAnalysisPanesStore } from "@/stores/useAnalysisPanesStore";
import { useLogLibraryStore } from "@/stores/useLogLibraryStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore, type CompareChartMode } from "@/stores/useMeterSettingsStore";

import type { Hostility } from "../metrics/types";

import { AnalysisPane } from "./AnalysisPane";
import { AnalysisTopBar } from "./AnalysisTopBar";
import { CompareChart } from "./CompareChart";
import { CompareHeader } from "./CompareHeader";
import { HostilityToggle } from "./HostilityToggle";
import { MetricTabs } from "./MetricTabs";
import "./analysis.css";
import { METRIC_TABS, TABLE_TAB, VIEW_TABS, bodyFor } from "./analysisTabs";
import { CAPABILITIES } from "./machine/capabilities";
import { SHARED_FIELDS, decodeCompare, encodeCompare, paneParamNames, removeCompareAt } from "./machine/paneParams";
import { paneRemovalWrites, sharedControlWrites } from "./machine/paneWrites";
import type { MetricKey } from "./machine/state";
import { setHostility as hostilityTransition, setMetric as metricTransition, scrubWindow } from "./machine/transitions";
import { useAnalysisState } from "./machine/useAnalysisState";

/** The Analysis view's frame: the log pickers, the controls every pane shares,
 * and one `<AnalysisPane>` per log.
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
  // exist before any pane has rendered, let alone fetched. Idempotent, and this
  // component does not subscribe to `panes`, so it cannot loop.
  useMemo(() => setPaneLogs(paneLogIds), [paneLogIds, setPaneLogs]);

  // EVERY pane's keys, in one subscription. The frame needs a bulk reader and a
  // bulk writer for the two jobs no single pane can do: applying a shared
  // control to all of them at once, and shifting the suffixed keys down when a
  // pane in the middle closes. One `setQueryStates` call is also one history
  // entry, so a removal cannot half-apply.
  const paneParamKeys = useMemo(
    () =>
      Object.fromEntries(
        [...SHARED_FIELDS, ...Array.from({ length: paneCount }, (_, index) => paneParamNames(index)).flat()].map(
          (key) => [key, parseAsString]
        )
      ),
    [paneCount]
  );
  const [paneParams, setPaneParams] = useQueryStates(paneParamKeys, { history: "replace" });
  // Coalesced: nuqs reports `undefined` for one render after its key set
  // changes, which is exactly what adding or removing a pane does, and the
  // writers below read every key of every pane.
  const readParam = useCallback((key: string) => paneParams[key] ?? null, [paneParams]);

  // The frame's own reading of the SHARED fields. Pane 0's state carries them
  // (they are unsuffixed, so every pane's does) — this is a read, and the write
  // goes through `applyShared` so no pane is left behind.
  const [state, setState] = useAnalysisState(0);
  const caps = CAPABILITIES[state.metric];
  const hostility: Hostility = caps.supportsHostility ? state.hostility : "friendly";
  const [tab, setTab] = useQueryState("tab", { history: "replace" });

  // How the comparison is plotted. Inert with one log open — there is nothing
  // to overlay, and the pane draws its own full chart either way.
  const compareChartMode = useMeterSettingsStore((settings) => settings.compare_chart_mode);
  const setSettings = useMeterSettingsStore((settings) => settings.set);
  const comparing = paneCount > 1;
  const overlaid = comparing && compareChartMode === "overlay";
  // One entry per pane, published by the panes themselves (see `PaneChart`).
  const paneCharts = useAnalysisPanesStore(useShallow((panes) => panes.panes.map((pane) => pane.chart)));

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
      // Pane 0 IS the address, so changing it is a navigation; the rest are a
      // query param. Both keep every other pane's pins where they are.
      if (paneIndex === 0) {
        navigate({ pathname: `/logs/${logId}`, search: window.location.search }, { replace: true });
        return;
      }
      const next = [...decodeCompare(compare)];
      next[paneIndex - 1] = logId;
      void setCompare(encodeCompare(next));
    },
    [compare, navigate, setCompare]
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
    void setCompare(encodeCompare([...decodeCompare(compare), paneLogIds[0]]));
  }, [compare, paneLogIds, setCompare]);

  return (
    <Box className="analysis">
      <AnalysisTopBar />

      <CompareHeader
        logs={logs}
        paneLogIds={paneLogIds}
        onAddPane={addPane}
        onRemovePane={removePane}
        onChangePaneLog={changePaneLog}
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
          <SegmentedControl
            size="xs"
            value={compareChartMode}
            onChange={(value) => setSettings({ compare_chart_mode: value as CompareChartMode })}
            data={[
              { value: "overlay", label: t("ui.logs.compare-chart-overlay") },
              { value: "split", label: t("ui.logs.compare-chart-split") },
            ]}
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
          perPaneTotals={paneCharts.map((chart) => chart.totals)}
          paneLogIds={paneLogIds}
          // Every pane shares the metric, so pane 0's axis format is the
          // comparison's. Missing only before the first pane has drawn.
          format={paneCharts[0]?.format ?? "amount"}
          // The zoom is shared, so a drag here commits for every pane — through
          // the same rule a pane's own plot commits one with.
          onScope={(next) => setState(scrubWindow(state, next))}
        />
      )}

      {/* One column per log. A single pane is a one-column grid, which is the
          layout the view has always had. */}
      <Box className="analysis-panes" style={{ gridTemplateColumns: `repeat(${paneCount}, minmax(0, 1fr))` }}>
        {paneLogIds.map((logId, paneIndex) => (
          // `key={paneIndex}` is load-bearing — NOT `key={logId}`. Reindexing a
          // live pane changes the keys its `useQueryState` calls subscribe to,
          // and nuqs returns `undefined` for one render after a key change (its
          // reconcile is a render-phase update, so that render still reads
          // internal state keyed by the old name). `decodeState` throws on that
          // `undefined`, and nuqs's own `string | null` types hide it from
          // `tsc`. Keying by index makes a reindex unmount and remount, so the
          // pane mounts with the right keys on its first render.
          <AnalysisPane key={paneIndex} paneIndex={paneIndex} logId={logId} filters={filters} drawsChart={!overlaid} />
        ))}
      </Box>
    </Box>
  );
};
