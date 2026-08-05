import { Box, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Hostility } from "../metrics/types";

import "./analysis.css";

const SIDES: { value: Hostility; labelKey: string }[] = [
  { value: "friendly", labelKey: "ui.logs.hostility-friendlies" },
  { value: "enemy", labelKey: "ui.logs.hostility-enemies" },
];

/** WCL's Friendlies | Enemies switch: which side the table below is about.
 *
 * Every tab but SBA and Stun has a side to switch to. On Buffs and Debuffs it
 * re-pivots the HOLDERS — polarity stays with the tab (Buffs = beneficial,
 * Debuffs = harmful), so an enemy's own Bloodthirst is reachable under
 * Buffs → Enemies instead of being misfiled as a debuff. On Damage Done and
 * Damage Taken it swaps the party for the enemy types at the other end of the
 * same hits: who was hitting the party, and where the party's damage went.
 *
 * `disabled` keeps the control on screen where it has nothing to switch. It
 * lives above the metric tabs, as it does on Warcraft Logs, so hiding it on the
 * tabs that cannot use it moved every control below it each time the tab
 * changed. Disabled rather than merely inert: SBA and Stun are recorded per
 * player only, so neither has a side to pivot to, and a live switch that
 * silently does nothing is worse than one that says so. The tooltip
 * (`hostility-disabled-hint`) says that in the same words — the two are read
 * together and must not drift again. */
export const HostilityToggle = ({
  value,
  onChange,
  disabled = false,
}: {
  value: Hostility;
  onChange: (next: Hostility) => void;
  disabled?: boolean;
}) => {
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
      aria-disabled={disabled || undefined}
      className={`analysis-hostility${disabled ? " analysis-hostility-disabled" : ""}`}
      title={disabled ? t("ui.logs.hostility-disabled-hint") : undefined}
      onKeyDown={(event) => {
        if (disabled) return;
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
          aria-disabled={disabled || undefined}
          // Out of the tab order entirely while disabled: a roving tabindex
          // would still hand focus to a control that cannot be operated.
          tabIndex={disabled ? -1 : value === side.value ? 0 : -1}
          className={`analysis-hostility-option${value === side.value ? " analysis-hostility-active" : ""}`}
          onClick={() => !disabled && onChange(side.value)}
        >
          {t(side.labelKey)}
        </UnstyledButton>
      ))}
    </Box>
  );
};
