/** The view's own dropdown surface, for every Mantine overlay that opens out of
 * a control in it — the pin selectors' combobox and the window chips' menu.
 *
 * One declaration because the two open two clicks apart in the same strip, and
 * a stock Mantine panel beside a token-built one reads as two designs sharing a
 * screen. That is exactly what the window menu shipped as before this: `Menu`
 * with no `classNames` draws the default dark popover, which is a different
 * background, border, radius and row height from the chip it drops out of.
 *
 * Plain utilities, no compound selectors: Mantine's stylesheet is a cascade
 * LAYER, so every utility outranks it whatever the source order.
 *
 * These portal to document.body, outside `.analysis` — which costs them
 * nothing, because the theme puts every token on :root and custom properties
 * inherit down to a portal as readily as to anything else. */
export const DROPDOWN_PANEL_CLASS = "rounded-sm border border-line-strong bg-panel p-1 shadow-md";

/** One row of such a panel, at rest. Hover and keyboard-active read the SAME,
 * as they do on a table row: a dropdown is a list of things to land on, not two
 * kinds of highlight. The per-widget state attributes differ (a combobox marks
 * its rows `data-combobox-*`, a menu marks its `data-hovered`), so each caller
 * appends its own — this is the part they share. */
export const DROPDOWN_ROW_CLASS = "rounded-xs text-md text-ink-2";

/** A combobox option: the shared row plus Mantine's combobox state hooks. */
export const COMBOBOX_OPTION_CLASS = [
  DROPDOWN_ROW_CLASS,
  "hover:bg-raised hover:text-ink",
  "data-[combobox-active]:bg-raised data-[combobox-active]:text-ink",
  "data-[combobox-selected]:bg-raised data-[combobox-selected]:text-ink",
].join(" ");

/** A menu item: the shared row plus the menu's own state hooks.
 *
 * A DISABLED item stays legible rather than dropping to Mantine's near-invisible
 * grey — the window menu disables its individual rows while the whole kind is
 * selected, and a reader has to be able to see that those windows are the ones
 * being admitted. It loses its hover instead, which is what says "not a control
 * right now". */
export const MENU_ITEM_CLASS = [
  DROPDOWN_ROW_CLASS,
  "px-2 py-1",
  "data-[hovered]:bg-raised data-[hovered]:text-ink",
  "data-[disabled]:opacity-60 data-[disabled]:data-[hovered]:bg-transparent",
].join(" ");
