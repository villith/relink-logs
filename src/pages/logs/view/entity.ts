import type { ActionType, ComputedPlayerState, EnemyType } from "@/types";

import type { LabelKind, MetricRow } from "./metrics/types";
import { parseEnemyRow, rowRefOf, takenAttackRowParts, type RowRef } from "./rowKey";

/**
 * How the view presents ONE thing — a player, a spawn, an enemy type, an
 * attack, an ability, an effect — wherever it presents it.
 *
 * Name, art and colour travel TOGETHER because they were forgotten separately.
 * The view resolved each of the three through its own dispatch over the same
 * key grammar — one in `bandLabelFor`, one in `bandIconFor`, one in
 * `actorOfKey` — plus a fourth pair over the ROW grammar in `renderLabel` and
 * `rowIconUrl`. Every surface added since had to remember to wire all of them,
 * and the misses did not look like bugs: a missing icon renders as a text-only
 * row, and a missing name renders as the raw key. That is why the same class of
 * defect kept arriving one surface at a time — the chart tooltip listing
 * "Arcadia" as bare text beside a table showing its portrait, the grouped
 * abilities in the hover card showing no diamond, the drill bands printing
 * "Normal:1000".
 *
 * A cell cannot half-exist: a resolver answers with everything it knows about
 * the thing, so a new surface asking for one gets the art and the colour it did
 * not know to ask for.
 *
 * `iconUrl`/`color` are optional because ABSENCE IS DATA, not because a caller
 * may skip them: most of what the view draws genuinely has no picture (only the
 * boss roster has portraits; combo actions and gauge causes are not ability
 * casts) and no colour of its own (an ability belongs to whoever used it).
 */
export type EntityCell = { name: string; iconUrl?: string; color?: string };

/**
 * The view's lookups, one per thing the grammar can name.
 *
 * Every field is REQUIRED. The bundles this replaces (`BandIconResolvers`,
 * `EventLabels`) marked their art resolvers optional "so tests and older
 * callers stay text-only", which is precisely the mechanism by which real
 * callers shipped text-only too — an omitted resolver is indistinguishable
 * from an entity that has no art.
 */
export type EntityResolvers = {
  player: (index: number) => EntityCell;
  /** One enemy SPAWN, by segment. */
  target: (segment: number) => EntityCell;
  /** A holder the segmenter never placed. It has a name — its raw actor id, the
   * only identity there is — and nothing else. */
  actor: (actorIndex: number) => EntityCell;
  enemy: (enemyType: EnemyType | null) => EntityCell;
  takenAttack: (enemyType: EnemyType, actionId: ActionType) => EntityCell;
  /** `owner` is the player whose breakdown the key is being named for, where
   * the caller knows one. Action ids collide across characters (120 is
   * Eustace's "Grade 1 Shot" AND Id's "Combo Finisher (Dragonform)"), so a
   * pinned player's rows must be named and illustrated against THEIR tables. */
  ability: (rowKey: string, owner?: ComputedPlayerState) => EntityCell;
  status: (statusKey: string) => EntityCell;
  /** The self-naming keys — the rollup band, the Total series and the SBA gauge
   * causes. They carry their own i18n key rather than resolving against
   * anything, and sending one through an entity join prints that join's guess
   * (the unattributed remainder wears a `skill:` key it has no ability for). */
  reserved: (ref: RowRef & { kind: "rollup" | "total" | "sbaCause" }) => EntityCell;
};

/** One cell as a pin-selector option (`PinSelect`'s `LabelledOption`).
 *
 * The shape conversion has one author because the three selectors fill it three
 * times and an option that lost its `color` or its `iconUrl` on the way through
 * is the dropdown quietly disagreeing with the row it pins. Absent fields are
 * OMITTED rather than written `undefined`: `exactOptionalPropertyTypes` makes
 * the difference a type error rather than a silent empty box. */
export const optionOfCell = (
  value: string,
  cell: EntityCell
): { value: string; label: string; iconUrl?: string; color?: string } => ({
  value,
  label: cell.name,
  ...(cell.iconUrl === undefined ? {} : { iconUrl: cell.iconUrl }),
  ...(cell.color === undefined ? {} : { color: cell.color }),
});

/** The cell for one parsed reference. The single dispatch over the taxonomy —
 * every surface's names, art and colours come out of this one switch. */
export const entityCell = (ref: RowRef, resolve: EntityResolvers, owner?: ComputedPlayerState): EntityCell => {
  switch (ref.kind) {
    case "player":
      return resolve.player(ref.index);
    case "target":
      return resolve.target(ref.segment);
    case "actor":
      return resolve.actor(ref.actorIndex);
    case "enemy":
      return resolve.enemy(ref.enemyType);
    case "takenAttack":
      return resolve.takenAttack(ref.enemyType, ref.actionId);
    case "ability":
      return resolve.ability(ref.rowKey, owner);
    case "status":
      return resolve.status(ref.statusKey);
    default:
      return resolve.reserved(ref);
  }
};

/** The cell for one row or band KEY.
 *
 * An unparseable key falls back to itself: for a stale or hand-edited URL,
 * showing it back is what tells the user what is wrong. It draws no art and no
 * colour, because nothing is known about it — which is the honest rendering of
 * a key the view cannot place. */
export const cellOfKey = (key: string, resolve: EntityResolvers, owner?: ComputedPlayerState): EntityCell => {
  const ref = rowRefOf(key);
  return ref === null ? { name: key } : entityCell(ref, resolve, owner);
};

/**
 * What a TABLE ROW names, in the row grammar rather than the key grammar.
 *
 * Rows carry their kind separately (`MetricRow.kind`, falling back to the
 * table's own) and their `label` is the bare PAYLOAD — a player index, an
 * `EnemyType` as JSON, an ability row key — rather than a prefixed key. The two
 * exceptions are deliberate and predate this: a holder row's label carries its
 * own `target:`/`actor:` prefix because those are two different things at one
 * level, and a status row's label IS its full `status:` key.
 *
 * Two grammars for one taxonomy is a thing worth removing, but not by rewriting
 * every descriptor: the row form is what the parser's payloads and the pin URLs
 * already carry. So it gets a reader instead, right beside the key one, and
 * both land on the same `RowRef` — which is what stops a row and the band that
 * decomposes it being named by two different ladders.
 *
 * `null` for a row that names nothing at all: `MetricRow.labelKey` is the
 * self-naming escape hatch (today only the SBA remainder), and putting its
 * sentinel through any join prints whatever that join makes of a name it has
 * never seen.
 */
export const rowRefOfRow = (row: MetricRow, tableKind: LabelKind): RowRef | null => {
  if (row.labelKey) return null;
  const kind = row.kind ?? tableKind;
  switch (kind) {
    case "player":
      return { kind: "player", index: Number(row.label) };
    // Prefixed in the row grammar, so it goes through the key reader — which
    // also answers for the `actor:` fallback the same branch produces.
    case "target":
      return rowRefOf(row.label);
    case "enemy":
      return { kind: "enemy", enemyType: parseEnemyRow(row.label) };
    case "takenAttack": {
      const parts = takenAttackRowParts(row.label);
      return parts === null ? null : { kind: "takenAttack", ...parts };
    }
    case "status":
      return { kind: "status", statusKey: row.label };
    default:
      return { kind: "ability", rowKey: row.label };
  }
};

/** The cell for one table row, by the same taxonomy the bands resolve through.
 *
 * A row that names itself gets its own text and nothing else — which is why
 * this takes the resolved name rather than the i18n function: `labelKey` is the
 * caller's to translate, and the rest is this module's to resolve. */
export const cellOfRow = (
  row: MetricRow,
  tableKind: LabelKind,
  resolve: EntityResolvers,
  selfNamed: (row: MetricRow) => string,
  owner?: ComputedPlayerState
): EntityCell => {
  const ref = rowRefOfRow(row, tableKind);
  return ref === null ? { name: selfNamed(row) } : entityCell(ref, resolve, owner);
};
