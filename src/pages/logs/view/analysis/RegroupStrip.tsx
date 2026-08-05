import { Box, Tooltip, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { RegroupTab } from "./machine/resolve";
import type { Dimension } from "./machine/state";

export type RegroupStripProps = {
  tabs: RegroupTab[];
  onRegroup: (dim: Dimension) => void;
};

/** WCL's "Done By …" strip: the resolved grouping is only a default, and this
 * is the override. Every dimension is always listed — an unsupported one is
 * disabled with its reason, never hidden, so a hole is visible.
 *
 * MetricTabs' smaller sibling: the same ARIA-tabs pattern (role="tablist" /
 * role="tab", `aria-selected` marks the active one), one size down, no arrow-
 * key roving since there's no room here for a second keyboard scheme layered
 * under MetricTabs' own.
 *
 * A disabled tab keeps the native `disabled` attribute OFF: browsers drop
 * pointer events — hover included — on a truly disabled control, which would
 * silence the very tooltip meant to explain the disabling. Instead it's
 * `aria-disabled` plus an `onClick` no-op, so the Tooltip still triggers. */
export const RegroupStrip = ({ tabs, onRegroup }: RegroupStripProps) => {
  const { t } = useTranslation();

  return (
    <Box
      role="tablist"
      aria-label={t("ui.logs.regroup-tablist-label")}
      style={{ display: "flex", padding: "0 16px 6px" }}
    >
      {tabs.map((tab) => {
        const disabled = tab.disabledReason !== undefined;
        const button = (
          <UnstyledButton
            role="tab"
            aria-selected={tab.active}
            aria-disabled={disabled || undefined}
            tabIndex={tab.active ? 0 : -1}
            onClick={() => {
              if (!disabled && !tab.active) onRegroup(tab.dim);
            }}
            style={{
              padding: "4px 0",
              marginRight: 14,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: disabled ? "var(--an-ink-3)" : tab.active ? "var(--an-ink)" : "var(--an-ink-3)",
              opacity: disabled ? 0.45 : 1,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            {t(tab.labelKey)}
          </UnstyledButton>
        );

        return (
          <Tooltip key={tab.dim} label={disabled ? t(tab.disabledReason!) : ""} disabled={!disabled}>
            {button}
          </Tooltip>
        );
      })}
    </Box>
  );
};
