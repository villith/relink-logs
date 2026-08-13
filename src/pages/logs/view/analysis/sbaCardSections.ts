import type { ComputedPlayerState } from "@/types";

import { groupSkillsForRows, type RowKeying } from "../abilitySkills";
import { rowGauge, sbaAttributionIsInferredOnly, sbaCauseLabel } from "../metrics/sba";
import { playerRowKey, SBA_UNATTRIBUTED_KEY, sbaCauseRowKey } from "../rowKey";

import type { CardLabels } from "./cardLabels";
import type { BreakdownEntry, CardSection } from "./HoverCard";

/** The lookups this card names its rows with — its `Pick` of the one shared
 * declaration (see `cardLabels.ts`), so a skill or a cause cannot be named one
 * way here and another way in the table beneath. */
export type SbaCardLabels = Pick<CardLabels, "ability" | "abilityIcon" | "cause">;

/** The colour the non-hit rows wear. Not the player's: the table draws cause
 * rows and the remainder at `colorSlot: -1` for the reason that they are not
 * the player's own doing, and a card that painted them in their colour would
 * contradict the rows it explains. */
const CAUSE_COLOR = "var(--color-ink-3)";

/** One SBA player row's hover card: what generated that player's gauge.
 *
 * Its own builder rather than the generic skill walk (`cardSectionsFor`),
 * because a player's generated total is NOT a sum over their skills. Three
 * things feed it — gauge attributed to their own damaging hits
 * (`SkillState.sbaGenerated`), the named non-hit causes (`sbaSources`: party
 * awards, damage taken, quest start…) and whatever the hook could not caption
 * at all — and only the first is in `skillBreakdown`. The generic builder would
 * produce a card summing to a fraction of the row above it, with the shares of
 * a denominator that never appears.
 *
 * Folded through the SAME helpers the drilled table uses — `groupSkillsForRows`
 * for the abilities, `sbaCauseLabel` for the cause names, and the same
 * "remainder = total − everything attributed" arithmetic — so this card and the
 * table you reach by clicking the row it explains cannot disagree.
 *
 * Null for a row that is not a player's (a cause row, an ability row, a stale
 * key): those are already the finest grain the capture has, and a card
 * restating one line of itself says nothing. Null too for a player whose gauge
 * was never attributed — a remote member's is synced rather than granted by a
 * hit the hook can see, and their honest empty state is the table's
 * (`ui.logs.sba-no-breakdown`), not a card with one 100% row in it. A remote
 * member whose split the parser DEDUCED gets the same null: the inference is
 * suppressed until verified live (see `sbaAttributionIsInferredOnly`), and the
 * card must vanish with the table rows it mirrors. */
export const sbaCardSectionsFor = ({
  row,
  players,
  color,
  labels,
  keying,
}: {
  row: { key: string };
  players: ComputedPlayerState[];
  /** The row's own colour, so the by-ability section matches its bar. */
  color: string;
  labels: SbaCardLabels;
  /** The view's row keying, so the card folds exactly as the table does. */
  keying?: RowKeying;
}): CardSection[] | null => {
  const player = players.find((candidate) => playerRowKey(candidate.index) === row.key);
  if (!player) return null;

  if (sbaAttributionIsInferredOnly(player)) return null;

  // Undefined means the log predates the field — there is no denominator, and
  // the "gap" below would be the negative of what is attributed. The table
  // draws no remainder row in that case either.
  const total = player.sbaGenerated;
  if (total === undefined) return null;

  const abilities: BreakdownEntry[] = groupSkillsForRows(player.skillBreakdown, keying)
    .map(({ key, skills }) => ({
      key,
      label: labels.ability(key, player),
      // `rowGauge`, not the measured figure alone: the drilled table values a
      // row as measured + inferred, and the card must agree with it.
      value: skills.reduce((sum, skill) => sum + rowGauge(skill), 0),
      icon: labels.abilityIcon?.(key, player),
    }))
    // A wall of honest zeros is what the table filters out, so the card does too.
    .filter((entry) => entry.value !== 0)
    .sort((a, b) => b.value - a.value);

  const causes: BreakdownEntry[] = (player.sbaSources ?? [])
    .filter((source) => source.generated !== 0)
    .map((source) => {
      const key = sbaCauseRowKey(source.kind, source.id);
      // Never null: the key was just built in the `source:` grammar it parses.
      const named = sbaCauseLabel(key);
      return {
        key,
        label: labels.cause(named?.labelKey ?? "ui.logs.sba-cause-unknown", named?.labelParams),
        value: source.generated,
        color: CAUSE_COLOR,
      };
    })
    .sort((a, b) => b.value - a.value);

  if (abilities.length === 0 && causes.length === 0) return null;

  // The same gap the table's remainder row reports, against the same total and
  // with the same sub-unit floor — the column rounds, so a smaller gap would
  // draw a row reading 0.
  const gap = total - [...abilities, ...causes].reduce((sum, entry) => sum + entry.value, 0);
  const remainder: BreakdownEntry[] =
    gap < 0.5 ? [] : [{ key: SBA_UNATTRIBUTED_KEY, label: labels.cause("ui.logs.sba-unattributed"), value: gap }];

  // Abilities and causes stay SEPARATE sections rather than one ranked list:
  // they answer different questions ("which of my hits built this" versus "what
  // else did"), and merged, a party award would rank between two skills as
  // though the player had cast it.
  return [
    ...(abilities.length === 0 ? [] : [{ headingKey: "ui.logs.hover-by-ability", color, entries: abilities }]),
    ...(causes.length === 0 && remainder.length === 0
      ? []
      : [{ headingKey: "ui.logs.hover-by-sba-cause", color: CAUSE_COLOR, entries: [...causes, ...remainder] }]),
  ];
};
