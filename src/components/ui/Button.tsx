import { UnstyledButton } from "@mantine/core";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "./cn";

/** `default` is a bordered box — the view's ordinary action. `subtle` is a quiet
 * text button for a way out of something (clear, dismiss). `icon` is a square
 * holding one glyph, sized past WCAG 2.2 SC 2.5.8's 24x24 target. */
export type ButtonVariant = "default" | "subtle" | "icon";

export type ButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className" | "children"> & {
  children?: ReactNode;
  variant?: ButtonVariant;
  /** Marks the button as the live one — the accent every selected control in
   * the view wears. */
  active?: boolean;
  /** Kept on screen and inert, never hidden — the rule `PillGroup` follows. */
  disabled?: boolean;
  className?: string;
};

const BASE_CLASS = "inline-flex items-center justify-center gap-1.5 text-sm";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default:
    "h-control min-h-control rounded-sm border border-line bg-panel px-2.5 font-semibold text-ink-2 focus:border-accent",
  subtle: "rounded-xs px-1 text-ink-3",
  icon: "size-control shrink-0 rounded-xs text-ink-3",
};

const HOVER_CLASS: Record<ButtonVariant, string> = {
  default: "hover:border-line-strong hover:text-ink",
  subtle: "hover:bg-raised hover:text-ink",
  icon: "hover:bg-raised hover:text-ink",
};

const ACTIVE_CLASS: Record<ButtonVariant, string> = {
  default: "border-accent bg-accent-soft text-ink",
  subtle: "text-accent",
  icon: "text-accent",
};

/** The app's button, in the view's own tokens.
 *
 * Mantine's `Button` and `ActionIcon` bring their own border, fill and font,
 * which read as another screen's design beside the token-built controls around
 * them; every site that cared had hand-written the same handful of utilities
 * instead. This is that look, once.
 *
 * `disabled` keeps the native attribute OFF — browsers drop pointer events,
 * hover included, on a truly disabled control, which silences the tooltip that
 * would explain the disabling. `aria-disabled` plus a guarded handler instead,
 * as `PillGroup` and `ToggleSwitch` both do. */
export const Button = ({
  children,
  variant = "default",
  active = false,
  disabled = false,
  className,
  onClick,
  ...rest
}: ButtonProps) => (
  <UnstyledButton
    {...rest}
    type="button"
    aria-disabled={disabled || undefined}
    tabIndex={disabled ? -1 : 0}
    className={cn(
      BASE_CLASS,
      VARIANT_CLASS[variant],
      active && ACTIVE_CLASS[variant],
      disabled ? "cursor-default opacity-40" : `cursor-pointer ${HOVER_CLASS[variant]}`,
      className
    )}
    onClick={disabled ? undefined : onClick}
  >
    {children}
  </UnstyledButton>
);
