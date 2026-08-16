import { Box } from "@mantine/core";
import { Check } from "@phosphor-icons/react";

/** The tick in front of a menu row. Always drawn, empty when unticked: a glyph
 * that appears and disappears moves the label under the cursor, and a menu the
 * eye is scanning down a column of is the worst place for that.
 *
 * Shared by the dropdowns in this view — the window chips' multi-select and the
 * smoothing window's single choice. Two spellings of one tick would drift, and
 * the two open a few pixels apart in the same strip. */
export const MenuTick = ({ checked }: { checked: boolean }) => (
  <Box
    aria-hidden
    className={[
      "inline-flex size-[calc(13px*var(--density))] flex-none items-center justify-center rounded-xs border",
      checked ? "border-accent bg-accent text-bg" : "border-line-strong",
    ].join(" ")}
  >
    {checked && <Check size={9} weight="bold" />}
  </Box>
);
