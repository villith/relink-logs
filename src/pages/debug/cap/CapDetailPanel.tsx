import { Box, Code, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type {
  ExplainLine,
  ExplainName,
  ExplainReason,
  ExplainSection,
  ExplainValue,
} from "@/pages/logs/view/events/capExplain";
import { translateOvermasteryId, translateSkillboardNode, translateSummonBonusId, translateTraitId } from "@/utils";

/** The value column. Each kind formats one way and only one way — the panel's
 * whole purpose is that two numbers meaning different things never render
 * identically. */
const formatValue = (value: ExplainValue, locale: string): string => {
  switch (value.kind) {
    case "count":
      return value.value.toLocaleString(locale);
    case "percent":
      return `${value.value >= 0 ? "+" : ""}${value.value.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
    case "multiplier":
      return `x${value.value.toLocaleString(locale, { minimumFractionDigits: 3 })}`;
    case "rate":
      return value.value.toLocaleString(locale, { maximumFractionDigits: 4 });
    // Deliberately NOT localised and deliberately not rounded: this is an f32
    // intermediate, and its trailing digits are the reason it is on screen.
    case "float":
      return String(value.value);
    case "hex":
      // eslint-disable-next-line i18next/no-literal-string -- a hex literal is an identifier, not prose
      return `0x${value.value.toString(16).toUpperCase()}`;
    case "text":
      return value.value;
    case "verdict":
      return value.value ? "yes" : "no";
    case "absent":
      return "—";
  }
};

/** Why a considered source contributed nothing, in one short phrase. Rendered
 * in place of a value, so a rejected row still says something. */
const EXCLUSION_KEY: Record<ExplainReason, string> = {
  "not-a-cap-source": "ui.debug.cap-excl-not-a-source",
  conditional: "ui.debug.cap-excl-conditional",
  "dmg-cap-trait": "ui.debug.cap-excl-dmg-cap-trait",
  "other-class": "ui.debug.cap-excl-other-class",
  "zero-at-level": "ui.debug.cap-excl-zero-at-level",
  "value-unrecorded": "ui.debug.cap-excl-unrecorded",
  "unlocks-unrecorded": "ui.debug.cap-excl-unlocks-unrecorded",
  // Where the reconstruction ends, rather than where the caller fell short.
  "stack-curve-unknown": "ui.debug.cap-excl-stack-curve",
  "scaling-unknown": "ui.debug.cap-excl-scaling",
  "no-status-mapping": "ui.debug.cap-excl-no-status",
  "no-action-mapping": "ui.debug.cap-excl-no-action",
  unparsed: "ui.debug.cap-excl-unparsed",
  "needs-params": "ui.debug.cap-excl-needs-params",
};

/** A name resolved through whichever namespace owns it. Entities go through the
 * game's own translation tables so they read as the player sees them; literals
 * are field paths and hex masks and must stay verbatim. */
const useName = () => {
  const { t } = useTranslation();
  return (name: ExplainName): string => {
    switch (name.kind) {
      case "key":
        return t(name.value);
      case "literal":
        return name.value;
      case "trait":
        return translateTraitId(name.id);
      case "overmastery":
        return translateOvermasteryId(name.id);
      case "summon-bonus":
        return translateSummonBonusId(name.id);
      case "skillboard":
        return translateSkillboardNode(name.characterType, name.id);
      case "params":
        return t("ui.debug.cap-needs-params", { params: name.values.join(", ") });
    }
  };
};

const MONO = { fontFamily: "var(--mantine-font-family-monospace)" } as const;
const NUMERIC = { ...MONO, fontVariantNumeric: "tabular-nums" } as const;

/** Wide enough for the longest value this panel produces: a raw f32
 * intermediate like `0.10000002384185791`, at 19 monospace characters (~140px
 * at this size). Sized to that rather than to the numbers that usually appear,
 * because the one time it matters is exactly when the long one shows up. */
const VALUE_WIDTH = 165;
/**
 * The provenance column, sized to the longest thing it actually holds: a
 * 49-character prose annotation ("first row whose x strictly exceeds the rate
 * (f32)") in the proportional font, about 270px.
 *
 * Prose is why this was too narrow before. The column was styled monospace
 * throughout, which is right for `min(base_damage, damage_cap)` and wrong for a
 * sentence — the same 49 characters need ~350px in monospace against ~270 in
 * the body font. Only literals wear the monospace face now (see `LineRow`), and
 * the column wraps rather than truncating, so a translation longer than the
 * English still costs a second line instead of disappearing.
 */
const SOURCE_WIDTH = 340;
/** The name column never squeezes below this — a label crushed to an ellipsis
 * identifies nothing, which defeats the row. */
const NAME_MIN_WIDTH = 190;
/** The two `gap="xs"` gutters between the three columns. */
const GUTTERS = 20;
/** The deepest indent a line can carry (`depth: 2`, an itemized contributor).
 * Counted in because the indent is padding on a border-box element, so at depth
 * 2 it would otherwise eat 32px out of the name column instead of widening the
 * row. */
const MAX_INDENT = 32;

/** Below this the row scrolls rather than compresses. The logs window's minimum
 * is 800px wide and the hit list takes its share of that, so at the low end
 * these three columns genuinely do not fit — and a value bleeding over its
 * neighbour is a worse answer than a scrollbar. Above ~1150px nothing scrolls. */
export const MIN_ROW_WIDTH = NAME_MIN_WIDTH + VALUE_WIDTH + SOURCE_WIDTH + GUTTERS + MAX_INDENT;

const LineRow = ({ line }: { line: ExplainLine }) => {
  const { t, i18n } = useTranslation();
  const resolve = useName();
  const excluded = line.excluded !== undefined;
  const name = resolve(line.name);
  const source =
    line.excluded !== undefined
      ? t(EXCLUSION_KEY[line.excluded])
      : line.source === undefined
        ? ""
        : resolve(line.source);
  // Only an identifier gets the monospace face — a field path, a hex mask, an
  // expression. An exclusion reason and a `key` annotation are sentences, and
  // setting a sentence in monospace costs about a third more width for no
  // legibility at all. That is what overran this column.
  const sourceIsCode = line.excluded === undefined && line.source?.kind === "literal";

  return (
    <Group
      gap="xs"
      wrap="nowrap"
      // Not baseline: the source column wraps, and baseline alignment would
      // hang a two-line annotation off the first line instead of starting it
      // level with the label it belongs to.
      align="flex-start"
      data-cap-line={line.key}
      // The indent IS the claim that this row itemizes the one above it, so it
      // is driven by the model's depth rather than by where the JSX sits.
      style={{ paddingLeft: (line.depth ?? 0) * 16, minWidth: MIN_ROW_WIDTH }}
    >
      <Text
        size="xs"
        truncate
        // `title` because these columns are fixed and a long trait name
        // ellipsises; hovering is then the only way left to read the rest.
        title={name}
        style={{ flex: 1, minWidth: NAME_MIN_WIDTH }}
        // Dimmed, not hidden: a source that was weighed and rejected has to
        // stay visible, or it reads as one the model never knew about.
        c={excluded ? "dimmed" : line.emphasis === "total" ? undefined : "gray.4"}
        fw={line.emphasis === "total" ? 600 : undefined}
      >
        {name}
      </Text>

      <Text
        size="xs"
        ta="right"
        w={VALUE_WIDTH}
        // Never wrapped and never shrunk: a wrapped f32 splits one number
        // across two lines, and a shrunk column is what let it bleed over the
        // provenance column in the first place.
        style={{ ...NUMERIC, flexShrink: 0, whiteSpace: "nowrap" }}
        c={excluded ? "dimmed" : line.emphasis === "total" ? "yellow.4" : undefined}
        fw={line.emphasis === "total" ? 600 : undefined}
      >
        {formatValue(line.value, i18n.language)}
      </Text>

      {/* The "says who?" column. Either the reason it contributed nothing, or
          the field / table / expression the number came from.

          Wraps rather than truncating: this column is the whole point of the
          panel, and an ellipsised provenance answers nothing. A second line is
          cheap; a hidden one is not. */}
      <Text
        size="xs"
        c="dimmed"
        w={SOURCE_WIDTH}
        style={{ ...(sourceIsCode ? MONO : {}), flexShrink: 0, overflowWrap: "anywhere" }}
      >
        {source}
      </Text>
    </Group>
  );
};

const SectionBlock = ({ section }: { section: ExplainSection }) => {
  const { t } = useTranslation();

  return (
    <Box data-cap-section={section.key}>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>
        {t(section.titleKey)}
      </Text>

      {/* Formula first: the symbolic shape, then the same expression with this
          hit's numbers substituted into it. Reading them as a pair is what
          turns a list of values into a derivation. */}
      {section.formula !== null && (
        // A substituted expression is one long line and must not be broken:
        // wrapped mid-expression it stops reading as arithmetic. It scrolls
        // inside itself instead, so it cannot widen the panel either.
        <Code block fz="xs" mb={4} style={{ overflowX: "auto", whiteSpace: "pre" }}>
          {section.formula}
          {section.substituted !== null && `\n= ${section.substituted}`}
        </Code>
      )}

      {section.unavailableKey !== null && (
        <Text size="xs" c="orange.4" mb={4} style={{ maxWidth: MIN_ROW_WIDTH }}>
          {t(section.unavailableKey)}
        </Text>
      )}

      <Stack gap={1}>
        {section.lines.map((line) => (
          <LineRow key={line.key} line={line} />
        ))}
      </Stack>

      {/* Bounded to the row width so a standing caveat wraps into a paragraph
          instead of stretching the panel wider than its own columns. */}
      {section.noteKey !== undefined && (
        <Text size="xs" c="dimmed" fs="italic" mt={4} style={{ maxWidth: MIN_ROW_WIDTH }}>
          {t(section.noteKey)}
        </Text>
      )}
    </Box>
  );
};

/** The full derivation for one hit, section by section, in the order the game
 * computes it. */
export const CapDetailPanel = ({ sections }: { sections: ExplainSection[] }) => (
  <Stack gap="md" data-cap-panel>
    {sections.map((section) => (
      <SectionBlock key={section.key} section={section} />
    ))}
  </Stack>
);
