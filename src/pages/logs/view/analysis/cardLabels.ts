import type { ActionType, CharacterType, ComputedPlayerState, EnemyType } from "@/types";

/**
 * Every lookup a hover card can need, with ONE declaration.
 *
 * The four card modules each used to declare their own bundle — `SectionLabels`,
 * `HostilityCardLabels`, `TakenSectionLabels`, `DealtFoldLabels` — and the four
 * overlapped almost entirely, down to the same paragraph about colliding action
 * ids copied into each. `RowCardLabels` then intersected two of them back
 * together, and the view passes ONE object to all of them anyway.
 *
 * So the fields are declared here and each module takes the `Pick` it actually
 * uses. Interface segregation is kept — a builder still names its minimum, and
 * its tests still build only that — but a field cannot mean one thing in one
 * card and something else in the next, and its doc has one author.
 *
 * The view fills every one of these as a PROJECTION of the entity bundle (see
 * `useEntityCells`), so a card's names and its art come out of the same ladder
 * the table's rows and the chart's bands do.
 */
export type CardLabels = {
  /** One enemy attack, named with its attacker for context — enemy action ids
   * carry no names of their own. */
  attack: (enemyType: EnemyType, actionId: ActionType) => string;
  /** `owner` is the player whose breakdown the key is being named for. Action
   * ids collide across characters (120 is Eustace's "Grade 1 Shot" AND Id's
   * "Combo Finisher (Dragonform)"), so an ability folded out of one player's
   * table must be named against THAT player. */
  ability: (key: string, owner?: ComputedPlayerState) => string;
  enemy: (type: EnemyType) => string;
  /** A player's display name, honouring streamer mode and the label template. */
  source: (index: number) => string;
  /** That player's own party colour, so a source row matches their bar. */
  sourceColor: (index: number) => string;
  /** One enemy SPAWN's display name (name + "#N" once a name repeats) — the
   * SAME labelling the table's target rows resolve through, so the card's "#2"
   * and the table's "#2" can never name different spawns. */
  target?: (segment: number) => string;
  /** A character's display name, for qualifying two same-named ability entries
   * from different bodies (Id vs his dragonform) — applied only on collision,
   * by the same helper the table's parent rows use. */
  character?: (type: CharacterType) => string;
  /** The entities' art. Optional only so a builder's own tests can stay
   * text-only where art is not their subject: the view fills all of them, from
   * one projection, so no production card can be missing one. */
  abilityIcon?: (key: string, owner?: ComputedPlayerState) => string | undefined;
  enemyIcon?: (type: EnemyType) => string | undefined;
  sourceIcon?: (index: number) => string | undefined;
  targetIcon?: (segment: number) => string | undefined;
};
