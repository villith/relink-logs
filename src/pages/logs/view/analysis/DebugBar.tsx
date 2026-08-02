import { Box } from "@mantine/core";
import { useTranslation } from "react-i18next";

import "./analysis.css";

export type DebugBarProps = {
  /** The URL query string exactly as it stands, leading "?" and all. */
  search: string;
  /** The chart's own derivation, already formatted by `formatChartDebug`. */
  chart: string;
};

/** Dev-only readout of what the view is currently asking for.
 *
 * The pins live in the URL, so the query string IS the view's state — but the
 * plot is drawn from a source those pins only imply (the base series, a scoped
 * refetch, or a folded drill-down), and a chart drawing the wrong fight cannot
 * be told apart from a chart drawing the right one without knowing which. Both
 * lines are printed verbatim and left selectable so a report can paste them.
 *
 * Guarded by `import.meta.env.DEV` at the call site, the same way the Debug tab
 * is: a release build never renders it. */
export const DebugBar = ({ search, chart }: DebugBarProps) => {
  const { t } = useTranslation();

  return (
    <Box className="analysis-debug">
      <div className="analysis-debug-line">
        <span className="analysis-debug-key">{t("ui.debug.analysis-query")}</span>
        <span>{search === "" ? t("ui.debug.analysis-query-empty") : search}</span>
      </div>
      <div className="analysis-debug-line">
        <span className="analysis-debug-key">{t("ui.debug.analysis-chart")}</span>
        <span>{chart}</span>
      </div>
    </Box>
  );
};

