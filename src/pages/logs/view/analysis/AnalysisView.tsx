import { Box } from "@mantine/core";
import { useMemo } from "react";
import { useParams } from "react-router-dom";

import { useAnalysisPanesStore } from "@/stores/useAnalysisPanesStore";
import { useMeterFilters } from "@/stores/useMeterFilterSync";

import { AnalysisPane } from "./AnalysisPane";
import { AnalysisTopBar } from "./AnalysisTopBar";
import "./analysis.css";

/** The Analysis view's frame: the top bar, and one `<AnalysisPane>` per log.
 *
 * Everything about a log — its fetches, its pins, its chart and its body —
 * belongs to the pane, so a second log is a second pane rather than a second
 * copy of the view. What stays here is what all panes share.
 *
 * The log in the path is pane 0, whose URL keys are the BARE ones every link
 * written before compare existed already carries (see `paneParamName`). */
export const AnalysisView = () => {
  const { id } = useParams();
  const filters = useMeterFilters();

  const paneLogIds = useMemo(() => [Number(id)], [id]);
  const setPaneLogs = useAnalysisPanesStore((state) => state.setPaneLogs);
  // Seeded during RENDER, not in an effect: a pane's fetch is dispatched from
  // its own mount effect, which React runs before the parent's, and a response
  // aimed at a pane the store does not know about is dropped rather than
  // resurrecting a closed pane (see `writeAt`). Doing it here means the slices
  // exist before any pane has rendered, let alone fetched. Idempotent, and this
  // component does not subscribe to `panes`, so it cannot loop.
  useMemo(() => setPaneLogs(paneLogIds), [paneLogIds, setPaneLogs]);

  return (
    <Box className="analysis">
      <AnalysisTopBar />
      <AnalysisPane paneIndex={0} logId={Number(id)} filters={filters} />
    </Box>
  );
};
