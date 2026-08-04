import { share } from "@/utils";

import { groupSkillsForRows } from "../abilitySkills";
import type { MetricDescriptor, MetricRow } from "./types";

/** Shown where the backend served no generated total — a log served by a
 * binary older than the field. A zero would claim the player built no gauge. */
const NOT_RECORDED = "—";

/** Gauge units are tenths of a percent; sub-unit precision is noise at the
 * magnitudes a fight produces, and a suffix would only lose precision. */
const whole = (value: number): string => String(Math.round(value));

/** SBA is a per-player gauge, ranked by what each player GENERATED. Descending
 * into a player splits their generation by ability, from the attributed
 * per-hit gains the hook files against the causing skill's row.
 *
 * Only the local player has a split: a remote member's gauge is synced rather
 * than granted by a hit the hook can see, so their breakdown is empty and their
 * player row still carries the poll-derived total. */
export const sba: MetricDescriptor = {
  labelKey: "ui.logs.metric-sba",

  columnKeys: (level) =>
    level === "players"
      ? ["ui.meter-columns.sba-generated", "ui.meter-columns.sba"]
      : ["ui.meter-columns.sba-generated", "ui.logs.column-share"],

  labelKind: (level) => (level === "players" ? "player" : "ability"),

  rows: ({ players, level, pins }): MetricRow[] => {
    if (level === "players") {
      return [...players]
        .map((player) => ({ player, generated: player.sbaGenerated }))
        .sort((a, b) => (b.generated ?? b.player.sba) - (a.generated ?? a.player.sba))
        .map(({ player, generated }) => ({
          key: `player:${player.index}`,
          label: String(player.index),
          // The bar ranks by contribution where it is known, and by the level
          // where it is not — the honest fallback for an older payload.
          value: generated ?? player.sba,
          columns: [generated === undefined ? NOT_RECORDED : whole(generated), whole(player.sba)],
          pinOnClick: { source: player.index },
          colorSlot: player.partyIndex,
        }));
    }

    // A gauge belongs to one player, never the party — unlike damage there is
    // no "everyone's total" reading to fall back to, so no pinned source (or
    // one absent from the scoped party) means there is nothing to show.
    const owner = pins.source === null ? null : players.find((p) => p.index === pins.source);
    if (!owner) return [];

    const total = owner.sbaGenerated ?? 0;

    return (
      groupSkillsForRows(owner.skillBreakdown)
        .map(({ key, skills }) => {
          const generated = skills.reduce((sum, skill) => sum + (skill.sbaGenerated ?? 0), 0);
          return { key, generated };
        })
        // A remote player's skills carry no attribution at all — filtered here
        // rather than shown as a wall of honest zeros.
        .filter(({ generated }) => generated !== 0)
        .map(({ key, generated }) => ({
          key: `skill:${key}`,
          label: key,
          value: generated,
          columns: [whole(generated), share(generated, total)],
          // A gain carries no target, so there is no further dimension to
          // descend into.
          pinOnClick: null,
          colorSlot: owner.partyIndex,
        }))
        .sort((a, b) => b.value - a.value)
    );
  },
};
