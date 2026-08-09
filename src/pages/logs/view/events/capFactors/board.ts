import boardSources from "@/assets/skillboard-cap-sources.json";
import { SIGIL_CATEGORY_TARGET, collectSigilsByCategory, skillboardNodeKey } from "@/utils";

import type { CapClass, CapLoadout } from "../capSources";
import {
  activeResult,
  inactiveResult,
  notApplicableResult,
  unknownResult,
  type CapConditions,
  type CapFactor,
  type CapFactorResult,
} from "./types";

/**
 * The master trait board, itemized per unlocked node.
 *
 * This is the term the breakdown used to write off. The panel said the board
 * "grants trait levels the stored loadout cannot show, so a slice of every real
 * hit stays unaccounted by construction" — which was simply not true: the log
 * carries the ids of the nodes a player unlocked, and the game's own node text
 * carries what each grants. `gen-skillboard-cap-sources.mjs` joins them.
 *
 * A node scoped to one move or gated on runtime state is reported as
 * unresolved, not as zero and not at its maximum, for the same reason a
 * conditional trait is.
 */

type BoardNode =
  | { scope: "always"; capClass: string; percent: number }
  | { scope: "sigil-count"; capClass: string; percent: number; maxCount: number }
  | { scope: "action"; capClass: string; percent: number; label: string }
  | { scope: "conditional"; capClass: string; percent: number; condition: string };

const NODES = boardSources.nodes as Record<string, BoardNode>;
/** Nodes that raise the cap in a shape the generator could not reduce to one
 * magnitude — kept with their text so they can still be named. */
const UNPARSED = boardSources.unparsed as Record<string, string>;

/** Whether a node's class applies to this hit. `all` raises every class, which
 * is what a bare "DMG Cap +35%" means. */
const appliesTo = (nodeClass: string, capClass: CapClass): boolean => nodeClass === "all" || nodeClass === capClass;

const evaluateNode = (
  node: BoardNode,
  player: CapLoadout,
  capClass: CapClass,
  conditions: CapConditions
): CapFactorResult => {
  if (!appliesTo(node.capClass, capClass)) return notApplicableResult("other-class");

  switch (node.scope) {
    case "always":
      return activeResult(node.percent);

    case "sigil-count": {
      // A sigil's type is its FIRST trait's type — the same rule the Builds
      // tab's checklist counts by.
      const equipped = collectSigilsByCategory(player, ["basic"]).length;
      const counted = Math.min(equipped, node.maxCount || SIGIL_CATEGORY_TARGET);
      return counted > 0 ? activeResult(node.percent * counted) : inactiveResult(node.percent);
    }

    case "action":
      // The node names its move in prose ("Dead Lands"), and nothing maps that
      // prose to the action id a hit carries. Saying so is the point: a caller
      // that HAS supplied the action id is owed "the model cannot match it",
      // not a repeat of "you did not tell me".
      return conditions.actionId === undefined
        ? unknownResult(node.percent, ["actionId"])
        : unknownResult(node.percent, [], "no-action-mapping");

    case "conditional":
      return conditions.buffs === undefined
        ? unknownResult(node.percent, ["buffs"])
        : unknownResult(node.percent, [], "no-status-mapping");
  }
};

/**
 * Every unlocked board node that touches the damage cap, as a factor.
 *
 * A node the player has not unlocked is not a factor at all — unlike a trait,
 * where a rejected source still says why, an unselected board node is one of
 * several hundred the character merely could have taken.
 */
export const boardFactors = (player: CapLoadout | undefined, capClass: CapClass | null): CapFactor[] => {
  if (player === undefined || capClass === null) return [];
  const characterType = player.characterType;
  if (typeof characterType !== "string") return [];

  const factors: CapFactor[] = [];
  for (const id of player.skillboard ?? []) {
    const key = skillboardNodeKey(characterType, id);
    const base = { key: `board-${key}`, kind: "board-node" as const, id, label: null, level: null };

    const node = NODES[key];
    if (node !== undefined) {
      const params =
        node.scope === "action"
          ? (["actionId"] as const)
          : node.scope === "conditional"
            ? (["buffs"] as const)
            : ([] as const);
      factors.push({ ...base, params, evaluate: (conditions) => evaluateNode(node, player, capClass, conditions) });
      continue;
    }

    // Unparsed, but real: the node's text says it raises the cap even though
    // the generator could not say by how much. Dropping it would let the
    // breakdown read as complete while quietly missing a source.
    if (UNPARSED[key] !== undefined) {
      factors.push({ ...base, params: [], evaluate: () => unknownResult(0, [], "unparsed") });
    }
  }
  return factors;
};
