import type { LabelKind } from "./metrics/types";

/** The row kinds that name an ACTOR — a party member, an enemy type, a spawn,
 * an enemy's attack — rather than one ability or one effect.
 *
 * The distinction is what the art IS, which is why two surfaces read it:
 *
 * - a timeline lane pooling everything one actor did cannot name its marks with
 *   a picture, because every bucket in it is a different skill (`laneShapeOf`);
 * - a table row's bar nests a DIAMOND into a notch cut for it, but an actor
 *   wears a bust or a portrait — no diamond to nest — so the bar runs behind
 *   it instead (`RowArt`).
 *
 * One list rather than one per surface: the two are the same question about the
 * same taxonomy, and answering it twice is how a lane and its row would come to
 * disagree about what they are drawing. */
export const ACTOR_KINDS: readonly LabelKind[] = ["player", "enemy", "target", "takenAttack"];

export const isActorKind = (kind: LabelKind | undefined): boolean => kind !== undefined && ACTOR_KINDS.includes(kind);
