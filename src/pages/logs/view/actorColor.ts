import type { EnemyType, PlayerData } from "@/types";
import { ENEMY_COLORS, resolvePlayerColor } from "@/utils";

import { rowRefOf, type RowRef } from "./rowKey";

/** A stable number for one enemy type, so a type takes the same colour in every
 * fight and in every grouping.
 *
 * The wire form is always `{ Unknown: hash }`, and that hash IS the identity —
 * no derivation needed. The string form is the generated bundle's own id, and
 * folds through a plain string hash. Deliberately NOT the row's position: a
 * position moves when the fight's damage ordering does, which would recolour an
 * enemy between one window and the next. */
const enemyTypeIndex = (type: EnemyType | null): number => {
  if (type === null) return 0;
  if (typeof type !== "string") return type.Unknown;
  let hash = 0;
  for (let at = 0; at < type.length; at += 1) hash = (hash * 31 + type.charCodeAt(at)) >>> 0;
  return hash;
};

/** The colour for one enemy, by whichever number identifies it. Wraps, so a
 * fight with more enemies than colours repeats rather than running out. */
const enemyColor = (identity: number): string => ENEMY_COLORS[Math.abs(identity) % ENEMY_COLORS.length];

/** What a colour lookup needs from the view: the party palette, the party data
 * `resolvePlayerColor` reads, and the actor-index → party-slot map.
 *
 * `slotOf` rather than the map itself so the caller can keep resolving through
 * the IDENTITY party — a scoped fetch renumbers slots, and a colour resolved
 * against the scoped party recolours players mid-drill. */
export type ActorColorContext = {
  /** The eight-entry party palette: the four user colours plus the overflow. */
  palette: string[];
  partyData: Array<PlayerData | null>;
  slotOf: (index: number) => number | undefined;
};

/**
 * The one answer to "what colour is this actor", shared by the chart, the
 * table, the pin selectors and the events stream.
 *
 * One function because the four of them show the SAME actors and a reader moves
 * between them constantly — a boss that is pink in the plot, grey in the table
 * and uncoloured in the dropdown is three enemies as far as the eye is
 * concerned. Before this they each answered for themselves, and only the
 * players agreed.
 *
 * Takes a `RowRef` rather than a colour-only taxonomy of its own. This used to
 * parse keys into a three-variant `ActorKey` that said "spawn" and "enemyType"
 * where every other module says "target" and "enemy" — one thing with two names
 * depending on which module was asking, and a fourth hand-written pass over the
 * key grammar to produce it. The three variants that carry a colour answer; the
 * rest answer `undefined`, which is the honest reading of "this names no
 * actor": an ability belongs to whoever used it, and an `actor:` holder indexes
 * no spawn (colouring it by its raw index would give a reissued index two
 * spawns' colours).
 *
 * `undefined` means "no colour", not "use grey": a player the identity party
 * does not know has no slot to resolve, and inventing one would paint a
 * stranger in a party member's colour. Callers supply their own fallback — the
 * table's neutral ink, the chart's positional palette.
 */
export const actorColor = (ref: RowRef, ctx: ActorColorContext): string | undefined => {
  if (ref.kind === "player") {
    const slot = ctx.slotOf(ref.index);
    return slot === undefined ? undefined : resolvePlayerColor(ctx.palette, ctx.partyData, slot, 0);
  }
  if (ref.kind === "target") return enemyColor(ref.segment);
  if (ref.kind === "enemy") return enemyColor(enemyTypeIndex(ref.enemyType));
  return undefined;
};

/** `actorColor` against a row or band KEY, for the callers that have one. */
export const keyColor = (key: string, ctx: ActorColorContext): string | undefined => {
  const ref = rowRefOf(key);
  return ref === null ? undefined : actorColor(ref, ctx);
};
