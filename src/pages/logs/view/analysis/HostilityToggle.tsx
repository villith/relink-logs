import { Box, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Hostility } from "../metrics/types";

import "./analysis.css";

const SIDES: { value: Hostility; labelKey: string }[] = [
  { value: "friendly", labelKey: "ui.logs.hostility-friendlies" },
  { value: "enemy", labelKey: "ui.logs.hostility-enemies" },
];

/** WCL's Friendlies | Enemies switch: which side's holders the status tables
 * show. Polarity stays with the tab (Buffs = beneficial, Debuffs = harmful);
 * this re-pivots the holders, so an enemy's own Bloodthirst is reachable under
 * Buffs → Enemies instead of being misfiled as a debuff. */
export const HostilityToggle = ({ value, onChange }: { value: Hostility; onChange: (next: Hostility) => void }) => {
  const { t } = useTranslation();

  // Arrow keys move the selection and only the checked option is tabbable —
  // the ARIA radio pattern. Without it both options are separate tab stops and
  // the arrows do nothing. With only two sides, either arrow key just picks
  // the other one.
  const other = value === "friendly" ? "enemy" : "friendly";

  return (
    <Box
      role="radiogroup"
      aria-label={t("ui.logs.hostility-label")}
      className="analysis-hostility"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") onChange(other);
        else return;
        event.preventDefault();
      }}
    >
      {SIDES.map((side) => (
        <UnstyledButton
          key={side.value}
          role="radio"
          aria-checked={value === side.value}
          tabIndex={value === side.value ? 0 : -1}
          className={`analysis-hostility-option${value === side.value ? " analysis-hostility-active" : ""}`}
          onClick={() => onChange(side.value)}
        >
          {t(side.labelKey)}
        </UnstyledButton>
      ))}
    </Box>
  );
};
