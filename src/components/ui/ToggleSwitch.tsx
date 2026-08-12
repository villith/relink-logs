import { UnstyledButton } from "@mantine/core";

import { cn } from "./cn";

export type ToggleSwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The switch's own words — its accessible name AND the text beside the
   * track, deliberately one string: a switch labelled one way and announced
   * another is two controls to anyone comparing notes. */
  label: string;
  /** Kept on screen and inert, never hidden — the rule `PillGroup` follows. */
  disabled?: boolean;
  title?: string;
};

/** The app's on/off control, in the same palette as `PillGroup`.
 *
 * A button with `role="switch"` rather than Mantine's stock `Switch`: the whole
 * pill — track and label together — is the target, which puts it comfortably
 * past WCAG 2.2 SC 2.5.8's 24x24, and it is built from the shared tokens rather
 * than the default theme, so it does not read as borrowed from another screen.
 *
 * State reads as POSITION as well as colour (the knob travels), because a
 * control that said "on" in hue alone is unreadable to exactly the eyes the
 * rest of these colour choices are made for.
 *
 * The BORDER is not one of the things that says so, deliberately. An accent
 * frame on the checked switch read as an outline — which is what a focus ring
 * and a selected `PillGroup` pill are both drawn with — so a switch that was
 * merely on looked either focused or selected, right beside a strip of pills
 * where that same frame means something else. The fill, the track and the knob
 * say it three times without borrowing another control's vocabulary.
 *
 * A disabled switch keeps the native `disabled` attribute OFF — `aria-disabled`
 * and an `onClick` no-op instead: browsers drop pointer events, hover included,
 * on a truly disabled control, which would silence the very tooltip that
 * explains the disabling. */
export const ToggleSwitch = ({ checked, onChange, label, disabled = false, title }: ToggleSwitchProps) => (
  <UnstyledButton
    role="switch"
    aria-checked={checked}
    aria-label={label}
    aria-disabled={disabled || undefined}
    tabIndex={disabled ? -1 : 0}
    title={title}
    className={[
      "inline-flex items-center gap-[7px] rounded border border-line py-0.5 pl-[3px] pr-2 text-sm font-semibold",
      checked ? "bg-accent-soft text-ink" : "bg-panel text-ink-3",
      disabled ? "cursor-default opacity-40" : "cursor-pointer hover:border-line-strong",
    ].join(" ")}
    // Guarded here as well as by `aria-disabled`, which is an announcement and
    // not a lock: a dimmed control that still reports a change is the same
    // defect as an undimmed one.
    onClick={() => !disabled && onChange(!checked)}
  >
    <span
      aria-hidden
      className={cn(
        "relative h-[calc(var(--text-sm)*1.05)] w-[calc(var(--text-sm)*1.9)] flex-none rounded-full",
        "transition-colors duration-100",
        checked ? "bg-accent" : "bg-line-strong"
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-1/2 size-[calc(var(--text-sm)*0.75)] rounded-full",
          "transition-transform duration-100",
          checked ? "translate-x-[calc(var(--text-sm)*0.85)] -translate-y-1/2 bg-bg" : "-translate-y-1/2 bg-ink"
        )}
      />
    </span>
    <span>{label}</span>
  </UnstyledButton>
);
