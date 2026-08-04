import type { ComputedPlayerState, SbaSourceState } from "@/types";
import { share } from "@/utils";

import { groupSkillsForRows } from "../abilitySkills";
import type { MetricDescriptor, MetricRow } from "./types";

/** Shown where the backend served no generated total — a log served by a
 * binary older than the field. A zero would claim the player built no gauge. */
const NOT_RECORDED = "—";

/** Gauge units are tenths of a percent; sub-unit precision is noise at the
 * magnitudes a fight produces, and a suffix would only lose precision. */
const whole = (value: number): string => String(Math.round(value));

/** Cause → i18n key. Exhaustive by construction: a kind with no entry here is a
 * backend that shipped a cause the UI has not been taught, which reads as
 * "Unidentified" rather than as a missing row. */
const CAUSE_LABEL_KEYS: Record<SbaSourceState["kind"], string> = {
  damageTaken: "ui.logs.sba-cause-damage-taken",
  perfectGuard: "ui.logs.sba-cause-perfect-guard",
  effect: "ui.logs.sba-cause-effect",
  partyAward: "ui.logs.sba-cause-party-award",
  directorAward: "ui.logs.sba-cause-director-award",
  questStart: "ui.logs.sba-cause-quest-start",
  perfectDodge: "ui.logs.sba-cause-perfect-dodge",
  site: "ui.logs.sba-cause-site",
  unknown: "ui.logs.sba-cause-unknown",
};

/** Effect-record keys we have SEEN live and identified. Everything else renders
 * as "Effect 0x<key>" — an honest hash beats a guessed name. Add entries only
 * from a live capture where the key co-occurred with a known sigil/effect. */
const KNOWN_EFFECT_KEYS: Record<number, string> = {
  0xdeadbeef: "ui.logs.sba-effect-test-entry", // wiring test only; never occurs in game
  // The just-dodge handler's gauge record (v2.0.3 FUN_1426f9640, live log
  // 1694). Newer hooks park the PerfectDodge cause directly; this entry names
  // the logs stored in between.
  0xd2c8e10a: "ui.logs.sba-cause-perfect-dodge",
};

/** Rows for the causes no skill row can hold. Keyed by cause (plus id where one
 * discriminates), so they never collide with `skill:` keys. */
const sourceRows = (owner: ComputedPlayerState, total: number): MetricRow[] =>
  (owner.sbaSources ?? [])
    .filter((source) => source.generated !== 0)
    .map((source) => ({
      key: source.id === null ? `source:${source.kind}` : `source:${source.kind}:${source.id}`,
      label: source.kind,
      labelKey:
        source.kind === "effect" && source.id !== null && KNOWN_EFFECT_KEYS[source.id]
          ? KNOWN_EFFECT_KEYS[source.id]
          : CAUSE_LABEL_KEYS[source.kind] ?? CAUSE_LABEL_KEYS.unknown,
      // Keys are hashes; hex is how every other tool in this repo prints them.
      // Site tags are small ordinals and stay decimal.
      labelParams:
        source.id === null || (source.kind === "effect" && KNOWN_EFFECT_KEYS[source.id])
          ? undefined
          : { id: source.kind === "effect" ? `0x${source.id.toString(16).toUpperCase()}` : source.id },
      value: source.generated,
      columns: [whole(source.generated), share(source.generated, total)],
      // A cause carries no target and no member skills to descend into.
      pinOnClick: null,
      // Not the player's own doing, so not their colour (see the remainder row).
      colorSlot: -1,
    }));

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

    const attributed = groupSkillsForRows(owner.skillBreakdown)
      .map(({ key, skills }) => {
        const generated = skills.reduce((sum, skill) => sum + (skill.sbaGenerated ?? 0), 0);
        return { key, generated };
      })
      // A player with no attribution at all carries no attribution — filtered
      // here rather than shown as a wall of honest zeros.
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
      }));

    const sources = sourceRows(owner, total);

    return [...attributed, ...sources, ...unattributedRow([...attributed, ...sources], total, owner.sbaGenerated)].sort(
      (a, b) => b.value - a.value
    );
  },
};

/** Gauge the split does not explain, as its own row — or nothing, where there
 * is no honest figure to draw.
 *
 * The remainder is what neither a skill NOR a named cause explains: an
 * ability row covers gauge granted by the player's own damaging hits, a
 * source row covers the named non-hit causes (party awards, damage taken,
 * quest start…), and this row is whatever the hook could not caption at all.
 * Live log 1681 (captured before causes existed) puts it at 31-42% of each
 * player's generated total; every named cause since shrinks it.
 *
 * Not drawn when: nothing is attributed (there is no split for it to be the
 * remainder of, and the table's empty state explains that case), the log
 * predates the generated total (no denominator — the "gap" would be the
 * negative of what is attributed), or the gap is under a whole gauge unit
 * (the column rounds, so the row would read 0). */
const unattributedRow = (attributed: MetricRow[], total: number, generated: number | undefined): MetricRow[] => {
  if (attributed.length === 0 || generated === undefined) return [];

  const gap = total - attributed.reduce((sum, row) => sum + row.value, 0);
  if (gap < 0.5) return [];

  return [
    {
      key: "skill:unattributed",
      // No ability to name, so the table names it (see `MetricRow.labelKey`).
      label: "unattributed",
      labelKey: "ui.logs.sba-unattributed",
      value: gap,
      columns: [whole(gap), share(gap, total)],
      pinOnClick: null,
      // No party slot: this is the one row that is not the player's doing, and
      // it reads as the neutral remainder rather than more of their colour.
      colorSlot: -1,
    },
  ];
};
