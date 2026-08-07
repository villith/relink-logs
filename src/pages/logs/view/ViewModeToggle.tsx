import { Button, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";

import "./ViewModeToggle.css";

/** Switches the logs page between the Analysis and Classic bodies.
 *
 * Asymmetric on purpose, because the two directions are not the same kind of
 * move. Classic is the default and the finished view, so the way IN to the
 * unfinished Analysis view paints nothing (see the CSS) and reads as empty space
 * beside Classic's clipboard menu — it is for people who already know it is
 * there. The way OUT is an ordinary labelled button on its own row above the
 * Analysis body, because anyone who switched must be able to switch back by eye.
 * An invisible exit would strand them.
 *
 * Lives in both view bodies rather than in the page shell, so each side places
 * it where that side wants it — and so Classic never reserves a row for a
 * control that paints nothing. */
export const ViewModeToggle = () => {
  const { t } = useTranslation();
  const mode = useMeterSettingsStore((state) => state.logs_view_mode);
  const setSettings = useMeterSettingsStore((state) => state.set);

  if (mode === "analysis") {
    return (
      <Button size="xs" variant="default" onClick={() => setSettings({ logs_view_mode: "classic" })}>
        {t("ui.logs.view-mode.to-classic")}
      </Button>
    );
  }

  return (
    <UnstyledButton
      className="view-mode-toggle"
      aria-label={t("ui.logs.view-mode.toggle")}
      onClick={() => setSettings({ logs_view_mode: "analysis" })}
    />
  );
};
