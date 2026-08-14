import { Badge, Box, Group, Text } from "@mantine/core";
import { ArrowRight } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import type { ExplainHit } from "@/pages/logs/view/events/capExplain";

import { DEBUG_CARD_STYLE } from "./CapDetailPanel";

const MONO_NUMERIC = {
  fontFamily: "var(--mantine-font-family-monospace)",
  fontVariantNumeric: "tabular-nums",
} as const;

/** One stage of the pipeline: a label over its number, provenance on hover. */
const StatCell = ({
  labelKey,
  value,
  sourceKey,
  testId,
}: {
  labelKey: string;
  value: string;
  sourceKey: string;
  testId: string;
}) => {
  const { t } = useTranslation();
  return (
    <CursorCard
      testId={`${testId}-card`}
      style={DEBUG_CARD_STYLE}
      content={
        <Text size="xs" c="dimmed">
          {t(sourceKey)}
        </Text>
      }
    >
      <Box data-testid={testId} style={{ cursor: "help" }}>
        <Text fz={10} tt="uppercase" fw={600} c="dimmed" lh={1.3}>
          {t(labelKey)}
        </Text>
        <Text size="sm" fw={600} lh={1.3} style={{ ...MONO_NUMERIC, whiteSpace: "nowrap" }}>
          {value}
        </Text>
      </Box>
    </CursorCard>
  );
};

const pct = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;

/**
 * The hit's clamp story at a glance, before either derivation column: what the
 * game rolled (pre-cap), the ceiling it computed (cap), the multiplier applied
 * after the clamp, and what landed (final) — with a bar showing how far the
 * pre-cap roll sat against the cap. Everything here restates fields the columns
 * below derive in full; this strip only answers "what happened to this hit"
 * without reading either of them.
 */
export const HitPipeline = ({ hit }: { hit: ExplainHit }) => {
  const { t, i18n } = useTranslation();
  const precap = hit.base_damage;
  const cap = hit.damage_cap;
  // The clamp bound, not the cap: an UNCAPPED hit was never clamped to the cap,
  // so dividing by the cap would understate its multiplier. Matches
  // `postCapSection` in capExplain.ts.
  const bound = precap === null ? null : cap === null ? precap : Math.min(precap, cap);
  const multiplier = bound !== null && bound > 0 ? hit.damage / bound : null;
  const capped = precap !== null && cap !== null ? precap >= cap : null;

  const dash = "—";
  const format = (value: number | null) => (value === null ? dash : value.toLocaleString(i18n.language));

  // Both segments of the bar share one scale so the cap line and the fill are
  // comparable lengths: whichever of the two numbers is larger spans the track.
  const scale = precap !== null && cap !== null ? Math.max(precap, cap) : null;

  return (
    <Box
      data-testid="cap-pipeline"
      p="sm"
      mb="sm"
      style={{
        border: "1px solid var(--color-line)",
        borderRadius: 6,
        background: "var(--mantine-color-dark-7)",
        // The strip keeps its natural height inside the detail flex column; a
        // short window shortens the derivation scrollers below, never this.
        flexShrink: 0,
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <StatCell
          labelKey="ui.debug.cap-pipe-precap"
          value={format(precap)}
          sourceKey="ui.debug.cap-pipe-src-precap"
          testId="cap-pipe-precap"
        />
        <ArrowRight size={14} color="var(--mantine-color-dark-3)" style={{ flexShrink: 0 }} />
        <StatCell
          labelKey="ui.debug.cap-pipe-cap"
          value={format(cap)}
          sourceKey="ui.debug.cap-pipe-src-cap"
          testId="cap-pipe-cap"
        />
        <ArrowRight size={14} color="var(--mantine-color-dark-3)" style={{ flexShrink: 0 }} />
        <StatCell
          labelKey="ui.debug.cap-pipe-postcap"
          value={multiplier === null ? dash : `x${multiplier.toFixed(3)}`}
          sourceKey="ui.debug.cap-pipe-src-postcap"
          testId="cap-pipe-postcap"
        />
        <ArrowRight size={14} color="var(--mantine-color-dark-3)" style={{ flexShrink: 0 }} />
        <StatCell
          labelKey="ui.debug.cap-pipe-final"
          value={format(hit.damage)}
          sourceKey="ui.debug.cap-pipe-src-final"
          testId="cap-pipe-final"
        />
        {/* The one-word verdict. `capped === null` means the log never carried
            the fields to say — a different fact from "uncapped". */}
        <Badge
          ml="auto"
          size="sm"
          variant={capped === true ? "filled" : "outline"}
          color={capped === null ? "orange" : capped ? "yellow" : "gray"}
          data-testid="cap-pipe-verdict"
          style={{ flexShrink: 0 }}
        >
          {capped === null
            ? t("ui.debug.cap-pipe-unknown")
            : capped
              ? t("ui.debug.cap-pipe-capped")
              : t("ui.debug.cap-pipe-uncapped")}
        </Badge>
      </Group>

      {precap !== null && cap !== null && cap > 0 && scale !== null && (
        <CursorCard
          testId="cap-pipe-bar-card"
          style={DEBUG_CARD_STYLE}
          content={
            <Text size="xs" c="dimmed">
              {t("ui.debug.cap-pipe-src-bar")}
            </Text>
          }
        >
          <Group gap="xs" wrap="nowrap" align="center" mt={8} style={{ cursor: "help" }}>
            <Box
              data-testid="cap-pipe-bar"
              style={{
                position: "relative",
                flex: 1,
                height: 10,
                borderRadius: 5,
                background: "var(--mantine-color-dark-5)",
                overflow: "hidden",
              }}
            >
              {/* What survived the clamp. */}
              <Box
                data-testid="cap-pipe-fill"
                style={{
                  position: "absolute",
                  insetBlock: 0,
                  left: 0,
                  width: pct(Math.min(precap, cap) / scale),
                  background: "var(--mantine-color-blue-6)",
                }}
              />
              {/* What the clamp removed. */}
              {precap > cap && (
                <Box
                  data-testid="cap-pipe-overfill"
                  style={{
                    position: "absolute",
                    insetBlock: 0,
                    left: pct(cap / scale),
                    width: pct((precap - cap) / scale),
                    background: "var(--mantine-color-orange-6)",
                  }}
                />
              )}
              {/* The cap itself. */}
              <Box
                data-testid="cap-pipe-capline"
                style={{
                  position: "absolute",
                  insetBlock: 0,
                  left: `calc(${pct(cap / scale)} - 1px)`,
                  width: 2,
                  background: "var(--mantine-color-yellow-4)",
                }}
              />
            </Box>
            <Text
              size="xs"
              c={capped === true ? "orange.4" : "dimmed"}
              style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
              data-testid="cap-pipe-bar-label"
            >
              {capped === true
                ? t("ui.debug.cap-pipe-overcap", { ratio: (precap / cap).toFixed(2) })
                : t("ui.debug.cap-pipe-headroom", { percent: Math.round((precap / cap) * 100) })}
            </Text>
          </Group>
        </CursorCard>
      )}
    </Box>
  );
};
