import type { EnemyType, PlayerData } from "@/types";
import { ENEMY_COLORS, resolvePlayerColor } from "@/utils";

import { parseEnemyRow } from "./metrics/damageDone";

/** One actor, in whichever shape the caller has it.
 *
 * Three shapes because the view groups actors three ways and every one of them
 * has to end up the same colour as the others: a player by actor index, one
 * enemy SPAWN by its index into `targetEntries`, and an enemy TYPE, which
 * merges every spawn of that type into one row. */
export type ActorKey =
  | { kind: "player"; index: number }
  | { kind: "spawn"; segment: number }
  | { kind: "enemyType"; type: EnemyType | null };

/** The actor a row or chart-band key names, or null when it names none.
 *
 * The table and the chart both work in key space, and the three grammars here
 * are the ones their producers already write (`groupRows`, `enemyRowKey`,
 * `enemyHolderKey`). `actor:<id>` — an enemy the segmenter skipped — answers
 * null on purpose: it has no spawn to be coloured by, and colouring it by its
 * raw actor index would give a reissued index two spawns' colours. */
export const actorOfKey = (key: string): ActorKey | null => {
  if (key.startsWith("player:")) {
    const index = Number(key.slice("player:".length));
    return Number.isFinite(index) ? { kind: "player", index } : null;
  }
  if (key.startsWith("target:")) {
    const segment = Number(key.slice("target:".length));
    return Number.isFinite(segment) ? { kind: "spawn", segment } : null;
  }
  if (key.startsWith("enemy:")) return { kind: "enemyType", type: parseEnemyRow(key.slice("enemy:".length)) };
  return null;
};

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
 * One function because the four of them show the SAME actors and a reader
 * moves between them constantly — a boss that is pink in the plot, grey in the
 * table and uncoloured in the dropdown is three enemies as far as the eye is
 * concerned. Before this they each answered for themselves, and only the
 * players agreed.
 *
 * `undefined` means "this actor has no colour", not "use grey": a player the
 * identity party does not know has no slot to resolve, and inventing one would
 * paint a stranger in a party member's colour. Callers supply their own
 * fallback — the table's neutral ink, the chart's positional palette.
 */
export const actorColor = (actor: ActorKey, ctx: ActorColorContext): string | undefined => {
  if (actor.kind === "player") {
    const slot = ctx.slotOf(actor.index);
    return slot === undefined ? undefined : resolvePlayerColor(ctx.palette, ctx.partyData, slot, 0);
  }
  return actor.kind === "spawn" ? enemyColor(actor.segment) : enemyColor(enemyTypeIndex(actor.type));
};

/** `actorColor` against a row or band KEY, for the callers that have one. */
export const keyColor = (key: string, ctx: ActorColorContext): string | undefined => {
  const actor = actorOfKey(key);
  return actor === null ? undefined : actorColor(actor, ctx);
};
