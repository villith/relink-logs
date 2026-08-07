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
 * Analysis is still unfinished but is offered in every build (cd06c00f removed
 * the `import.meta.env.DEV` guard that used to force Classic outside dev). What
 * makes that safe is the switch below rendering unconditionally: `logs_view_mode`
 * is persisted and defaults to "analysis", so the guard's real job was to stop
 * someone being stranded on the half-built view with no control to escape it.
 * A visible switch answers that on its own — so if this ever goes back behind a
 * guard, the switch must not be hidden without also ignoring the stored value. */
export const ViewPage = () => {
  const { t } = useTranslation();
  const mode = useMeterSettingsStore((state) => state.logs_view_mode);
  const setSettings = useMeterSettingsStore((state) => state.set);

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
