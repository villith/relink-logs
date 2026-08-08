import { Box, UnstyledButton } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import "./analysis.css";

export type DebugBarProps = {
  /** The URL query string exactly as it stands, leading "?" and all. */
  search: string;
  /** The resolved machine state as one JSON line — what the spec made of the
   * URL, beside the URL itself. */
  chart: string;
};

/** How long the button says "copied" before going back to offering the copy. */
const COPIED_MS = 1200;

/** One readout line: its name, its verbatim value, and a button that puts that
 * value on the clipboard.
 *
 * The button exists because the value is the whole point — both lines wrap at
 * `overflow-wrap: anywhere`, and hand-selecting a wrapped one is how half a pin
 * set ends up in a bug report. */
const DebugLine = ({ label, value, copy }: { label: string; value: string; copy: string }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Cleared on unmount as well as on the timer: the bar unmounts the moment the
  // view switches bodies, and a setState after that is a React warning.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="analysis-debug-row">
      <div className="analysis-debug-line">
        <span className="analysis-debug-key">{label}</span>
        <span>{value}</span>
      </div>
      <UnstyledButton
        className={`analysis-debug-copy${copied ? " analysis-debug-copied" : ""}`}
        aria-label={t("ui.debug.copy-line", { line: label })}
        // The COPY is the raw value, never the displayed one: an empty query
        // shows "(none)", and a report pasting that back would be pasting a
        // word this component invented.
        onClick={() => {
          // Fire-and-forget. The clipboard is unavailable in a few contexts
          // (an insecure origin, a denied permission), and a dev readout must
          // not throw an unhandled rejection at the app over it — the button
          // simply never confirms.
          void navigator.clipboard?.writeText(copy).then(() => setCopied(true));
        }}
      >
        {copied ? t("ui.debug.copied") : t("ui.debug.copy")}
      </UnstyledButton>
    </div>
  );
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
      <DebugLine
        label={t("ui.debug.analysis-query")}
        value={search === "" ? t("ui.debug.analysis-query-empty") : search}
        copy={search}
      />
      <DebugLine label={t("ui.debug.analysis-chart")} value={chart} copy={chart} />
    </Box>
  );
};
