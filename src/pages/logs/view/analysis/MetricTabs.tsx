import { Box, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import "./analysis.css";

export type MetricTab = { value: string; labelKey: string };

export type MetricTabsProps = {
  tabs: MetricTab[];
  value: string;
  onChange: (value: string) => void;
};

/** The metric switcher.
 *
 * A tablist rather than Mantine's SegmentedControl: choosing a metric changes
 * what the whole page is about, which is navigation, and a row of pills reads
 * as a form control. */
export const MetricTabs = ({ tabs, value, onChange }: MetricTabsProps) => {
  const { t } = useTranslation();

  // Arrow keys move between tabs and only the active tab is tabbable — the
  // ARIA tabs pattern. Without it every tab is a separate tab stop and the
  // arrows do nothing.
  const move = (delta: number) => {
    const at = tabs.findIndex((tab) => tab.value === value);
    const next = tabs[(at + delta + tabs.length) % tabs.length];
    if (next) onChange(next.value);
  };

  return (
    <Box
      role="tablist"
      aria-label={t("ui.logs.metric-tablist-label")}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") move(1);
        else if (event.key === "ArrowLeft") move(-1);
        else return;
        event.preventDefault();
      }}
      style={{ display: "flex", padding: "0 16px", borderBottom: "1px solid var(--an-line)" }}
    >
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <UnstyledButton
            key={tab.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            style={{
              padding: "7px 0",
              marginRight: 20,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: active ? "var(--an-ink)" : "var(--an-ink-3)",
              borderBottom: `2px solid ${active ? "var(--an-accent)" : "transparent"}`,
            }}
          >
            {t(tab.labelKey)}
          </UnstyledButton>
        );
      })}
    </Box>
  );
};
