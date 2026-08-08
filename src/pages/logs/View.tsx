import { Box } from "@mantine/core";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import { AnalysisView } from "./view/analysis/AnalysisView";
import { ClassicView } from "./view/ClassicView";

/** Chooses between the redesigned Analysis frame and the original four-tab
 * Classic view, and holds nothing else — the two bodies own their own data
 * fetching, because their filter shapes differ (see the plan's "classic view
 * stays" rules).
 *
 * The switch itself is NOT here any more. It is `ViewModeToggle`, rendered
 * inside each body beside that body's own top-right control, so it costs no row
 * of its own. cd06c00f removed the `import.meta.env.DEV` guard that used to
 * force Classic outside dev, so the stored default — `classic`, see
 * `LogsViewMode` — is what a release build draws. The toggle is an ordinary
 * visible control now and labels Analysis a beta, so a reader who lands there
 * can both tell why it is unfinished and switch back by eye. Flip the default
 * only when Analysis is done. */
export const ViewPage = () => {
  const mode = useMeterSettingsStore((state) => state.logs_view);

  return <Box>{mode === "classic" ? <ClassicView /> : <AnalysisView />}</Box>;
};
