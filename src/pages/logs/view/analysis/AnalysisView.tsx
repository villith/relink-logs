import { Box } from "@mantine/core";
import { useParams } from "react-router-dom";

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

  return (
    <Box className="analysis">
      <AnalysisTopBar />
      <AnalysisPane paneIndex={0} logId={Number(id)} filters={filters} />
    </Box>
  );
};
