import type React from "react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { enemyIconUrl } from "@/enemyIcon";
import { statusIconUrl } from "@/statusIcon";
import type {
  ComputedPlayerState,
  EncounterState,
  EnemyType,
  GroupAggregate,
  PlayerData,
  StatusInterval,
  TargetEntry,
} from "@/types";
import { getSkillName, translateCharacterType, translateEnemyType } from "@/utils";

import { childOfPin, type RowKeying } from "../../abilitySkills";
import { keyColor } from "../../actorColor";
import { buffs } from "../../metrics/buffs";
import { damageDone, parseEnemyRow } from "../../metrics/damageDone";
import { damageTaken, takenAttackRowParts } from "../../metrics/damageTaken";
import { debuffs } from "../../metrics/debuffs";
import { sba } from "../../metrics/sba";
import { stun } from "../../metrics/stun";
import type { Hostility, LabelKind, MetricDescriptor, MetricRow, RowLevel } from "../../metrics/types";
import type { SelectorPins } from "../../selectorOptions";
import { isStatusPin } from "../../statusUptime";
import { abilityLabelFor, abilityOwnerFor } from "../abilityLabel";
import { CAUSE_CLASS_LABEL_KEY, withProvenance, type CauseClass } from "../causeClass";
import type { CardSection } from "../HoverCard";
import { qualifiedAbilityLabels } from "../labelCollision";
import type { MetricCapabilities } from "../machine/capabilities";
import { groupRowsFor } from "../machine/groupRows";
import type { ViewSpec } from "../machine/resolve";
import type { MetricKey } from "../machine/state";
import { rowCardSectionsFor } from "../rowCardSections";
import { abilityRowIconUrl } from "../rowIcon";
import { statusIdOfKey, statusRowKindFor, targetRowLabel, targetRowSegment } from "../statusLabel";
import { statusRowColors } from "../statusRowColors";

import type { ActorIdentity } from "./useActorIdentity";

/** The metric switcher's contents, in display order. Adding a metric that only
 * has a friendly side is adding a descriptor here — the frame itself does not
 * change. */
export const METRICS: Record<string, MetricDescriptor> = {
  damage: damageDone,
  taken: damageTaken,
  stun,
  sba,
  buffs,
  debuffs,
};

/** What a row's label and its icon are BOTH resolved against.
 *
 * One function rather than the same expression in `renderLabel` and
 * `rowIconUrl`: the two must never disagree, or a row pairs one kind's name
 * with another kind's art. The row's OWN kind wins where it declares one — the
 * groups path declares one per row — and the table-level discriminator stands
 * in otherwise. */
export const rowKindOf = (row: MetricRow, tableKind: LabelKind): LabelKind => row.kind ?? tableKind;

export type RowModel = {
  metric: MetricDescriptor;
  rows: MetricRow[];
  /** The rows as DRAWN — with provenance cells prepended at the effect level. */
  shownRows: MetricRow[];
  rowChildren: (row: MetricRow) => MetricRow[] | null;
  renderLabel: (row: MetricRow) => React.ReactNode;
  rowColor: (row: MetricRow) => string;
  rowSections: (row: MetricRow) => CardSection[] | null;
  sectionLabelOf: (row: MetricRow) => string;
  /** Whether this tab's rows are status effects. */
  isStatusMetric: boolean;
  /** Whether the rows are EFFECTS rather than one effect's holders — the
   * condition the provenance cells and the SOURCE header both ride. */
  effectLevel: boolean;
};

export type RowModelInput = {
  metricKey: MetricKey;
  caps: MetricCapabilities;
  spec: ViewSpec;
  level: RowLevel;
  hostility: Hostility;
  pins: SelectorPins;
  /** The SCOPED party — figures. */
  players: ComputedPlayerState[];
  /** The FULL party — identity. */
  identityPlayers: ComputedPlayerState[];
  targetEntries: TargetEntry[];
  playerData: Array<PlayerData | null>;
  groups: GroupAggregate[];
  maskedIntervals: StatusInterval[];
  statusWindow: { startMs: number; endMs: number };
  fightDurationMs: number;
  rowKeying: RowKeying;
  shownEncounter: EncounterState | null;
  sourcePin: number | null;
  identity: ActorIdentity;
  statusDisplayLabel: (key: string) => string;
  classOfRowKey: (rowKey: string) => CauseClass;
};

export const useRowModel = ({
  metricKey,
  caps,
  spec,
  level,
  hostility,
  pins,
  players,
  identityPlayers,
  targetEntries,
  playerData,
  groups,
  maskedIntervals,
  statusWindow,
  fightDurationMs,
  rowKeying,
  shownEncounter,
  sourcePin,
  identity,
  statusDisplayLabel,
  classOfRowKey,
}: RowModelInput): RowModel => {
  const { t, i18n } = useTranslation();
  const {
    playerByIndex,
    colorContext,
    labelForSource,
    labelForAbility,
    labelForTarget,
    labelForTakenAttack,
    takenAttackLabel,
    sourceIconUrl,
    targetIconUrl,
    playerColor,
  } = identity;
  const metric = METRICS[metricKey] ?? damageDone;

  // Party slot per player index, for the group fold's row colours.
  const partySlots = useMemo(
    () => new Map(identityPlayers.map((player) => [player.index, player.partyIndex])),
    [identityPlayers]
  );

  // Which machinery produces rows is the metric's declared data path: the
  // groups path folds the fetched aggregates; the derived and interval paths
  // keep their descriptors exactly as before the machine.
  const groupsPath = caps.dataPath === "groups";

  const rows = useMemo(() => {
    if (groupsPath) {
      return groupRowsFor(groups, {
        metric: metricKey as "damage" | "taken",
        groupBy: spec.groupBy,
        hostility,
        partySlots,
        source: sourcePin,
        fightDurationMs,
        // The damage tab's rows come from HERE, not from the descriptor, so
        // this is what makes the collapse toggle reach the table at all — and
        // what keeps the timeline's lane join (which expands a row's label
        // through the same keying) from listing an echo row it can never fill.
        keying: rowKeying,
      });
    }
    return shownEncounter
      ? metric.rows({
          encounter: shownEncounter,
          partyData: playerData,
          players,
          // The full party: `players` is the scoped one, and the status tables
          // use their roster to tell a buff from a debuff — a pinned source
          // would file the rest of the party's buffs as enemy-held.
          roster: identityPlayers,
          level,
          pins,
          statusIntervals: maskedIntervals,
          fightDurationMs,
          statusWindow,
          hostility,
          keying: rowKeying,
        })
      : [];
  }, [
    groupsPath,
    groups,
    metricKey,
    spec.groupBy,
    partySlots,
    sourcePin,
    metric,
    shownEncounter,
    playerData,
    players,
    identityPlayers,
    level,
    pins,
    maskedIntervals,
    fightDurationMs,
    statusWindow,
    hostility,
    rowKeying,
  ]);

  // Child rows behind one table row — the descriptor's split bound to the
  // current derived state. The groups fetch produces the PARENTS; the children
  // come synchronously from the scoped derived party (the same data the hover
  // cards decompose), so expanding costs no fetch. Metrics without nesting
  // semantics declare no accessor and their rows keep only what they carry.
  const rowChildren = useCallback(
    (row: MetricRow) =>
      metric.children
        ? metric.children({ row, players, level, pins, hostility, fightDurationMs, keying: rowKeying })
        : null,
    [metric, players, level, pins, hostility, fightDurationMs, rowKeying]
  );

  // The character that tells two same-labelled ability rows apart: the child
  // character a group key carries (Id's own kit vs his dragonform's), else the
  // key's owning player — found by the same scan the label itself is named
  // through, so the qualifier can never name a different owner than the label.
  const abilityQualifier = useCallback(
    (key: string) => {
      const child = childOfPin(key);
      if (child !== null) return translateCharacterType(child);
      const owner = abilityOwnerFor(key, identityPlayers, playerByIndex.get(sourcePin ?? -1)?.player);
      return owner ? translateCharacterType(owner.characterType) : "";
    },
    // i18n.language: character names are translated.
    [identityPlayers, playerByIndex, pins.source, i18n.language]
  );

  // Duplicate parent labels carry their owner's character, only on collision —
  // the same rule the chart legend applies to duplicate player names.
  const abilityRowLabels = useMemo(
    () => qualifiedAbilityLabels(rows, labelForAbility, abilityQualifier),
    [rows, labelForAbility, abilityQualifier]
  );

  const isStatusMetric = metric.labelKind("players") === "status";
  const statusRowKind = statusRowKindFor(pins.ability, hostility);

  // A descriptor that can produce more than one shape of row at one level says
  // so on the rows themselves (`MetricRow.kind`). Every row of a table shares a
  // shape, so the first of them settles it for the header too.
  const declaredKind = rows[0]?.kind;

  // What a row's label and its icon are BOTH resolved against. One value rather
  // than the same expression in each callback: the two must never disagree, or
  // a row pairs one kind's name with another kind's art.
  const tableKind = declaredKind ?? (isStatusMetric ? statusRowKind : metric.labelKind(level));

  // One colour per slotless status row, shared with the chart bands below so a
  // row and its band can never disagree.
  const rowColors = useMemo(() => (isStatusMetric ? statusRowColors(rows) : null), [isStatusMetric, rows]);

  // The effects table's provenance (spec §3): each row's cause class as a
  // SOURCE cell, and the rows grouped into titled sections ordered
  // Skill → Sigil/Trait → Field → Unknown. Effect level only — a holder row
  // is one actor, not a cause — and the sections are visual grouping alone.
  const effectLevel = isStatusMetric && !isStatusPin(pins.ability);

  // A cause is classed `skill` only when a name actually resolves for it —
  // through the row's own casters, the same pipeline the labels use.
  // The row-shaped form of the naming hook's own classifier. The ladder itself
  // is shared with `statusDisplayLabel`, so a row's section and its name are
  // now structurally unable to disagree.
  const classOfRow = useCallback((row: MetricRow) => classOfRowKey(row.key), [classOfRowKey]);

  const shownRows = useMemo(
    () => (effectLevel ? withProvenance(rows, classOfRow, (cls) => t(CAUSE_CLASS_LABEL_KEY[cls])) : rows),
    [effectLevel, rows, classOfRow, t]
  );

  const sectionLabelOf = useCallback((row: MetricRow) => t(CAUSE_CLASS_LABEL_KEY[classOfRow(row)]), [classOfRow, t]);

  // The art beside a row's name, by the same discriminator the name uses, so
  // a row can never pair one kind's name with another kind's icon. Undefined
  // is the honest answer for most of what has none: combo actions are not
  // ability casts, `actor:` holder rows index no spawn, and only the boss
  // roster has portraits at all (see enemyIcon.ts).
  const rowIconUrl = useCallback(
    (row: MetricRow): string | undefined => {
      // A self-naming row depicts nothing (see `MetricRow.labelKey`); the
      // ability join below would answer with whichever art its fallback picks.
      if (row.labelKey) return undefined;
      // The row's own kind wins, exactly as in `renderLabel` — the two share
      // one discriminator so a row can never pair one kind's name with
      // another kind's art.
      const kind = rowKindOf(row, tableKind);
      if (kind === "status") {
        const statusId = statusIdOfKey(row.label);
        return statusId === null ? undefined : statusIconUrl(statusId);
      }
      if (kind === "player") return sourceIconUrl(Number(row.label));
      if (kind === "target") {
        const segment = targetRowSegment(row.label);
        return segment === null ? undefined : targetIconUrl(segment);
      }
      // An enemy TYPE row carries the type itself, so it needs no spawn to look
      // one up through.
      if (kind === "enemy") return enemyIconUrl(parseEnemyRow(row.label));
      // A taken row is an enemy's attack, so it wears the attacker's portrait.
      if (kind === "takenAttack") {
        const parts = takenAttackRowParts(row.label);
        return parts ? enemyIconUrl(parts.enemyType) : undefined;
      }
      return abilityRowIconUrl(row.label, identityPlayers, playerByIndex.get(sourcePin ?? -1)?.player);
    },
    [tableKind, playerByIndex, targetEntries, identityPlayers, sourceIconUrl, targetIconUrl, sourcePin]
  );

  const renderLabel = useCallback(
    (row: MetricRow) => {
      // A row that names itself (see `MetricRow.labelKey`) resolves against
      // nothing: it is not an ability, a player or an effect, and sending its
      // sentinel through one of those joins would print that join's guess.
      if (row.labelKey) return t(row.labelKey, row.labelParams);
      // The row's own kind wins — the groups path declares one per row — and
      // the table-level discriminator stands in for the legacy descriptors.
      const kind = rowKindOf(row, tableKind);
      // Effect names come from status.tbl via the generated `statuses` bundle;
      // the ~90 internal statuses the game never names answer empty and fall
      // back to "Effect <id>". The cause resolves through `causeSkillName`,
      // which bridges the effect-entry id at `+0x4c` to the acting skill.
      const name =
        kind === "status"
          ? statusDisplayLabel(row.label)
          : kind === "player"
            ? labelForSource(Number(row.label))
            : kind === "target"
              ? targetRowLabel(row.label, labelForTarget)
              : kind === "enemy"
                ? translateEnemyType(parseEnemyRow(row.label))
                : kind === "takenAttack"
                  ? takenAttackLabel(row.label)
                  : abilityRowLabels.get(row.key) ?? labelForAbility(row.label);
      const icon = rowIconUrl(row);
      if (!icon) return name;
      return (
        <>
          <img className="analysis-row-icon" src={icon} alt="" />
          {name}
        </>
      );
    },
    [
      t,
      tableKind,
      labelForSource,
      labelForTarget,
      labelForAbility,
      takenAttackLabel,
      statusDisplayLabel,
      rowIconUrl,
      abilityRowLabels,
    ]
  );

  const rowColor = useCallback(
    (row: MetricRow) => {
      if (row.colorSlot < 0) {
        // An ENEMY row — a spawn or a type — takes its own actor colour, the
        // same one the chart band above it and the dropdown beside it take.
        // Before this every enemy row was the neutral ink, which said nothing
        // about which enemy it was and made the table the one place in the
        // view where a boss had no identity.
        //
        // Ahead of the status colours, and it cannot steal from them: an
        // effect row's key is `status:`, which names no actor at all.
        const actor = keyColor(row.key, colorContext);
        if (actor !== undefined) return actor;
        return rowColors?.get(row.key) ?? "var(--an-ink-3)";
      }
      // Re-resolve through the identity party: a scoped fetch renumbers slots,
      // so the descriptor's colorSlot can point at the wrong player.
      const key = row.key.startsWith("player:") ? Number(row.key.slice("player:".length)) : pins.source;
      return playerColor(key ?? -1, row.colorSlot);
    },
    [playerColor, pins.source, rowColors, colorContext]
  );

  // The rule itself lives in cardSections.ts; the view only supplies the name
  // and colour lookups that keep it a pure function.
  const sectionLabels = useMemo(
    () => ({
      // With an owner (a player card decomposing that player's own breakdown),
      // the key is named against THEIR table first — action ids collide across
      // characters, and the party-order scan named Id's own 120 with Eustace's
      // "Grade 1 Shot" on the hover card.
      ability: (key: string, owner?: ComputedPlayerState) =>
        owner ? abilityLabelFor(key, identityPlayers, getSkillName, owner) : labelForAbility(key),
      enemy: (type: EnemyType) => translateEnemyType(type),
      source: labelForSource,
      // The player's OWN party colour, resolved through the identity party so a
      // scoped fetch's renumbered slots cannot recolour them mid-drill.
      sourceColor: (index: number) => playerColor(index, 0),
      character: translateCharacterType,
      // The same art the rows above the card show, resolved the same way, so
      // hovering a row cannot show its members under different pictures.
      abilityIcon: (key: string, owner?: ComputedPlayerState) => abilityRowIconUrl(key, identityPlayers, owner),
      enemyIcon: enemyIconUrl,
      sourceIcon: sourceIconUrl,
      // The SAME spawn naming (and art) the table's target rows resolve
      // through, so a card's "#2" can never name a different spawn.
      target: labelForTarget,
      targetIcon: targetIconUrl,
    }),
    [labelForAbility, identityPlayers, labelForSource, playerColor, sourceIconUrl, targetIconUrl]
  );

  // The enemy-side cards' lookups: the same ones the friendly card already
  // injects, plus the enemy-attack namer the taken tab uses. Extended rather
  // than restated so an ability, a player and their colour cannot be named one
  // way on the friendly side and another on the enemy side.
  const hostilityLabels = useMemo(
    () => ({ ...sectionLabels, attack: labelForTakenAttack }),
    [sectionLabels, labelForTakenAttack]
  );

  // Which card explains a row is DECLARED per (grouping, side) — see
  // `MetricCapabilities.cardKind` — and routed by `rowCardSectionsFor`, the
  // pure dispatch the presence test exercises. The view only supplies the
  // name/colour lookups and the scoped party.
  const rowSections = useCallback(
    (row: MetricRow) =>
      rowCardSectionsFor({
        cardKind: caps.cardKind(spec.groupBy, hostility),
        groupBy: spec.groupBy,
        row,
        level,
        players,
        pins,
        targetEntries,
        color: rowColor(row),
        labels: hostilityLabels,
        card: metric.card,
        keying: rowKeying,
      }),
    [caps, spec.groupBy, hostility, level, players, pins, targetEntries, rowColor, hostilityLabels, metric, rowKeying]
  );

  return {
    metric,
    rows,
    shownRows,
    rowChildren,
    renderLabel,
    rowColor,
    rowSections,
    sectionLabelOf,
    isStatusMetric,
    effectLevel,
  };
};
