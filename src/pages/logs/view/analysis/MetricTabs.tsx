import { Box, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { onArrowKeys } from "@/components/ui/rovingKeys";

import "./analysis.css";

export type MetricTab = { value: string; labelKey: string };

export type MetricTabsProps = {
  tabs: MetricTab[];
  value: string;
  onChange: (value: string) => void;
  /** What the tablist is a list OF, for screen readers. Defaults to the metric
   * switcher's own label — the other caller is the top-level view switch, which
   * is a different question and must not announce itself as "Metric". */
  ariaLabelKey?: string;
  /** `strip` is the full-width row under the selector bar; `inline` drops the
   * row's own rule and padding so the tabs can sit INSIDE another row (the
   * selector bar's right edge). Only the frame differs — the tabs themselves,
   * and the keyboard behaviour, are the same control either way. */
  variant?: "strip" | "inline";
};

/** A tablist: the metric switcher, and the top-level Table | Events switch.
 *
 * A tablist rather than Mantine's SegmentedControl: choosing a metric — or a
 * view — changes what the whole page is about, which is navigation, and a row of
 * pills reads as a form control. */
export const MetricTabs = ({
  tabs,
  value,
  onChange,
  ariaLabelKey = "ui.logs.metric-tablist-label",
  variant = "strip",
}: MetricTabsProps) => {
  const { t } = useTranslation();

  // Arrow keys move between tabs and only the active tab is tabbable — the
  // ARIA tabs pattern (`onArrowKeys` owns the key contract). Without it every
  // tab is a separate tab stop and the arrows do nothing.
  const move = (delta: number) => {
    const at = tabs.findIndex((tab) => tab.value === value);
    const next = tabs[(at + delta + tabs.length) % tabs.length];
    if (next) onChange(next.value);
  };

  return (
    <Box
      role="tablist"
      aria-label={t(ariaLabelKey)}
      onKeyDown={onArrowKeys(move)}
      style={
        variant === "inline"
          ? { display: "flex", gap: 20 }
          : { display: "flex", padding: "0 16px", borderBottom: "1px solid var(--color-line)" }
      }
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
              // Inline, the row above supplies the vertical padding and `gap`
              // supplies the spacing — repeating either here would push the
              // underline off the text and double the gutter.
              padding: variant === "inline" ? "3px 0" : "7px 0",
              marginRight: variant === "inline" ? 0 : 20,
              fontSize: "var(--text-lg)",
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: active ? "var(--color-ink)" : "var(--color-ink-3)",
              borderBottom: `2px solid ${active ? "var(--color-accent)" : "transparent"}`,
            }}
          >
            {t(tab.labelKey)}
          </UnstyledButton>
        );
      })}
    </Box>
  );
};
