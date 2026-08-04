import { Box, Group, Text, Tooltip } from "@mantine/core";
import { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { describeLimit } from "@/legality";
import { markedLines } from "@/legalityLines";
import { LegalityFinding } from "@/types";
import { translateTraitId } from "@/utils";
import { TONE_COLOR, findingsTone } from "@/violations";

import { FindingsExplanation } from "./LegalityMark";

/**
 * One line beneath an item: a sigil's trait, a summon's equip bonus, an
 * overmastery.
 *
 * `id` and `level` are not for display — `text` is. They are what a finding's
 * claim is matched against, since most rules name the offending line by the id
 * they carry.
 */
export type GearLine = {
  id: number;
  level: number;
  /** The line as the reader sees it, already translated. */
  text: string;
};

/**
 * A trait line — the shape every surface draws a sigil, summon or wrightstone
 * trait in.
 *
 * Here rather than at each call site because the log view's Equipment and
 * Builds tabs and the audit page's detail pane all draw the same line, and a
 * reader comparing them has to see one wording. An unlevelled trait (level 0,
 * which is how a remote player's wrightstone syncs) drops the suffix rather
 * than printing "Lvl. 0".
 */
export const traitLine = (t: TFunction, id: number, level: number): GearLine => ({
  id,
  level,
  text: level > 0 ? `${translateTraitId(id)} ${t("ui.trait-level", { level })}` : translateTraitId(id),
});

/**
 * An item, its lines, and the mark saying which line is wrong.
 *
 * ONE renderer for both surfaces that draw flagged gear — the Toolbox audit
 * page and the log view's Equipment and Builds tabs. They used to disagree in a
 * way readers could see: the audit page reddened the offending LINE, while the
 * log view reddened the item's NAME, which said "something about this sigil is
 * wrong" and left the reader to find out what. Same marking here, from the same
 * `markedLines`, so the two can no longer drift.
 *
 * `explain` is the one thing they still differ on, and only for want of room:
 * the audit page has a wide detail pane and puts the limit phrase beside the
 * line it belongs to, while the log view stacks four players across a table and
 * has nowhere to put it, so it goes in the tooltip. The words are identical
 * either way — both come from `describeLimit`.
 */
export const FlaggedGear = ({
  name,
  lines,
  findings,
  explain,
  formatAllowed,
  nameWeight = 700,
  children,
}: {
  /** Heading text, already translated. */
  name: string;
  lines: GearLine[];
  /** The findings about THIS item, and no others — a finding marks lines by
   * index, so one about a different item marks the wrong row. */
  findings: LegalityFinding[];
  explain: "inline" | "tooltip";
  /** A pre-formatted allowed value for the units a rule does not carry: a
   * summon bonus stores a bare `50`, and "max +50" beside a line reading "+75%"
   * leaves the reader to finish the comparison. */
  formatAllowed?: (finding: LegalityFinding) => string | undefined;
  /** The heading's weight, so a nested item (a summon inside the summon list)
   * can sit below its section heading without competing with it. */
  nameWeight?: number;
  /** Rendered after the lines, for a caller with extra rows of its own. */
  children?: React.ReactNode;
}) => {
  const { t } = useTranslation();

  const marks = findings.map((finding) => ({ finding, ...markedLines(finding, lines) }));
  const markedAnywhere = new Set(marks.flatMap((mark) => mark.lines));

  // The colour says WHICH line, and its tone says what kind of claim marked it:
  // red for a cheat, gold for pure luck — with a cheat winning when both mark
  // the same line, since luck does not soften proof.
  const lineTone = (index: number) =>
    findingsTone(marks.filter((mark) => mark.lines.includes(index)).map((mark) => mark.finding));

  // The heading only takes the mark when no line did — otherwise it repeats
  // what the line below already says.
  const headingTone = markedAnywhere.size === 0 ? findingsTone(findings) : undefined;

  /** The phrases for a line, or for the heading when `index` is omitted. Empty
   * unless this surface prints them beside the gear. */
  const limits = (index?: number): string[] => {
    if (explain !== "inline") return [];
    return marks
      .filter((mark) => (index === undefined ? mark.markHeading : !mark.markHeading && mark.lines.includes(index)))
      .map((mark) => describeLimit(t, mark.finding, mark.perLine ? index : undefined, formatAllowed?.(mark.finding)));
  };

  const body = (
    <Box>
      <Group gap={10} wrap="wrap">
        {/* `data-flagged` states in the DOM what the colour states visually.
            Mantine renders `c` through a stylesheet layer, so the mark is
            otherwise invisible to anything but a human eye — including the
            tests that keep the two surfaces marking the same thing. */}
        {/* eslint-disable-next-line i18next/no-literal-string -- already-translated item name */}
        <Text
          size="xs"
          fw={nameWeight}
          c={headingTone && TONE_COLOR[headingTone]}
          data-flagged={headingTone !== undefined || undefined}
        >
          {name}
        </Text>
        {limits().map((limit, index) => (
          <Text size="xs" key={index}>
            {limit}
          </Text>
        ))}
      </Group>
      {lines.map((line, index) => {
        const tone = lineTone(index);
        return (
          <Group key={index} gap={10} wrap="wrap" pl={9}>
            {/* eslint-disable-next-line i18next/no-literal-string -- already-translated trait line */}
            <Text size="xs" fw={300} c={tone && TONE_COLOR[tone]} data-flagged={tone !== undefined || undefined}>
              {`- ${line.text}`}
            </Text>
            {limits(index).map((limit, limitIndex) => (
              <Text size="xs" key={limitIndex}>
                {limit}
              </Text>
            ))}
          </Group>
        );
      })}
      {children}
    </Box>
  );

  if (explain !== "tooltip" || findings.length === 0) return body;

  return (
    <Tooltip multiline w={340} withArrow color="dark" label={<FindingsExplanation findings={findings} />}>
      {/* The whole item, not just its heading: the reader's eye lands on the
          reddened line, so that is where they will reach for the reason. */}
      <Box style={{ cursor: "help" }}>{body}</Box>
    </Tooltip>
  );
};
