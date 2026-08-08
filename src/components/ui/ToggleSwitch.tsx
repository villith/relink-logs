import { UnstyledButton } from "@mantine/core";

import "./ui.css";

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
    className={`ui-switch${checked ? " ui-switch-on" : ""}${disabled ? " ui-switch-disabled" : ""}`}
    // Guarded here as well as by `aria-disabled`, which is an announcement and
    // not a lock: a dimmed control that still reports a change is the same
    // defect as an undimmed one.
    onClick={() => !disabled && onChange(!checked)}
  >
    <span className="ui-switch-track" aria-hidden>
      <span className="ui-switch-knob" />
    </span>
    <span className="ui-switch-label">{label}</span>
  </UnstyledButton>
);
