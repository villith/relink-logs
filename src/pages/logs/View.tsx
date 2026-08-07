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
 * of its own. It is also invisible by design, which changes an old guarantee:
 * this page used to rely on a visible switch as the escape hatch off the
 * unfinished Analysis view (cd06c00f removed the `import.meta.env.DEV` guard
 * that used to force Classic outside dev). There is no longer a discoverable
 * way off Analysis, so if this ever goes back behind a guard, the guard must
 * ignore the stored value rather than assume someone can find the toggle. */
export const ViewPage = () => {
  const mode = useMeterSettingsStore((state) => state.logs_view_mode);

  return <Box>{mode === "classic" ? <ClassicView /> : <AnalysisView />}</Box>;
};
