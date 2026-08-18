import { UnstyledButton } from "@mantine/core";
import type { Icon } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { onArrowKeys } from "@/components/ui/rovingKeys";
import { Strip } from "@/components/ui/Strip";

/** `icon` is the component, not an element: the tab lists are plain `.ts`
 * modules and cannot spell JSX. Only the body switch carries one. */
export type MetricTab = { value: string; labelKey: string; icon?: Icon };

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
    // Inline, the tabs sit inside a row that already supplies the band: no rule,
    // no padding of its own, and `gap` rather than the buttons' margin.
    <Strip
      role="tablist"
      aria-label={t(ariaLabelKey)}
      onKeyDown={onArrowKeys(move)}
      rule={variant === "inline" ? "none" : "bottom"}
      pad={variant === "inline" ? "none" : "frame"}
      className={variant === "inline" ? "gap-5" : undefined}
    >
      {tabs.map((tab) => {
        const active = tab.value === value;
        const Glyph = tab.icon;
        return (
          <UnstyledButton
            key={tab.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={[
              "border-b-2 text-lg font-semibold tracking-[-0.01em]",
              // Inline, the row above supplies the vertical padding and the
              // strip's `gap` supplies the spacing — repeating either here would
              // push the underline off the text and double the gutter.
              variant === "inline" ? "py-[3px]" : "mr-5 py-[7px]",
              active ? "border-accent text-ink" : "border-transparent text-ink-3",
              // An `<svg>` in a text box sits on the baseline; the pair have to
              // be flex items to centre. Left off the tabs that carry no icon.
              Glyph === undefined ? "" : "inline-flex items-center gap-1.5",
            ].join(" ")}
          >
            {Glyph !== undefined && <Glyph size={16} aria-hidden />}
            {t(tab.labelKey)}
          </UnstyledButton>
        );
      })}
    </Strip>
  );
};
