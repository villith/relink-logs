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

  return (
    <Box role="radiogroup" aria-label={t("ui.logs.hostility-label")} className="analysis-hostility">
      {SIDES.map((side) => (
        <UnstyledButton
          key={side.value}
          role="radio"
          aria-checked={value === side.value}
          className={`analysis-hostility-option${value === side.value ? " analysis-hostility-active" : ""}`}
          onClick={() => onChange(side.value)}
        >
          {t(side.labelKey)}
        </UnstyledButton>
      ))}
    </Box>
  );
};
