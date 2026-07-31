import { Box, Group, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { describeLimit } from "@/legality";
import { markedLines } from "@/legalityLines";
import { LegalityFinding } from "@/types";

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

  // Red says WHICH line. The heading only takes it when no line did — otherwise
  // it repeats what the line below already says.
  const headingRed = findings.length > 0 && markedAnywhere.size === 0;

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
        <Text size="xs" fw={nameWeight} c={headingRed ? "red" : undefined} data-flagged={headingRed || undefined}>
          {name}
        </Text>
        {limits().map((limit, index) => (
          <Text size="xs" key={index}>
            {limit}
          </Text>
        ))}
      </Group>
      {lines.map((line, index) => (
        <Group key={index} gap={10} wrap="wrap" pl={9}>
          {/* eslint-disable-next-line i18next/no-literal-string -- already-translated trait line */}
          <Text
            size="xs"
            fw={300}
            c={markedAnywhere.has(index) ? "red" : undefined}
            data-flagged={markedAnywhere.has(index) || undefined}
          >
            {`- ${line.text}`}
          </Text>
          {limits(index).map((limit, limitIndex) => (
            <Text size="xs" key={limitIndex}>
              {limit}
            </Text>
          ))}
        </Group>
      ))}
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
