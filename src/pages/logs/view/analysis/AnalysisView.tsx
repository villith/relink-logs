import { Box } from "@mantine/core";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/Button";
import { PillGroup } from "@/components/ui/PillGroup";
import { useAnalysisPanesStore } from "@/stores/useAnalysisPanesStore";
import { useLogLibraryStore } from "@/stores/useLogLibraryStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore, type CompareChartMode } from "@/stores/useMeterSettingsStore";
import { toggled } from "@/utils";

import { DPS_SMOOTHING_WINDOW } from "../DetailCharts";
import type { Hostility } from "../metrics/types";

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
import { DEFAULT_HIDDEN_WINDOW_KINDS, type WindowKind } from "./chartWindowBands";
import { compareMarkers } from "./compareMarkers";
import { paneSeriesColor, paneSeriesLabels, paneSeriesShortLabel } from "./compareSeries";
import { compareWindowBands, compareWindowTooltips } from "./compareWindows";
import { CAPABILITIES } from "./machine/capabilities";
import { SHARED_FIELDS, decodeCompare, encodeCompare, paneParamNames, removeCompareAt } from "./machine/paneParams";
import { paneRemovalWrites, sharedControlWrites } from "./machine/paneWrites";
import type { MetricKey } from "./machine/state";
import { setHostility as hostilityTransition, setMetric as metricTransition, scrubWindow } from "./machine/transitions";
import { useAnalysisState } from "./machine/useAnalysisState";

const EMPTY_MARKER_KINDS: ReadonlySet<MarkerKind> = new Set();

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
  const paneLogIds = useMemo(() => [Number(id), ...decodeCompare(compare)], [id, compare]);
  const paneCount = paneLogIds.length;

  const setPaneLogs = useAnalysisPanesStore((state) => state.setPaneLogs);
  useMemo(() => setPaneLogs(paneLogIds), [paneLogIds, setPaneLogs]);

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
  const readParam = useCallback((key: string) => paneParams[key] ?? null, [paneParams]);

  const [state] = useAnalysisState(0);
  const caps = CAPABILITIES[state.metric];
  const hostility: Hostility = caps.supportsHostility ? state.hostility : "friendly";
  const [tab, setTab] = useQueryState("tab", { history: "replace" });

  const compareChartMode = useMeterSettingsStore((settings) => settings.compare_chart_mode);
  const collapseSupplementary = useMeterSettingsStore((settings) => settings.merge_supplementary);
  const setSettings = useMeterSettingsStore((settings) => settings.set);
  const comparing = paneCount > 1;
  const paneCharts = useAnalysisPanesStore(useShallow((panes) => panes.panes.map((pane) => pane.chart)));

  const drawnFormats = paneCharts.filter((chart) => chart.totals.length > 0).map((chart) => chart.format);
  const formatsAgree = drawnFormats.every((format) => format === drawnFormats[0]);
  const sharedFormat = drawnFormats[0] ?? "amount";
  const overlaid = comparing && compareChartMode === "overlay" && formatsAgree;

  const paneColor = useCallback(
    (paneIndex: number) => (comparing ? paneSeriesColor(paneIndex) : undefined),
    [comparing]
  );

  const [stackMode, setStackMode] = useState<StackMode>("normal");
  const [rateSmoothing, setRateSmoothing] = useState<number>(DPS_SMOOTHING_WINDOW);
  const [hiddenMarkerKinds, setHiddenMarkerKinds] = useState<ReadonlySet<MarkerKind>>(EMPTY_MARKER_KINDS);
  const [hiddenWindowKinds, setHiddenWindowKinds] = useState<ReadonlySet<WindowKind>>(DEFAULT_HIDDEN_WINDOW_KINDS);
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

  const paneLabels = useMemo(() => paneSeriesLabels(paneLogIds, logs), [paneLogIds, logs]);

  const paneEnds: EndLine[] = useMemo(
    () =>
      paneCharts.map((chart, paneIndex) => ({
        bucket: chart.totals.length - 1,
        color: paneSeriesColor(paneIndex),
        label: paneSeriesShortLabel(paneLogIds[paneIndex]),
      })),
    [paneCharts, paneLogIds]
  );

  const perPaneTotals = useMemo(() => paneCharts.map((chart) => chart.totals), [paneCharts]);

  const paneWindows = useAnalysisPanesStore(useShallow((panes) => panes.panes.map((pane) => pane.windows)));

  const overlayWindowBands = useMemo(
    () => compareWindowBands(paneWindows.map((windows) => windows.bands)),
    [paneWindows]
  );

  // Every line is tagged with its log, in that log's own line colour: the
  // overlay draws two fights and a span reading "1:20–1:31 · 11s" says nothing
  // about which of them was in Break. The row's swatch cannot say it — the card
  // groups these by kind and the swatch is the kind's — so the id does, and
  // wears the colour to be read at a glance rather than word by word.
  const overlayWindowTooltips = useMemo(
    () =>
      compareWindowTooltips(
        paneWindows.map((windows) => windows.tooltips),
        (paneIndex) => ({ text: paneSeriesShortLabel(paneLogIds[paneIndex]), color: paneSeriesColor(paneIndex) })
      ),
    [paneWindows, paneLogIds]
  );

  const paneMarkers = useAnalysisPanesStore(useShallow((panes) => panes.panes.map((pane) => pane.markers)));

  // Tagged like the window lines above, and for the same reason. The SBA
  // shading merges a chain of casts into one span, so these lines are the only
  // place the overlay says how many Skybound Arts a run got off and when.
  const overlayMarkers = useMemo(
    () =>
      compareMarkers(paneMarkers, (paneIndex) => ({
        text: paneSeriesShortLabel(paneLogIds[paneIndex]),
        color: paneSeriesColor(paneIndex),
      })),
    [paneMarkers, paneLogIds]
  );

  const applyShared = useCallback(
    (transition: Parameters<typeof sharedControlWrites>[2]) => {
      void setPaneParams(sharedControlWrites(paneCount, readParam, transition));
    },
    [paneCount, readParam, setPaneParams]
  );

  const changePaneLog = useCallback(
    (paneIndex: number, logId: number) => {
      const cleared = paneParamNames(paneIndex);

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
      if (after.length === ids.length) return;
      void setPaneParams(paneRemovalWrites(ids.length + 1, paneIndex, readParam));
      void setCompare(encodeCompare(after));
    },
    [compare, readParam, setCompare, setPaneParams]
  );

  const addPane = useCallback(() => {
    void setPaneParams(Object.fromEntries(paneParamNames(paneCount).map((key) => [key, null])));
    void setCompare(encodeCompare([...decodeCompare(compare), paneLogIds[0]]));
  }, [compare, paneCount, paneLogIds, setCompare, setPaneParams]);

  return (
    <Box className="analysis">
      <AnalysisTopBar />

      <Box style={{ padding: "8px 16px 0", display: "flex", alignItems: "center", gap: 16 }}>
        <HostilityToggle
          value={hostility}
          onChange={(side) => applyShared((paneState) => hostilityTransition(paneState, side))}
          disabled={!caps.supportsHostility}
        />
        <Box style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
          {comparing ? (
            <Button onClick={() => removePane(1)}>{t("ui.logs.compare-remove")}</Button>
          ) : (
            <Button onClick={() => addPane()}>{t("ui.logs.compare-add")}</Button>
          )}
          {comparing && (
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
          <MetricTabs
            variant="inline"
            ariaLabelKey="ui.logs.view-tablist-label"
            tabs={VIEW_TABS}
            value={bodyFor(tab)}
            onChange={(value) => setTab(value === TABLE_TAB ? null : value)}
          />
        </Box>
      </Box>

      <MetricTabs
        tabs={METRIC_TABS}
        value={state.metric}
        onChange={(value) => applyShared((paneState) => metricTransition(paneState, value as MetricKey))}
      />

      {overlaid && (
        <CompareChart
          perPaneTotals={perPaneTotals}
          paneLabels={paneLabels}
          format={sharedFormat}
          startBucket={state.window === null ? 0 : state.window[0]}
          endLines={paneEnds}
          smoothing={rateSmoothing}
          onSmoothingChange={sharedFormat === "amount" ? setRateSmoothing : undefined}
          windowBands={overlayWindowBands}
          windowTooltips={overlayWindowTooltips}
          hiddenWindowKinds={hiddenWindowKinds}
          onToggleWindowKind={toggleWindowKind}
          markers={overlayMarkers}
          hiddenMarkerKinds={hiddenMarkerKinds}
          onToggleMarkerKind={toggleMarkerKind}
          controls={
            <CollapseSupplementaryToggle
              value={collapseSupplementary}
              onChange={(next) => setSettings({ merge_supplementary: next })}
              disabled={!caps.recordsSupplementary}
            />
          }
          onScope={(next) => applyShared((paneState) => scrubWindow(paneState, next))}
        />
      )}

      <Box className="analysis-panes" style={{ gridTemplateColumns: `repeat(${paneCount}, minmax(0, 1fr))` }}>
        {paneLogIds.map((logId, paneIndex) => (
          <Box key={paneIndex} className="analysis-pane">
            <AnalysisPane
              paneIndex={paneIndex}
              logId={logId}
              filters={filters}
              drawsChart={!overlaid}
              chartControls={chartControls}
              logs={logs}
              onChangeLog={(next) => changePaneLog(paneIndex, next)}
              seriesColor={paneColor(paneIndex)}
              paneEnds={paneEnds}
              // One chart means one question: a target, an ability or an aura
              // picked in any pane selects the same thing in all of them. Split,
              // each plot is its own reading and each pane keeps its own pins.
              linkedWrite={overlaid ? applyShared : undefined}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
};
