import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type StripProps = Omit<ComponentPropsWithoutRef<"div">, "className" | "children"> & {
  children: ReactNode;
  /** Which edge carries the hairline. The aura and window strips rule their TOP
   * because they sit under the chart; every header strip rules its bottom. */
  rule?: "bottom" | "top" | "none";
  /** Chip strips wrap; toolbar rows must not, or a narrow window silently
   * reflows the controls into two rows of different heights. */
  wrap?: boolean;
  /** `baseline` for a row of mixed type sizes that must sit on one line — the
   * quest header, where a 17px figure and a 10px label share a row. */
  align?: "center" | "baseline";
  /** How much room the band keeps around its contents. `frame` holds the
   * gutter but drops the vertical padding and the gap, for a band whose
   * children state their own — the metric tab row, whose underline has to reach
   * the band's bottom edge. `none` frames nothing and only carries the rule.
   *
   * A PROP rather than a `py-0 gap-0` in `className`: Tailwind orders utilities
   * by scale value, so a smaller override sorts BEFORE the default it means to
   * replace and silently loses the cascade. */
  pad?: "default" | "frame" | "none";
  className?: string;
};

const RULE_CLASS = {
  bottom: "border-b border-line",
  top: "border-t border-line",
  none: "",
} as const;

const PAD_CLASS = {
  default: "gap-2 px-4 py-1.5",
  frame: "px-4",
  none: "",
} as const;

/** A horizontal band across the view, separated by a hairline.
 *
 * The quest header, the pin bar, the metric tabs, the aura and window chip
 * strips, the events toolbar. Every one of them was previously a `Box` with the
 * same six declarations written out by hand, which is how three of them came to
 * disagree about their padding. */
export const Strip = ({
  children,
  rule = "bottom",
  wrap = false,
  align = "center",
  pad = "default",
  className,
  ...rest
}: StripProps) => (
  // Anything else the caller passed rides through — the events stream's kind
  // filters are a `role="group"` with a name, and a band that could not say so
  // would be a list of controls announced as loose buttons.
  <div
    {...rest}
    className={[
      "flex",
      PAD_CLASS[pad],
      align === "baseline" ? "items-baseline" : "items-center",
      wrap ? "flex-wrap" : "",
      RULE_CLASS[rule],
      className,
    ]
      .filter(Boolean)
      .join(" ")}
  >
    {children}
  </div>
);
