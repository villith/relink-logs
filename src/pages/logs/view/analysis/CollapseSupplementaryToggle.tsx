import { Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

import "./analysis.css";

/** Whether echo damage rides the skill that caused it.
 *
 * Labelled "Merge Sup DMG", not "Collapse supplementary": it sits in the
 * chart's header strip beside the smoothing window, where a control's label
 * competes for width with the plot's own title, and the tooltip is what carries
 * the sentence. The code keeps the `collapseSupplementary` name, which is what
 * the fold itself is called everywhere below the UI (see `abilitySkills`).
 *
 * `disabled` keeps the control on screen where it has nothing to do, for the
 * same reason `HostilityToggle` does: hiding it moved every control below it
 * each time the tab changed, and a live switch that silently does nothing is
 * worse than one that says so.
 *
 * The shared `ToggleSwitch` rather than Mantine's `Switch`: it stands beside
 * the side pills in the same row, and the stock control was drawn in the
 * default theme while everything around it is built from the design tokens. */
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
      <ToggleSwitch checked={value} disabled={disabled} label={t("ui.logs.merge-supplementary")} onChange={onChange} />
    </Tooltip>
  );
};
