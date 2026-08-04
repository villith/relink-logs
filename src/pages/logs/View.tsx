import { Box, SegmentedControl } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { LogsViewMode, useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import { AnalysisView } from "./view/analysis/AnalysisView";
import { ClassicView } from "./view/ClassicView";

/** Chooses between the redesigned Analysis frame and the original four-tab
 * Classic view, and holds nothing else — the two bodies own their own data
 * fetching, because their filter shapes differ (see the plan's "classic view
 * stays" rules).
 *
 * THE ANALYSIS VIEW IS DEV-ONLY for now: it is unfinished, so a release build
 * shows Classic and offers no switch. Everything below the guard is what the
 * page will be again once Analysis ships — deleting the guard is the whole
 * change.
 *
 * The guard IGNORES `logs_view_mode` rather than defaulting it. The setting is
 * persisted and already defaults to "analysis", so anyone who has opened a
 * quest on a dev build carries that value into the release; merely hiding the
 * switch would strand them on the half-built view with no control left to
 * escape it. The stored value is left untouched, so a dev build still finds the
 * choice its owner made. */
export const ViewPage = () => {
  const { t } = useTranslation();
  const mode = useMeterSettingsStore((state) => state.logs_view_mode);
  const setSettings = useMeterSettingsStore((state) => state.set);

  if (!import.meta.env.DEV) {
    return (
      <Box>
        <ClassicView />
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" style={{ justifyContent: "flex-end" }} mb="xs">
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(value) => setSettings({ logs_view_mode: value as LogsViewMode })}
          aria-label={t("ui.logs.view-mode.label")}
          data={[
            { value: "analysis", label: t("ui.logs.view-mode.analysis") },
            { value: "classic", label: t("ui.logs.view-mode.classic") },
          ]}
        />
      </Box>
      {mode === "classic" ? <ClassicView /> : <AnalysisView />}
    </Box>
  );
};
