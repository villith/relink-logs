import { List, Text, Tooltip } from "@mantine/core";
import { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { describeFinding, severityColor, subjectNameFor, worstSeverity } from "@/legality";
import { LegalityFinding, PlayerData } from "@/types";

/**
 * Colours whatever it wraps by the worst finding against it, and explains why
 * on hover.
 *
 * One component for every flagged thing — a player's name, a summon, a sigil,
 * a wrightstone — so the colour and the sentence can never disagree about what
 * is being claimed. With no findings it renders its children untouched and adds
 * no tooltip, so a clean build looks exactly as it did before.
 */
export const LegalityMark = ({
  findings,
  subjectName,
  title,
  children,
}: {
  findings: LegalityFinding[];
  /** Translated name of the thing being judged, interpolated into the
   * explanation ("Behemoth III can grant at most…"). A function when one
   * tooltip covers several items and each must name itself. */
  subjectName: string | ((finding: LegalityFinding) => string);
  /** Optional heading above the explanations, used on a player's name where
   * the tooltip covers their whole build rather than one item. */
  title?: string;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const severity = worstSeverity(findings);

  if (!severity) return <>{children}</>;

  return (
    <Tooltip
      multiline
      w={340}
      withArrow
      color="dark"
      label={
        <>
          {title && (
            <Text size="xs" fw={700} mb={4}>
              {title}
            </Text>
          )}
          <List size="xs" spacing={2}>
            {findings.map((finding, index) => (
              <List.Item key={index}>
                {describeFinding(t, finding, typeof subjectName === "function" ? subjectName(finding) : subjectName)}
              </List.Item>
            ))}
          </List>
        </>
      }
    >
      {/* `span` keeps the wrapped node's own layout: these wrap table cells,
          headings and inline text alike, so the mark must not introduce a box. */}
      <Text span c={severityColor(severity)} inherit style={{ cursor: "help" }}>
        {children}
      </Text>
    </Tooltip>
  );
};

/** A player's name, coloured and explained by their whole build's findings.
 *
 * Unlike the meter this is never gated on a setting: these tabs are opened
 * deliberately, one log at a time, and are not on screen over the game. */
export const LegalityPlayerName = ({
  findings,
  player,
  children,
}: {
  findings: LegalityFinding[];
  /** The build being judged — each line names the item it is about. */
  player: PlayerData;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const severity = worstSeverity(findings);

  return (
    <LegalityMark
      findings={findings}
      subjectName={(finding) => subjectNameFor(player, finding)}
      title={severity ? t(`ui.legality.player-flagged-${severity}`) : undefined}
    >
      {children}
    </LegalityMark>
  );
};
