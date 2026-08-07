import { UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import "./ViewModeToggle.css";

/** Switches the logs page between the Analysis and Classic bodies.
 *
 * Invisible on purpose (see the CSS): it renders at a fixed size but paints
 * nothing, so it reads as empty space next to the control it sits beside —
 * Classic's clipboard menu, Analysis's metric tabs. It is a plain toggle, not a
 * switch or a segmented control: one click moves to the other mode.
 *
 * Because it is invisible it is NOT an escape hatch anyone can find. Analysis is
 * still unfinished and is the default, so someone who does not know this control
 * exists has no way off it. That is the accepted trade; if Analysis ever goes
 * back behind a build guard, the guard must ignore the stored value rather than
 * rely on this being discoverable.
 *
 * Lives in both view bodies rather than in the page shell so it can sit beside
 * each view's own top-right control instead of reserving a row of its own. */
export const ViewModeToggle = () => {
  const { t } = useTranslation();
  const mode = useMeterSettingsStore((state) => state.logs_view_mode);
  const setSettings = useMeterSettingsStore((state) => state.set);

  return (
    <UnstyledButton
      className="view-mode-toggle"
      aria-label={t("ui.logs.view-mode.toggle")}
      onClick={() => setSettings({ logs_view_mode: mode === "classic" ? "analysis" : "classic" })}
    />
  );
};
