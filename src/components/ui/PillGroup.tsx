import { Box, UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";

import { Label } from "./Label";
import { onArrowKeys } from "./rovingKeys";

export type PillOption<T extends string> = { value: T; label: string };

export type PillGroupProps<T extends string> = {
  options: PillOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** What the group SETS, for screen readers. Always required: a group labels
   * its options and not its subject ("Off 5s 10s 30s" names four durations and
   * no question), so without this a radiogroup announces nothing about what is
   * being chosen. */
  ariaLabel: string;
  /** The same question in the UI, in the app's small-caps voice. Optional
   * because some option sets say what they are ("Friendlies | Enemies");
   * anything whose options are bare values should carry one. */
  caption?: ReactNode;
  /** Kept on screen and inert, never hidden: a control that came and went would
   * shift everything below it each time the page changed underneath. */
  disabled?: boolean;
  /** Hover text — the disabled reason, or what the choice does. */
  title?: string;
};

/** The app's segmented control: a row of small pills, one chosen.
 *
 * One component for every such control — a side switch, a chart's smoothing
 * window, a display mode. They were previously hand-built per site or left as
 * Mantine's stock `SegmentedControl`, which is how one row came to hold two
 * designs' worth of styling.
 *
 * An ARIA radiogroup, not a tablist: choosing here re-reads what is already on
 * screen rather than navigating to something else. Arrow keys move the
 * selection and only the checked option is tabbable — the radio pattern;
 * without the roving tabindex every pill is its own tab stop and the arrows do
 * nothing. */
export const PillGroup = <T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  caption,
  disabled = false,
  title,
}: PillGroupProps<T>) => {
  const step = (delta: number) => {
    const at = options.findIndex((option) => option.value === value);
    // From a value the caller does not offer, a step lands on the first option
    // rather than nowhere.
    const next = options[(Math.max(0, at) + delta + options.length) % options.length];
    if (next && next.value !== value) onChange(next.value);
  };

  const group = (
    <Box
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={["inline-flex gap-0.5 rounded border border-line bg-panel p-0.5", disabled ? "opacity-40" : ""]
        .filter(Boolean)
        .join(" ")}
      // With a caption the whole field carries the tooltip instead, so hovering
      // the word in front of the pills explains them too.
      title={caption === undefined ? title : undefined}
      onKeyDown={disabled ? undefined : onArrowKeys(step)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <UnstyledButton
            key={option.value}
            role="radio"
            aria-checked={active}
            aria-disabled={disabled || undefined}
            // Out of the tab order entirely while disabled: a roving tabindex
            // would still hand focus to a control that cannot be operated.
            tabIndex={disabled ? -1 : active ? 0 : -1}
            className={[
              "whitespace-nowrap rounded-sm px-2.5 py-0.5 text-sm font-semibold",
              active ? "bg-raised text-ink" : "text-ink-3",
              disabled ? "cursor-default" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            // Guarded here as well as by the dimming: a class is a look, not a
            // lock, and a dimmed control that still reports a change is the
            // same defect as an undimmed one.
            onClick={() => !disabled && onChange(option.value)}
          >
            {option.label}
          </UnstyledButton>
        );
      })}
    </Box>
  );

  if (caption === undefined) return group;

  return (
    <Box className="inline-flex items-center gap-1.5" title={title}>
      {/* Not a <label>: the thing it names is a radiogroup, which `for` cannot
          address — the accessible name rides `ariaLabel`, and this is the
          sighted reader's copy of it. */}
      <Label aria-hidden>{caption}</Label>
      {group}
    </Box>
  );
};
