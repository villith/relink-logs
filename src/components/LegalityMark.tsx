import { Stack, Text, Tooltip } from "@mantine/core";
import { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LegalityFinding } from "@/types";

import { FindingDetail } from "./FindingDetail";

/**
 * What a set of findings SAYS — the Cheat Audit page's own block, one per
 * finding.
 *
 * This used to be a tooltip-only list: rule label, subject, limit, odds. It
 * shared nothing with the audit page but the limit phrase, so the same
 * accusation arrived in two different shapes — the audit page showing the gear
 * with its offending line marked, the tooltip showing a heading and a sentence
 * with no gear at all. A reader comparing them could not tell they were the
 * same claim.
 *
 * Every finding carries the gear it was computed from, so the audit page's
 * block needs nothing a tooltip does not already have. Rendering it here is
 * what makes the two identical rather than merely similar.
 */
export const FindingsExplanation = ({ findings, title }: { findings: LegalityFinding[]; title?: string }) => (
  <Stack gap={6}>
    {title && (
      <Text size="xs" fw={700}>
        {title}
      </Text>
    )}
    {findings.map((finding, index) => (
      <FindingDetail key={index} finding={finding} />
    ))}
  </Stack>
);

/**
 * Colours whatever it wraps when anything was flagged against it, and explains
 * why on hover.
 *
 * One component for every flagged thing — a player's name, a summon, a sigil,
 * a wrightstone — so the colour and the sentence can never disagree about what
 * is being claimed. With no findings it renders its children untouched and adds
 * no tooltip, so a clean build looks exactly as it did before.
 *
 * There is one colour. Severity used to split this red/yellow, but "Impossible"
 * and "Improbable" are adjectives a reader has to decode; what actually
 * separates proof from luck is the claim itself, so the odds line below carries
 * it instead.
 */
export const LegalityMark = ({
  findings,
  title,
  children,
}: {
  findings: LegalityFinding[];
  /** Optional heading above the explanations, used on a player's name where
   * the tooltip covers their whole build rather than one item. */
  title?: string;
  children: ReactNode;
}) => {
  if (findings.length === 0) return <>{children}</>;

  return (
    <Tooltip multiline w={340} withArrow color="dark" label={<FindingsExplanation findings={findings} title={title} />}>
      {/* `span` keeps the wrapped node's own layout: these wrap table cells,
          headings and inline text alike, so the mark must not introduce a box. */}
      <Text span c="red" inherit style={{ cursor: "help" }}>
        {children}
      </Text>
    </Tooltip>
  );
};

/** A player's name, coloured and explained by their whole build's findings.
 *
 * Unlike the meter this is never gated on a setting: these tabs are opened
 * deliberately, one log at a time, and are not on screen over the game. */
export const LegalityPlayerName = ({ findings, children }: { findings: LegalityFinding[]; children: ReactNode }) => {
  const { t } = useTranslation();

  return (
    <LegalityMark findings={findings} title={findings.length > 0 ? t("ui.legality.player-flagged") : undefined}>
      {children}
    </LegalityMark>
  );
};
