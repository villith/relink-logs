#!/usr/bin/env node
/**
 * Generates src/assets/attack-group-coverage.json — the per-character registry
 * of ATTACK-GROUP membership derivation, so "which characters can resolve their
 * group-scoped cap nodes" is a fact in the repo rather than folklore.
 *
 * ## Why this exists
 *
 * Group-scoped board cap nodes ("Grade III Shots: DMG Cap +30%") carry only a
 * per-character `TargetAttackGroup` number. Which ACTIONS belong to that group
 * lives in engine code — not in any shipped table (checked: action.msg's
 * damageLimit fields are zero, actionFreeWork is gameplay tuning,
 * ability_group.tbl only backs the hash-scoped group 10). Membership is instead
 * derived EMPIRICALLY, per character, from instrumented local play: the cap
 * oracle logs the chokepoint's per-hit term values, and diffing per-action term
 * multisets against the player's unlocked nodes assigns actions to groups.
 * Every character is local when played solo — AI companions included — so
 * coverage grows one session at a time, and this file is where it accumulates.
 *
 * ## Shape
 *
 * Every character in skillboard-cap-sources gets an entry:
 *   status        not-needed  no group-scoped cap nodes exist for the character
 *                 underived   groups await evidence; the factor rows stay unknown
 *                 partial     some groups derived, some not
 *                 derived     every needed group has a membership
 *   neededGroups  group ids still awaiting derivation (computed, not stored)
 *   groups        the derived memberships: group id -> { actionIds, evidence }
 *
 * `groups` is the HAND-OFF SLOT: the solver (or a manual derivation) writes
 * entries here, and regeneration preserves them — status and neededGroups are
 * recomputed every run, memberships never invented. A membership whose group no
 * longer exists in the tables is dropped: a patch that renumbers groups must
 * not leave a ghost claiming coverage.
 *
 * Run: node scripts/gen-attack-group-coverage.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODES_PATH = path.join(ROOT, "src", "assets", "skillboard-cap-sources.json");
const OUT_PATH = path.join(ROOT, "src", "assets", "attack-group-coverage.json");

/** The character prefix of a `pl####_nnnn` node key. */
const characterOf = (nodeKey) => nodeKey.split("_")[0];

/**
 * Per character, the attack groups whose membership needs deriving: every
 * group-scoped CAP effect that names no abilities. Ability-scoped effects
 * (group 10, hashes present) resolve through the skill-name bridge and are
 * deliberately not a need.
 */
export const groupNeedsOf = (nodes) => {
  const needs = {};
  for (const [key, node] of Object.entries(nodes)) {
    const character = characterOf(key);
    needs[character] ??= {};
    for (const effect of node.effects) {
      if (effect.stat !== "cap" || effect.scope !== "attack-group") continue;
      if ((effect.abilityIds ?? []).length > 0) continue;
      const group = (needs[character][effect.targetAttackGroup] ??= { percents: [], nodeKeys: [] });
      group.percents.push(effect.percent ?? 0);
      group.nodeKeys.push(key);
    }
  }
  return needs;
};

/** The registry: computed needs merged with the derivations already banked. */
export const buildCoverage = (needs, existing) => {
  const coverage = {};
  for (const character of Object.keys(needs).sort()) {
    const neededIds = Object.keys(needs[character])
      .map(Number)
      .sort((a, b) => a - b);
    // Keep only memberships for groups the tables still define.
    const kept = Object.fromEntries(
      Object.entries(existing[character]?.groups ?? {}).filter(([id]) => neededIds.includes(Number(id)))
    );
    const derivedIds = Object.keys(kept).map(Number);
    const outstanding = neededIds.filter((id) => !derivedIds.includes(id));
    const status =
      neededIds.length === 0
        ? "not-needed"
        : outstanding.length === 0
          ? "derived"
          : derivedIds.length > 0
            ? "partial"
            : "underived";
    coverage[character] = { status, neededGroups: outstanding, groups: kept };
  }
  return coverage;
};

const main = () => {
  const nodes = JSON.parse(readFileSync(NODES_PATH, "utf8")).nodes;
  const existing = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, "utf8")).characters : {};
  const characters = buildCoverage(groupNeedsOf(nodes), existing);

  const counts = {};
  for (const { status } of Object.values(characters)) counts[status] = (counts[status] ?? 0) + 1;
  writeFileSync(OUT_PATH, `${JSON.stringify({ version: "2.0.4", characters }, null, 2)}\n`);
  console.log(
    `${Object.keys(characters).length} characters -> ${OUT_PATH}\n` +
      Object.entries(counts)
        .map(([status, n]) => `  ${status}: ${n}`)
        .join("\n")
  );
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
