import type { ReactNode } from "react";

export type FigureSize = "xs" | "sm" | "md" | "lg" | "2xl";
export type FigureTone = "default" | "muted" | "dim";

const SIZE_CLASS: Record<FigureSize, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-md",
  lg: "text-lg",
  "2xl": "text-2xl",
};

const TONE_CLASS: Record<FigureTone, string> = {
  default: "",
  muted: "text-ink-2",
  dim: "text-ink-3",
};

export type FigureProps = {
  children: ReactNode;
  size?: FigureSize;
  tone?: FigureTone;
  className?: string;
};

/** A number the reader compares against other numbers.
 *
 * Tabular ALWAYS — that is the whole point of the component. Every figure in
 * the view is tabular so columns align down the page, and the eight sites that
 * previously set `fontVariantNumeric` inline are eight chances to forget. */
export const Figure = ({ children, size = "lg", tone = "default", className }: FigureProps) => (
  <span className={["tabular-nums", SIZE_CLASS[size], TONE_CLASS[tone], className].filter(Boolean).join(" ")}>
    {children}
  </span>
);
