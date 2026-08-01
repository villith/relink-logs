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

  return (
    <Box role="tablist" style={{ display: "flex", padding: "0 16px", borderBottom: "1px solid var(--an-line)" }}>
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <UnstyledButton
            key={tab.value}
            role="tab"
            aria-selected={active}
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
