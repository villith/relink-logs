import { Badge, Group, SegmentedControl } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { LogsViewMode, useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

/** Switches the logs page between the Classic and Beta (Analysis) bodies.
 *
 * One symmetric control, because the two directions are the same kind of move:
 * both replace the whole body with the other reading of the same log. It used to
 * be asymmetric — a labelled Button out of Analysis and an invisible hit target
 * into it — which kept the redesign hidden from anyone who did not already know
 * where to click.
 *
 * Beta wears a WIP badge instead. The view IS unfinished, and two plain tabs
 * side by side would present it as Classic's equal; the badge says which one is
 * still being built without hiding it.
 *
 * Mantine's `SegmentedControl` and not the app's own `PillGroup`: this renders
 * in BOTH bodies, and Classic is drawn in the stock theme — the token-built
 * pills would read as a foreign control there.
 *
 * Lives in both view bodies rather than in the page shell, so each side places
 * it where that side wants it. */
export const ViewModeToggle = () => {
  const { t } = useTranslation();
  const mode = useMeterSettingsStore((state) => state.logs_view);
  const setSettings = useMeterSettingsStore((state) => state.set);

  return (
    <SegmentedControl
      size="xs"
      aria-label={t("ui.logs.view-mode.label")}
      value={mode}
      onChange={(value) => setSettings({ logs_view: value as LogsViewMode })}
      data={[
        { value: "classic", label: t("ui.logs.view-mode.classic") },
        {
          value: "analysis",
          label: (
            <Group gap={6} wrap="nowrap">
              {t("ui.logs.view-mode.beta")}
              <Badge size="xs" color="yellow" variant="filled">
                {t("ui.logs.view-mode.wip")}
              </Badge>
            </Group>
          ),
        },
      ]}
    />
  );
};
