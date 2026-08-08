import type { ReactNode } from "react";

export type StripProps = {
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
  className?: string;
};

const RULE_CLASS = {
  bottom: "border-b border-line",
  top: "border-t border-line",
  none: "",
} as const;

/** A horizontal band across the view, separated by a hairline.
 *
 * The quest header, the pin bar, the metric tabs, the aura and window chip
 * strips, the events toolbar. Every one of them was previously a `Box` with the
 * same six declarations written out by hand, which is how three of them came to
 * disagree about their padding. */
export const Strip = ({ children, rule = "bottom", wrap = false, align = "center", className }: StripProps) => (
  <div
    className={[
      "flex gap-2 px-4 py-1.5",
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
