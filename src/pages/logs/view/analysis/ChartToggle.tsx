import { Box, Text, UnstyledButton } from "@mantine/core";

/** One entry's shell. An outline on hover, not a fill — the same hover language
 * a metric row uses. */
export const TOGGLE_CLASS =
  "flex items-center gap-[5px] rounded-[3px] px-0.5 py-px hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-line-strong";
/** Carries no colour: each site states its own, because two colour utilities on
 * one element are decided by stylesheet order rather than by which was written
 * last. */
const NAME_CLASS = "text-xs leading-[1.4]";

/** What the toggle stands for on the plot, which decides its glyph.
 *
 * A band shades a stretch of time; a marker is a line at one instant. Drawing
 * both as the same square made the control row say the five things were one
 * kind of thing — and the row sits directly above a plot where they visibly
 * are not. */
export type ChartToggleGlyph = "band" | "marker";

export type ChartToggleProps = {
  label: string;
  color: string;
  shown: boolean;
  onToggle: () => void;
  glyph?: ChartToggleGlyph;
  /** Marks the entry for tests and for the legend's own keying. */
  dataKey?: string;
};

/** A swatch and a name you can switch off — the chart legend's entry, and the
 * control row's window/marker switches.
 *
 * ONE component for both. The control row used to be Mantine `Checkbox`es,
 * which brought the stock theme's box, tick and label sizing into a view built
 * entirely from the shared tokens — the row directly above a legend that draws
 * the same five things in this app's own voice.
 *
 * A hidden entry is DIMMED, never removed: removing it would leave no way to
 * bring the series back. */
export const ChartToggle = ({ label, color, shown, onToggle, glyph = "band", dataKey }: ChartToggleProps) => (
  <UnstyledButton
    {...(dataKey === undefined ? {} : { "data-legend-key": dataKey })}
    className={TOGGLE_CLASS}
    aria-pressed={shown}
    aria-label={label}
    onClick={onToggle}
  >
    <Box
      data-legend-swatch
      aria-hidden
      className={
        glyph === "band"
          ? "size-[calc(9px*var(--density))] flex-none rounded-xs"
          : // A marker's line, at the swatch's own footprint so the two glyphs
            // sit on one baseline and the row does not comb up and down.
            "h-[calc(11px*var(--density))] w-[calc(3px*var(--density))] flex-none rounded-xs"
      }
      style={{ backgroundColor: color, opacity: shown ? 1 : 0.25 }}
    />
    <Text className={`${NAME_CLASS} text-ink-2`} style={{ opacity: shown ? 1 : 0.45 }}>
      {label}
    </Text>
  </UnstyledButton>
);
