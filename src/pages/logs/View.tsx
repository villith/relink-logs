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
 * of its own. It is invisible by design, and cd06c00f removed the
 * `import.meta.env.DEV` guard that used to force Classic outside dev — so
 * nothing here keeps users off the unfinished Analysis view except the stored
 * default, which is `classic` (see `LogsViewMode`). Those two facts are load
 * bearing together: an invisible toggle is only acceptable while the default is
 * the finished view, because a user who lands on Analysis by accident cannot
 * find their way back. Flip the default only when Analysis is done, or give the
 * toggle a visible affordance first. */
export const ViewPage = () => {
  const mode = useMeterSettingsStore((state) => state.logs_view_mode);

  return <Box>{mode === "classic" ? <ClassicView /> : <AnalysisView />}</Box>;
};
