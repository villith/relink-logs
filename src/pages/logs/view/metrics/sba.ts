import type { ComputedPlayerState, SbaSourceState } from "@/types";
import { share } from "@/utils";

import { groupSkillsForRows, mergeSkillsByAction } from "../abilitySkills";
import { SBA_UNATTRIBUTED_KEY, playerRowKey, sbaCausePayload, sbaCauseRowKey, skillKey } from "../rowKey";
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

/** The row key the unattributed remainder carries, shared with the backend's
 * band of the same name so the two are one identity. */
// Re-exported from the grammar's own module: `rowRefOf` has to know it too,
// and a second spelling is how the two would come to disagree.
export { SBA_UNATTRIBUTED_KEY };

/** How to name a `source:` row key, or null when the key is not one.
 *
 * Exported because the drilled SBA CHART draws a band per cause and must name it
 * exactly as the table names the row beneath it — the backend emits these keys
 * in this same grammar (see `ability_charts.rs`), and re-deriving the naming at
 * the chart would let a band and its row drift apart. */
export const sbaCauseLabel = (
  rowKey: string
): { labelKey: string; labelParams?: Record<string, string | number> } | null => {
  if (rowKey === SBA_UNATTRIBUTED_KEY) return { labelKey: "ui.logs.sba-unattributed" };
  const payload = sbaCausePayload(rowKey);
  if (payload === null) return null;

  const [kind, rawId] = payload.split(":");
  const id = rawId === undefined ? null : Number(rawId);

  // `Effect(0)` is not an effect record: it is the residual bucket the hook
  // parks when the game's generic add-gauge% API fires and no more specific
  // grant site claimed the rise (see `OnGaugePercentGrantHook`). Through the
  // effect template it rendered "Effect 0x0", which reads as a real record
  // keyed zero rather than as "we could not tell". Distinct from
  // `sba-cause-unknown`, which is a rise with nothing parked at all.
  if (kind === "effect" && id === 0) return { labelKey: "ui.logs.sba-cause-generic-grant" };

  const known = kind === "effect" && id !== null && KNOWN_EFFECT_KEYS[id];

  return {
    labelKey: known
      ? KNOWN_EFFECT_KEYS[id as number]
      : CAUSE_LABEL_KEYS[kind as SbaSourceState["kind"]] ?? CAUSE_LABEL_KEYS.unknown,
    // Keys are hashes; hex is how every other tool in this repo prints them.
    // Site tags are small ordinals and stay decimal.
    labelParams:
      id === null || known ? undefined : { id: kind === "effect" ? `0x${id.toString(16).toUpperCase()}` : id },
  };
};

/** Rows for the causes no skill row can hold. Keyed by cause (plus id where one
 * discriminates), so they never collide with `skill:` keys. */
const sourceRows = (owner: ComputedPlayerState, total: number): MetricRow[] =>
  (owner.sbaSources ?? [])
    .filter((source) => source.generated !== 0)
    .map((source) => {
      const key = sbaCauseRowKey(source.kind, source.id);
      // Named through the shared namer rather than inline, so the row and the
      // chart band above it cannot be labelled differently. Never null here:
      // the key was just built in the `source:` grammar it parses.
      const named = sbaCauseLabel(key);
      return {
        key,
        label: source.kind,
        labelKey: named?.labelKey ?? CAUSE_LABEL_KEYS.unknown,
        labelParams: named?.labelParams,
        value: source.generated,
        columns: [whole(source.generated), share(source.generated, total)],
        // A cause carries no target and no member skills to descend into.
        pinOnClick: null,
        // Not the player's own doing, so not their colour (see the remainder row).
        colorSlot: -1,
      };
    });

/** SBA is a per-player gauge, ranked by what each player GENERATED. Descending
 * into a player splits their generation by ability, from the attributed
 * per-hit gains the hook files against the causing skill's row.
 *
 * Only the local player has a split: a remote member's gauge is synced rather
 * than granted by a hit the hook can see, so their breakdown is empty and their
 * player row still carries the poll-derived total. */
export const sba: MetricDescriptor = {
  labelKey: "ui.logs.metric-sba",

  // What the player rows' hover card measures. `valueOf` and `perTarget` are
  // stated for completeness but go unread: the SBA card has its own builder
  // (`sbaCardSectionsFor`), because a player's generated total also holds the
  // non-hit causes and the unattributed remainder, neither of which is in
  // `skillBreakdown` for a skill walk to reach. A gain carries no target.
  card: {
    amountKey: "ui.meter-columns.sba-generated",
    valueOf: (skill) => skill.sbaGenerated ?? 0,
    format: whole,
    perTarget: false,
  },

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
          key: playerRowKey(player.index),
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

    // Condensed into skill-group rows until a group is PINNED, at which point
    // the rows become that group's members — the same descent `stun` makes, and
    // for the same reason: `levelFor` only yields "skills" for the target
    // dimension, which neither of these tabs has.
    const pinnedAbility = pins.ability !== null;
    const fold = pinnedAbility ? mergeSkillsByAction : groupSkillsForRows;

    const attributed = fold(owner.skillBreakdown)
      .map(({ key, skills }) => {
        const generated = skills.reduce((sum, skill) => sum + (skill.sbaGenerated ?? 0), 0);
        return { key, generated };
      })
      // A player with no attribution at all carries no attribution — filtered
      // here rather than shown as a wall of honest zeros.
      .filter(({ generated }) => generated !== 0)
      .map(({ key, generated }) => ({
        key: skillKey(key),
        label: key,
        value: generated,
        columns: [whole(generated), share(generated, total)],
        // Pinnable into the group's members, like `stun`. A gain carries no
        // target, so once the rows ARE those members there is nothing further
        // to descend into.
        pinOnClick: pinnedAbility ? null : { ability: key },
        colorSlot: owner.partyIndex,
      }));

    // A pinned ability narrows to ONE group's members. The cause rows and the
    // remainder describe the whole PLAYER — the remainder is measured against
    // their polled total — so listing them beside one ability's members would
    // make the column's share denominator mean two different things. The chart
    // drops them for the same reason (see `build_ability_sba_chart`).
    if (pinnedAbility) return [...attributed].sort((a, b) => b.value - a.value);

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
      key: SBA_UNATTRIBUTED_KEY,
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
