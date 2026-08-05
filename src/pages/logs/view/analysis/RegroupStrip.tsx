import { Box, Tooltip, UnstyledButton } from "@mantine/core";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import "./analysis.css";

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
 * MetricTabs' smaller sibling: the intended ARIA-tabs pattern (role="tablist"
 * / role="tab", `aria-selected` marks the active one, roving tabindex with
 * ArrowLeft/ArrowRight moving focus), one size down. The one wrinkle
 * MetricTabs never needed: a disabled dimension has no control to land on, so
 * the roving cycle skips it.
 *
 * A disabled tab keeps the native `disabled` attribute OFF: browsers drop
 * pointer events — hover included — on a truly disabled control, which would
 * silence the very tooltip meant to explain the disabling. Instead it's
 * `aria-disabled` plus an `onClick` no-op, so the Tooltip still triggers. */
export const RegroupStrip = ({ tabs, onRegroup }: RegroupStripProps) => {
  const { t } = useTranslation();
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Roves from whichever button the keydown originated on, skipping any
  // disabled dimension, and wraps at the ends — cycling all the way around
  // to `from` itself (nothing else enabled) is a no-op.
  const move = (from: number, delta: number) => {
    let next = from;
    for (let i = 0; i < tabs.length; i++) {
      next = (next + delta + tabs.length) % tabs.length;
      if (tabs[next].disabledReason === undefined) break;
    }
    if (next === from) return;
    buttonRefs.current[next]?.focus();
    if (!tabs[next].active) onRegroup(tabs[next].dim);
  };

  return (
    <Box
      role="tablist"
      aria-label={t("ui.logs.regroup-tablist-label")}
      style={{ display: "flex", padding: "0 16px 6px" }}
      onKeyDown={(event) => {
        const from = buttonRefs.current.indexOf(event.target as HTMLButtonElement);
        if (from === -1) return;
        if (event.key === "ArrowRight") move(from, 1);
        else if (event.key === "ArrowLeft") move(from, -1);
        else return;
        event.preventDefault();
      }}
    >
      {tabs.map((tab, index) => {
        const disabled = tab.disabledReason !== undefined;
        const button = (
          <UnstyledButton
            ref={(el: HTMLButtonElement | null) => {
              buttonRefs.current[index] = el;
            }}
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
