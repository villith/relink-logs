/** The chip anatomy, shared by every strip that draws one — the Windows
 * filter's kind chips and the events stream's kind filters. Two spellings of a
 * chip would drift, and the two strips sit two clicks apart in the same view.
 *
 * Classes rather than a component, because the strips no longer share a
 * BEHAVIOUR: a window chip opens a menu of its kind's windows, an event chip
 * toggles itself. They previously shared `ChipStrip`, which had grown props for
 * both readings and a doc comment explaining which caller each was for; what
 * they actually have in common is the look. */
export const CHIP_CLASS = "inline-flex h-chip items-center rounded-sm border border-line-strong bg-panel";
// The `pr-0.5` these two used to carry was clearance for a per-chip ✕. Neither
// strip draws one now — the window strip has ONE ✕ for the whole selection —
// so the padding only pushed the chips' contents off-centre.
export const CHIP_SELECTED_CLASS = "border-accent bg-accent-soft";
export const CHIP_BUTTON_CLASS = "inline-flex h-full cursor-pointer items-center gap-1.5 px-2 text-sm text-ink-2";
export const CHIP_BUTTON_SELECTED_CLASS = "text-ink";
/** A window kind's colour block, before the label. */
export const CHIP_SWATCH_CLASS = "inline-block size-swatch shrink-0 rounded-xs";
