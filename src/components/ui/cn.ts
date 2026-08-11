import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The scales `theme.css` adds that stock Tailwind has never heard of.
 *
 * tailwind-merge only dedupes utilities whose scale it knows, and it GUESSES at
 * the ones it does not: an unrecognised `text-*` is read as a colour, so
 * `text-label` and `text-sm` both survived a merge, while `text-label` and
 * `text-accent` — a size and a colour, two different properties — collapsed to
 * one. Both are proven in `cn.test.ts`; neither is a merge anyone would want.
 *
 * `text` is tailwind-merge's key for FONT SIZES. `xs`/`sm`/`lg`/`xl`/`2xl`
 * collide with the stock scale and are already known; only the two names that
 * are ours alone need declaring. */
const THEME = {
  text: ["label", "md"],
  spacing: ["row", "head", "control", "chip", "icon", "icon-sm", "icon-xs", "swatch", "cell", "name"],
};

const twMerge = extendTailwindMerge({ extend: { theme: THEME } });

/**
 * Join class strings (clsx semantics) and dedupe conflicting Tailwind
 * utilities (tailwind-merge). Use everywhere primitives or components
 * accept a `className` prop:
 *
 *   <div className={cn("p-2 rounded", className)} />
 */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(...classes));
}
