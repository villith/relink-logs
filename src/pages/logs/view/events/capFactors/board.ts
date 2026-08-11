import boardSources from "@/assets/skillboard-cap-sources.json";
import { getSkillNameSources } from "@/skillNameSources";
import { collectSigilsByCategory, skillboardNodeKey, type SigilCategory } from "@/utils";

import type { CapClass, CapLoadout } from "../capSources";
import { groupActionIds } from "./attackGroups";
import {
  activeResult,
  inactiveResult,
  notApplicableResult,
  unknownResult,
  type CapConditions,
  type CapFactor,
  type CapFactorResult,
  type CapParamKey,
} from "./types";

/**
 * The master trait board, itemized per unlocked node.
 *
 * This is the term the breakdown used to write off. The log carries which nodes
 * a player unlocked and the game's own TABLES carry what each one grants —
 * `gen-skillboard-cap-sources.mjs` joins `skillboard_layout` through
 * `skillboard_effect` into `skillboard_effect_action_parts`.
 *
 * Everything here is keyed by number, never by name. A node scoped to one move
 * carries the ability ids the table names; a node behind a buff carries the
 * status id the hook itself emits. That matters beyond tidiness: an earlier
 * version of this asset was built by regex over English effect text, and
 * besides missing cases it INVENTED 57 cap sources that do not exist — the
 * Summon Cost EX nodes carry a cap-shaped payload the engine repurposes.
 */

/** One thing a node does. Only `stat: "cap"` reaches a hit's damage cap;
 * `chain-burst-cap` is a real effect on a different number entirely. */
type BoardEffect = {
  stat: string;
  /** `null` where the table scopes by a per-character attack group whose class
   * cannot be claimed — group 8 is "Combo Finishers" on one character and
   * something else on another. */
  capClass: string | null;
  percent?: number;
  scope: string;
  abilityIds?: string[];
  targetAttackGroup?: number;
  gateKind?: string;
  gateStatusId?: number;
  gateState?: number;
  countKind?: string;
  maxCount?: number;
  perUnit?: number;
  grantsStatusId?: number;
  durationSeconds?: number;
};

const NODES = boardSources.nodes as unknown as Record<string, { effects: BoardEffect[] }>;
/** Nodes whose magnitudes are in the table but whose MEANING lives in the exe —
 * character keystones and rank-ups. Kept so they can still be named. */
const ENGINE_DEFINED = boardSources.engineDefined as unknown as Record<string, unknown>;

/** Which sigil categories each counted rule counts. A sigil's type is its FIRST
 * trait's type, the same rule the Builds tab's checklist uses. */
const SIGIL_CATEGORIES: Record<string, SigilCategory[]> = {
  "basic-sigil": ["basic"],
  "attack-sigil": ["attack"],
  "defense-support-sigil": ["defense", "support"],
};

/** Whether an effect names a class this hit is not. `all` raises every class;
 * `null` is a per-character attack group, which is not a class claim either
 * way, so the scope handling below decides it. */
const wrongClass = (effect: BoardEffect, capClass: CapClass): boolean =>
  effect.capClass === "skill" && capClass !== "skill";

const paramsFor = (effect: BoardEffect): readonly CapParamKey[] => {
  if (effect.scope === "attack-group") return ["actionId"];
  if (effect.scope === "gated" || effect.scope === "grants-status") return ["buffs"];
  if (effect.scope === "counted" && effect.countKind === "quest-counter") return ["questAccum"];
  return [];
};

/** Where the effect's value lives (see `CapFactor.placement`). Counted-sigil
 * totals are static per fight and the game fuses them into the captured
 * record at load — they never appear in a hit's channel terms (log 2573
 * oracle: the two pl2700 basic-sigil nodes are exactly the +200% the record
 * holds beyond its other components). Everything per-hit — always, group,
 * gated, granted — IS the FreeWork channel the oracle itemizes. */
const placementFor = (effect: BoardEffect): "record" | "channel" =>
  effect.scope === "counted" && effect.countKind !== "quest-counter" ? "record" : "channel";

const evaluateEffect = (
  effect: BoardEffect,
  player: CapLoadout,
  characterType: string,
  capClass: CapClass,
  conditions: CapConditions
): CapFactorResult => {
  const percent = effect.percent ?? 0;
  if (wrongClass(effect, capClass)) return notApplicableResult("other-class");

  switch (effect.scope) {
    case "always":
      return activeResult(percent);

    case "attack-group": {
      // Two different id spaces, never compared raw: the table's `abilityIds`
      // are xxhash32 of `ability.tbl` keys; a hit's action id is a small
      // per-character integer. `skill-name-sources` is the bridge — the same
      // per-character action-id → ability-hash map the meter already names
      // skills through, generated off the game's own action tags.
      //
      // Resolution requires BOTH ends: an action the bridge covers, matched
      // against a node that names its abilities. A raw "no match" as
      // `inactive` would be a confident, wrong claim that the node
      // contributed nothing — so a group-only node (empty `abilityIds`) and
      // an unbridged action (a normal attack, a patch-added move) both stay
      // unresolved and say why.
      if (conditions.actionId === undefined) return unknownResult(percent, ["actionId"]);
      const abilityIds = effect.abilityIds ?? [];
      if (abilityIds.length === 0) {
        // A group-only node: the coverage registry may carry an empirically
        // derived membership for this character's group (see attackGroups.ts).
        // Underived stays unresolved — a missing membership is a question, not
        // an empty set.
        const members = groupActionIds(characterType, effect.targetAttackGroup ?? -1);
        if (members === null) return unknownResult(percent, [], "no-action-mapping");
        return members.includes(conditions.actionId) ? activeResult(percent) : inactiveResult(percent);
      }
      const source = getSkillNameSources()[characterType]?.[String(conditions.actionId)];
      if (source === undefined || source.ns !== "abilities") {
        return unknownResult(percent, [], "no-action-mapping");
      }
      return abilityIds.includes(source.hash) ? activeResult(percent) : inactiveResult(percent);
    }

    case "gated": {
      // An engine-state gate is a per-character mode or gauge tier with no
      // table row behind it, so no buff list can decide it.
      if (effect.gateKind !== "status" || effect.gateStatusId === undefined) {
        return unknownResult(percent, [], "no-status-mapping");
      }
      if (conditions.buffs === undefined) return unknownResult(percent, ["buffs"]);
      return conditions.buffs.includes(effect.gateStatusId) ? activeResult(percent) : inactiveResult(percent);
    }

    case "counted": {
      // A run-scoped accumulator the log does not carry; `percent` is the
      // ceiling the table states.
      if (effect.countKind === "quest-counter") return unknownResult(percent, ["questAccum"]);
      const categories = SIGIL_CATEGORIES[effect.countKind ?? ""];
      if (categories === undefined) return unknownResult(percent, [], "scaling-unknown");
      const equipped = collectSigilsByCategory(player, categories).length;
      const counted = Math.min(equipped, effect.maxCount ?? equipped);
      return counted > 0 ? activeResult(percent * counted) : inactiveResult(percent);
    }

    case "grants-status": {
      // The node does not raise the cap itself — it grants a cap-up status on
      // some trigger. Whether that status was up at THIS hit is a different
      // question from whether the node is unlocked.
      if (effect.grantsStatusId === undefined) return unknownResult(percent, [], "no-status-mapping");
      if (conditions.buffs === undefined) return unknownResult(percent, ["buffs"]);
      return conditions.buffs.includes(effect.grantsStatusId) ? activeResult(percent) : inactiveResult(percent);
    }

    default:
      return unknownResult(percent, [], "unparsed");
  }
};

/**
 * Every unlocked board node that touches the damage cap, as factors.
 *
 * One factor per EFFECT rather than per node: five nodes carry two cap effects
 * each, and folding those into one row would hide that a single node
 * contributes twice under different conditions.
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
    const base = { kind: "board-node" as const, id, label: null, level: null };

    const node = NODES[key];
    if (node !== undefined) {
      node.effects.forEach((effect, index) => {
        // Chain Burst has its own cap, on a number that is none of the three
        // per-hit classes. Counting it here would attribute it to a hit it
        // never applied to.
        if (effect.stat !== "cap") return;
        factors.push({
          ...base,
          key: `board-${key}-${index}`,
          placement: placementFor(effect),
          params: paramsFor(effect),
          evaluate: (conditions) => evaluateEffect(effect, player, characterType, capClass, conditions),
        });
      });
      continue;
    }

    // Engine-defined: the table holds this node's values, but which slot is the
    // cap lives in the exe. Named with no magnitude rather than dropped — a
    // dropped node lets the breakdown read as complete while missing a source.
    // Channel placement: what little is known of these (Eustace's per-action
    // flats) rides the per-hit paths, not the load-time record.
    if (ENGINE_DEFINED[key] !== undefined) {
      factors.push({
        ...base,
        key: `board-${key}`,
        placement: "channel",
        params: [],
        evaluate: () => unknownResult(0, [], "unparsed"),
      });
    }
  }
  return factors;
};
