import { Box, Code, Group, Stack, Text } from "@mantine/core";
import { Function as FunctionIcon, Info, MinusCircle, Question } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
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

/** Why a considered source contributed nothing, in one short phrase. Shown in
 * the row's hover card, so a rejected row still says something. */
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
  "gate-unrecorded": "ui.debug.cap-excl-gate-unrecorded",
};

/** The reasons that mean "the log could not say", as opposed to "the game state
 * said no". The two get different markers: an unresolved term is a hole in the
 * capture and might still have applied; an inactive one was weighed and ruled
 * out. Collapsing them is what made the old flat reason column unreadable. */
const UNKNOWN_REASONS: ReadonlySet<ExplainReason> = new Set<ExplainReason>([
  "value-unrecorded",
  "unlocks-unrecorded",
  "stack-curve-unknown",
  "scaling-unknown",
  "no-status-mapping",
  "no-action-mapping",
  "unparsed",
  "needs-params",
  "gate-unrecorded",
]);

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

/** The chrome every hover card on this page wears — same surface as
 * `SkillTargetTooltip`, built from Mantine vars only so it needs no token layer
 * the Debug page might not load. Shared with `HitPipeline`'s cards. */
export const DEBUG_CARD_STYLE = {
  background: "var(--mantine-color-dark-6)",
  border: "1px solid var(--mantine-color-dark-4)",
  borderRadius: "var(--mantine-radius-sm)",
  padding: "6px 10px",
  boxShadow: "var(--mantine-shadow-md)",
  maxWidth: 340,
} as const;

/** Wide enough for the longest value this panel produces: a raw f32
 * intermediate like `0.10000002384185791`, at 19 monospace characters (~140px
 * at this size). Sized to that rather than to the numbers that usually appear,
 * because the one time it matters is exactly when the long one shows up. */
const VALUE_WIDTH = 150;
/** The name column never squeezes below this. Below its natural width a name
 * ellipsises; the hover card then carries the full name. */
const NAME_MIN_WIDTH = 140;
/** The status gutter at the row's right edge. Always reserved, marked or not,
 * so the value column's right edge holds steady down the whole section. */
const MARKER_WIDTH = 16;
/** The two `gap="xs"` gutters between the three columns. */
const GUTTERS = 20;
/** The deepest indent a line can carry (`depth: 2`, an itemized contributor). */
const MAX_INDENT = 28;

/** The row's hard floor: the name compresses (truncates) down to its minimum,
 * and only below this sum does the enclosing ScrollArea scroll rather than let
 * a value bleed over its neighbour. */
export const MIN_ROW_WIDTH = NAME_MIN_WIDTH + VALUE_WIDTH + MARKER_WIDTH + GUTTERS + MAX_INDENT;

/** A section-header affordance whose payload lives in a hover card: the ƒ
 * formula icon and the ⓘ note icon. */
const HeaderIcon = ({
  testId,
  label,
  children,
  content,
  wide,
}: {
  testId: string;
  label: string;
  children: React.ReactNode;
  content: React.ReactNode;
  /** A substituted expression is one long unbreakable line; its card gets more
   * room than a prose note needs. */
  wide?: boolean;
}) => (
  <CursorCard
    testId={testId}
    style={wide === true ? { ...DEBUG_CARD_STYLE, maxWidth: 560 } : DEBUG_CARD_STYLE}
    content={content}
  >
    <Box component="span" aria-label={label} style={{ cursor: "help", lineHeight: 0, display: "inline-flex" }}>
      {children}
    </Box>
  </CursorCard>
);

const LineRow = ({ line }: { line: ExplainLine }) => {
  const { t, i18n } = useTranslation();
  const resolve = useName();
  const excluded = line.excluded;
  const unknown = excluded !== undefined && UNKNOWN_REASONS.has(excluded);
  const total = line.emphasis === "total";
  const name = resolve(line.name);
  const source = line.source === undefined ? null : resolve(line.source);
  // Only an identifier gets the monospace face — a field path, a hex mask, an
  // expression. A `key` annotation is a sentence, and monospace prose costs a
  // third more width for no legibility at all.
  const sourceIsCode = line.source?.kind === "literal";
  const hasCard = source !== null || excluded !== undefined;

  const row = (
    <Group
      gap="xs"
      wrap="nowrap"
      align="center"
      data-cap-line={line.key}
      data-cap-excluded={excluded}
      style={{
        paddingLeft: (line.depth ?? 0) * 14,
        minWidth: MIN_ROW_WIDTH,
        ...(hasCard ? { cursor: "help" } : {}),
        // A total reads as a sum line: ruled off from the addends above it.
        ...(total ? { borderTop: "1px solid var(--mantine-color-dark-4)", marginTop: 3, paddingTop: 3 } : {}),
      }}
    >
      <Text
        size="xs"
        truncate
        style={{ flex: 1, minWidth: NAME_MIN_WIDTH }}
        // Dimmed, not hidden: a source that was weighed and rejected has to
        // stay visible, or it reads as one the model never knew about.
        c={excluded !== undefined ? "dimmed" : total ? undefined : "gray.4"}
        fw={total ? 600 : undefined}
      >
        {name}
      </Text>

      <Text
        size="xs"
        ta="right"
        w={VALUE_WIDTH}
        // Never wrapped and never shrunk: a wrapped f32 splits one number
        // across two lines.
        style={{ ...NUMERIC, flexShrink: 0, whiteSpace: "nowrap" }}
        c={excluded !== undefined ? "dimmed" : total ? "yellow.4" : undefined}
        fw={total ? 600 : undefined}
      >
        {formatValue(line.value, i18n.language)}
      </Text>

      {/* The status gutter: ? for "the log could not say", ○ for "weighed and
          ruled out". The full reason is in the row's hover card. */}
      <Box w={MARKER_WIDTH} style={{ flexShrink: 0, lineHeight: 0, display: "flex", alignItems: "center" }}>
        {excluded !== undefined &&
          (unknown ? (
            <Question size={13} color="var(--mantine-color-orange-4)" aria-label={t("ui.debug.cap-marker-unknown")} />
          ) : (
            <MinusCircle size={13} color="var(--mantine-color-dark-3)" aria-label={t("ui.debug.cap-marker-off")} />
          ))}
      </Box>
    </Group>
  );

  if (!hasCard) return row;

  return (
    <CursorCard
      testId={`cap-line-card-${line.key}`}
      style={DEBUG_CARD_STYLE}
      content={
        <Stack gap={2}>
          {/* The full name first — the inline row may have truncated it. */}
          <Text size="xs" fw={600}>
            {name}
          </Text>
          {/* The "says who?" line: the field / table / expression the number
              came from. */}
          {source !== null && (
            <Text size="xs" c="dimmed" style={sourceIsCode ? MONO : undefined}>
              {source}
            </Text>
          )}
          {excluded !== undefined && (
            <Text size="xs" c={unknown ? "orange.4" : "dimmed"} fs="italic">
              {t("ui.debug.cap-tt-not-counted", { reason: t(EXCLUSION_KEY[excluded]) })}
            </Text>
          )}
        </Stack>
      }
    >
      {row}
    </CursorCard>
  );
};

const SectionBlock = ({ section }: { section: ExplainSection }) => {
  const { t } = useTranslation();

  return (
    <Box data-cap-section={section.key}>
      <Group gap={6} mb={4} wrap="nowrap">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed">
          {t(section.titleKey)}
        </Text>
        {/* Formula on hover: the symbolic shape, then the same expression with
            this hit's numbers substituted into it. */}
        {section.formula !== null && (
          <HeaderIcon
            testId={`cap-formula-card-${section.key}`}
            label={t("ui.debug.cap-formula")}
            wide
            content={
              // pre-wrap as the fallback for an expression longer than even the
              // wide card: a wrapped line is worse than a scrolled one, but the
              // card is pointer-inert, so scrolling is not on offer.
              <Code block fz="xs" style={{ whiteSpace: "pre-wrap", background: "transparent", padding: 0 }}>
                {section.formula}
                {section.substituted !== null && `\n= ${section.substituted}`}
              </Code>
            }
          >
            <FunctionIcon size={13} color="var(--mantine-color-dark-2)" />
          </HeaderIcon>
        )}
        {/* A standing caveat about the section's meaning, not about this hit. */}
        {section.noteKey !== undefined && (
          <HeaderIcon
            testId={`cap-note-card-${section.key}`}
            label={t("ui.debug.cap-note")}
            content={
              <Text size="xs" c="dimmed">
                {t(section.noteKey)}
              </Text>
            }
          >
            <Info size={13} color="var(--mantine-color-dark-2)" />
          </HeaderIcon>
        )}
      </Group>

      {/* Inline, not hover: "why is this section empty" is the one answer that
          cannot hide behind an affordance the reader has no cue to reach for. */}
      {section.unavailableKey !== null && (
        <Text size="xs" c="orange.4" mb={4} style={{ maxWidth: MIN_ROW_WIDTH }}>
          {t(section.unavailableKey)}
        </Text>
      )}

      <Stack gap={2}>
        {section.lines.map((line) => (
          <LineRow key={line.key} line={line} />
        ))}
      </Stack>
    </Box>
  );
};

/** The full derivation for one hit, section by section, in the order the game
 * computes it. Rows are name + value + status; provenance, exclusion reasons,
 * formulas and caveats all live in hover cards. */
export const CapDetailPanel = ({ sections }: { sections: ExplainSection[] }) => (
  <Stack gap="md" data-cap-panel>
    {sections.map((section) => (
      <SectionBlock key={section.key} section={section} />
    ))}
  </Stack>
);
