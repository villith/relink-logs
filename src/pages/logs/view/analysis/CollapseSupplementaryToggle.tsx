import { Switch, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";

import "./analysis.css";

/** Whether echo damage rides the skill that caused it.
 *
 * `disabled` keeps the control on screen where it has nothing to do, for the
 * same reason `HostilityToggle` does: hiding it moved every control below it
 * each time the tab changed, and a live switch that silently does nothing is
 * worse than one that says so. */
export const CollapseSupplementaryToggle = ({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();

  return (
    <Tooltip
      label={disabled ? t("ui.logs.collapse-supplementary-disabled-hint") : t("ui.logs.collapse-supplementary-hint")}
      withinPortal
      openDelay={200}
    >
      <Switch
        size="xs"
        checked={value}
        disabled={disabled}
        label={t("ui.logs.collapse-supplementary")}
        aria-label={t("ui.logs.collapse-supplementary")}
        // Guarded here as well as by the `disabled` attribute, the way
        // `HostilityToggle` guards its own: the attribute is the browser's
        // courtesy, not a lock, and a dimmed control that still reports a change
        // is the same defect as an undimmed one.
        onChange={(event) => !disabled && onChange(event.currentTarget.checked)}
      />
    </Tooltip>
  );
};
