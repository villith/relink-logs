import { useTranslation } from "react-i18next";

import { PillGroup } from "@/components/ui/PillGroup";

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
 * silently does nothing is worse than one that says so — which is what the
 * tooltip (`hostility-disabled-hint`) tells the user. Both were last corrected
 * together, when the damage tabs grew an enemy side and falsified them.
 *
 * No caption: "Friendlies | Enemies" already names the question its options
 * answer — unlike the chart's smoothing pills, which carry one. */
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

  return (
    <PillGroup
      options={SIDES.map((side) => ({ value: side.value, label: t(side.labelKey) }))}
      value={value}
      onChange={onChange}
      ariaLabel={t("ui.logs.hostility-label")}
      disabled={disabled}
      {...(disabled ? { title: t("ui.logs.hostility-disabled-hint") } : {})}
    />
  );
};
