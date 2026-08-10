#!/usr/bin/env node
/**
 * Attack-group membership solver: joins a CAPORACLE capture to stored logs and
 * banks derived group memberships into src/assets/attack-group-coverage.json.
 *
 * ## The derivation
 *
 * The oracle itemizes every conditional-channel cap term of every hit the
 * local player and AI companions dealt, but not who dealt it. The stored log
 * knows who dealt every hit, but not the terms. The join (per session, by a
 * robust clock-offset estimate over uniquely-keyed (action, cap, rate) hits)
 * puts the two together, and then per (character, attack class):
 *
 *   1. per action, the STABLE term multiset — values present in every hit of
 *      that action (a transient hp-gated trait varies per hit; a group node
 *      cannot: membership is a property of the action);
 *   2. the class BASELINE — the value-wise minimum across actions (always-on
 *      channel terms: unconditional channel nodes, transcended blocks);
 *   3. each action's residual = stable − baseline − bridged move-scoped nodes
 *      (explained by skill-name-sources, never banked as a group);
 *   4. the residual must equal the value multiset of exactly ONE subset of the
 *      character's unlocked group-only nodes (groups fire all-or-nothing, so
 *      two same-valued nodes in one group demand the value TWICE — which is
 *      what tells Eustace's group 15 [30,30] from his group 16 [30]).
 *
 * Anything else — several subsets fit, no subset fits, or a conditional trait
 * shares a residual value and could masquerade as the group node — is FLAGGED,
 * never guessed (the handoff's ambiguity rule).
 *
 * ## Run
 *
 *   cargo run -p gbfr-logs --example cap_evidence -- --log 2559 > evidence.json
 *   grep CAPORACLE %APPDATA%/gbfr-logs/gbfr-logs.txt > oracle.txt
 *   node scripts/solve-attack-groups.mjs --oracle oracle.txt --evidence evidence.json [--write]
 *
 * Dry-run prints the report; --write banks memberships (status/neededGroups
 * recomputed through gen-attack-group-coverage's own buildCoverage).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCoverage, groupNeedsOf } from "./gen-attack-group-coverage.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The conditional-channel vtable (`FreeWorkEnhanceEffectPassive`) — reported
 * when a term rides anything else, since that would be a new discovery. */
const FREE_WORK_RVA = 0x61418d8;
const PARAM_CAP_UP = 2;
/** Sigil "empty slot" sentinel (utils.ts EMPTY_ID). */
const EMPTY_ID = 2289754288;
/** "DMG Cap +15% per active pet" — magnitude lives in text, not tables. */
const PHANTASM_TRAIT = 0x7351d602;
const PHANTASM_PER_PET = 15;

const LINE_RE =
  /CAPORACLE t=(\d+) inst=\S+ action=(\d+) rate=(-?[\d.]+|NaN|inf|-inf) class_flags=0x([0-9a-fA-F]+) cap=(\d+) floor=\S+ terms=\[([^\]]*)\] buffs=\[([^\]]*)\]/;

/** One oracle line, or null when the line is not a CAPORACLE record. The agg=,
 * drift and om= sections (absent on pre-aggregate builds) are not needed here. */
export const parseOracleLine = (line) => {
  const match = LINE_RE.exec(line);
  if (match === null) return null;
  const terms = [];
  if (match[6] !== "") {
    for (const part of match[6].split(",")) {
      const term = /0x([0-9a-fA-F]+):0x([0-9a-fA-F]+):(-?[\d.]+)/.exec(part);
      if (term === null) continue;
      terms.push({ rva: parseInt(term[1], 16), paramId: parseInt(term[2], 16), value: parseFloat(term[3]) });
    }
  }
  return {
    t: Number(match[1]),
    action: Number(match[2]),
    // Kept as the printed 3-decimal string: it IS the join key format.
    rate: match[3],
    classFlags: parseInt(match[4], 16),
    cap: Number(match[5]),
    terms,
  };
};

/**
 * The hook's clock is process-relative, so a drop back toward zero is a new
 * session. A SMALL backwards step is not: lines from different game threads
 * interleave slightly out of order in the log file, and splitting on ms-scale
 * jitter shears one session into fragments that each align worse.
 */
export const splitSessions = (records, resetGapMs = 60_000) => {
  const sessions = [];
  let current = [];
  let highWater = -Infinity;
  for (const record of records) {
    if (record.t < highWater - resetGapMs && current.length > 0) {
      sessions.push(current);
      current = [];
      highWater = -Infinity;
    }
    current.push(record);
    highWater = Math.max(highWater, record.t);
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
};

/** The join key both streams share. `rate` must already be a 3-decimal string
 * on the oracle side; the event side is formatted to match. */
export const hitKey = (action, cap, rate) =>
  `${action}|${cap}|${typeof rate === "string" ? rate : Number(rate).toFixed(3)}`;

const median = (sorted) => sorted[Math.floor(sorted.length / 2)];

/**
 * The clock offset (event unix ms − oracle process ms) from hits whose key is
 * unique on BOTH sides, clustered so a coincidental cross-fight key collision
 * cannot drag the estimate. Null when fewer than `minSupport` votes agree.
 */
export const alignOffset = (oracle, events, { minSupport = 5, clusterMs = 2000 } = {}) => {
  const countBy = (items) => {
    const counts = new Map();
    for (const item of items) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
    return counts;
  };
  const oracleCounts = countBy(oracle);
  const eventCounts = countBy(events);
  const oracleByKey = new Map(oracle.map((item) => [item.key, item]));
  const offsets = [];
  for (const event of events) {
    if (eventCounts.get(event.key) !== 1 || oracleCounts.get(event.key) !== 1) continue;
    offsets.push(event.t - oracleByKey.get(event.key).t);
  }
  offsets.sort((a, b) => a - b);
  let best = { start: 0, size: 0 };
  for (let i = 0, j = 0; i < offsets.length; i += 1) {
    if (j < i + 1) j = i + 1;
    while (j < offsets.length && offsets[j] - offsets[i] <= clusterMs) j += 1;
    if (j - i > best.size) best = { start: i, size: j - i };
  }
  if (best.size < minSupport) return null;
  return { offset: median(offsets.slice(best.start, best.start + best.size)), support: best.size };
};

/**
 * One-to-one greedy join: within each key, both sides in time order, an event
 * takes the nearest unconsumed oracle record within `tolerance` of its aligned
 * time. Unmatched entries on either side are dropped, not guessed.
 */
export const joinHits = (oracle, events, offset, tolerance = 750) => {
  const byKey = new Map();
  for (const record of oracle) {
    if (!byKey.has(record.key)) byKey.set(record.key, []);
    byKey.get(record.key).push(record);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.t - b.t);
  const cursor = new Map();
  const pairs = [];
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    const candidates = byKey.get(event.key);
    if (candidates === undefined) continue;
    const target = event.t - offset;
    let index = cursor.get(event.key) ?? 0;
    // Consume candidates that fell too far behind — earlier events had their
    // chance at them.
    while (index < candidates.length && candidates[index].t < target - tolerance) index += 1;
    cursor.set(event.key, index);
    const candidate = candidates[index];
    if (candidate === undefined || Math.abs(candidate.t - target) > tolerance) continue;
    cursor.set(event.key, index + 1);
    pairs.push({ oracle: candidate, event });
  }
  return pairs;
};

/** The conditional-channel values of one oracle record, as sorted integer
 * percents. Cap-down terms and foreign vtables are excluded (the latter are
 * surfaced separately — a non-FreeWork channel term would be news). */
export const termPercents = (record) =>
  record.terms
    .filter((term) => term.paramId === PARAM_CAP_UP && term.rva === FREE_WORK_RVA)
    .map((term) => Math.round(term.value * 100))
    .sort((a, b) => a - b);

const countsOf = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

/** value → count present in EVERY hit (the per-value minimum): the stable part
 * of an action's channel, which is all a membership claim may rest on. */
export const stableCounts = (perHitValues) => {
  if (perHitValues.length === 0) return new Map();
  let stable = countsOf(perHitValues[0]);
  for (const values of perHitValues.slice(1)) {
    const counts = countsOf(values);
    const next = new Map();
    for (const [value, count] of stable) {
      const other = counts.get(value) ?? 0;
      if (other > 0) next.set(value, Math.min(count, other));
    }
    stable = next;
  }
  return stable;
};

/** a − b, per value, dropping non-positive counts. */
export const subtractCounts = (a, b) => {
  const result = new Map();
  for (const [value, count] of a) {
    const remaining = count - (b.get(value) ?? 0);
    if (remaining > 0) result.set(value, remaining);
  }
  return result;
};

const countsEqual = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [value, count] of a) if (b.get(value) !== count) return false;
  return true;
};

/**
 * Which unlocked group-only nodes reproduce the residual. Groups fire
 * all-or-nothing (every node scoped to a group applies to every member
 * action), so the search is over subsets of groups, and the answer must be
 * UNIQUE — several fitting subsets, none, or a conditional source sharing a
 * residual value all flag instead of assigning.
 */
export const explainAction = (residual, groupValues, confounderValues) => {
  for (const value of residual.keys()) {
    if (confounderValues.has(value)) return { groups: null, flags: ["confounded-value"] };
  }
  const groups = [...groupValues.keys()];
  const fits = [];
  for (let mask = 0; mask < 1 << groups.length; mask += 1) {
    const union = [];
    for (let bit = 0; bit < groups.length; bit += 1) {
      if (mask & (1 << bit)) union.push(...groupValues.get(groups[bit]));
    }
    if (countsEqual(countsOf(union), residual)) fits.push(groups.filter((_, bit) => mask & (1 << bit)));
  }
  if (fits.length === 1) return { groups: fits[0].sort((a, b) => a - b), flags: [] };
  return {
    groups: null,
    flags: [fits.length === 0 ? "unexplained-residual" : "ambiguous-subset"],
  };
};

const nodeKey = (characterType, id) => `${characterType.toLowerCase()}_${id.toString(16).padStart(4, "0")}`;
const toHashString = (id) => (id ? id.toString(16).padStart(8, "0") : "");
const classOf = (classFlags) => (classFlags & 0x40000 ? "sba" : classFlags & 0x10000 ? "skill" : "normal");
const CLASS_SLOT = { normal: 0, skill: 1, sba: 2 };

/** A cap effect that cannot apply to this class contributes nothing to it —
 * the same rule board.ts's `wrongClass` applies. */
const effectAppliesTo = (effect, capClass) => !(effect.capClass === "skill" && capClass !== "skill");

/** The player's combined trait levels, by the same accumulation utils.ts
 * `computeCombinedTraits` performs (sigils, summons, wrightstone, weapon). */
const combinedTraits = (player) => {
  const totals = new Map();
  const add = (id, level) => {
    if (!id || id === EMPTY_ID || !level || level <= 0) return;
    totals.set(id, (totals.get(id) ?? 0) + level);
  };
  for (const sigil of player.sigils ?? []) {
    if (sigil.sigilId === EMPTY_ID) continue;
    add(sigil.firstTraitId, sigil.firstTraitLevel);
    add(sigil.secondTraitId, sigil.secondTraitLevel);
  }
  for (const summon of player.summons ?? []) add(summon.mainTraitId, summon.mainTraitLevel);
  const wrightstone = player.weaponInfo;
  if (wrightstone) {
    add(wrightstone.trait1Id, wrightstone.trait1Level);
    add(wrightstone.trait2Id, wrightstone.trait2Level);
    add(wrightstone.trait3Id, wrightstone.trait3Level);
  }
  for (const trait of player.weaponState?.innateTraits ?? []) add(trait.id, trait.level);
  return totals;
};

/**
 * Every value a NON-group conditional source could inject into this class's
 * channel: conditional traits at the player's combined level, gated /
 * status-granting / counted board nodes, and Phantasm's per-pet steps. A
 * residual value in this set cannot be attributed to a group without a way to
 * rule the other source out, so it flags.
 */
const confounderValuesFor = (player, characterType, capClass, assets) => {
  const values = new Set();
  const conditional = assets.capUpSources.conditionalTraits ?? {};
  for (const [id, level] of combinedTraits(player)) {
    if (id === PHANTASM_TRAIT) {
      for (let pets = 1; pets <= 4; pets += 1) values.add(PHANTASM_PER_PET * pets);
      continue;
    }
    const rows = conditional[toHashString(id)];
    if (rows === undefined) continue;
    const row = rows[Math.min(level, rows.length) - 1];
    const value = row?.[CLASS_SLOT[capClass]] ?? 0;
    if (value !== 0) values.add(Math.round(value));
  }
  for (const id of player.skillboard ?? []) {
    const node = assets.nodes[nodeKey(characterType, id)];
    for (const effect of node?.effects ?? []) {
      if (effect.stat !== "cap" || !effectAppliesTo(effect, capClass)) continue;
      if (effect.scope === "gated" || effect.scope === "grants-status") {
        if (effect.percent) values.add(Math.round(effect.percent));
      } else if (effect.scope === "counted") {
        const max = effect.maxCount ?? 8;
        for (let count = 1; count <= max; count += 1) values.add(Math.round((effect.percent ?? 0) * count));
      }
    }
  }
  values.delete(0);
  return values;
};

/** group id → the value multiset its unlocked group-only cap nodes fire with. */
const groupValuesFor = (player, characterType, capClass, assets) => {
  const groups = new Map();
  for (const id of player.skillboard ?? []) {
    const node = assets.nodes[nodeKey(characterType, id)];
    for (const effect of node?.effects ?? []) {
      if (effect.stat !== "cap" || effect.scope !== "attack-group") continue;
      if ((effect.abilityIds ?? []).length > 0 || !effectAppliesTo(effect, capClass)) continue;
      const group = effect.targetAttackGroup ?? -1;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(Math.round(effect.percent ?? 0));
    }
  }
  return groups;
};

/** The move-scoped node values the bridge proves active on this action. */
const bridgedValuesFor = (player, characterType, capClass, action, assets) => {
  const source = assets.skillNameSources[characterType]?.[String(action)];
  if (source === undefined || source.ns !== "abilities") return [];
  const values = [];
  for (const id of player.skillboard ?? []) {
    const node = assets.nodes[nodeKey(characterType, id)];
    for (const effect of node?.effects ?? []) {
      if (effect.stat !== "cap" || effect.scope !== "attack-group") continue;
      if (!effectAppliesTo(effect, capClass)) continue;
      if ((effect.abilityIds ?? []).includes(source.hash)) values.push(Math.round(effect.percent ?? 0));
    }
  }
  return values;
};

/**
 * The whole derivation over one oracle extract and one evidence dump.
 * Returns banked-shape assignments plus every flag and skip, because a solver
 * that silently drops what it cannot explain reads as complete when it isn't.
 */
export const solve = (oracleText, evidence, assets, options = {}) => {
  const { tolerance = 750, minHitsPerAction = 2, minJoinRate = 0.5 } = options;
  const records = oracleText
    .split(/\r?\n/)
    .map(parseOracleLine)
    .filter((record) => record !== null);
  for (const record of records) record.key = hitKey(record.action, record.cap, record.rate);
  const sessions = splitSessions(records);

  const assignments = {};
  const flags = [];
  const stats = { logs: [], foreignVtables: new Set() };

  for (const log of evidence.logs) {
    const playersByActor = new Map();
    for (const player of log.players) {
      if (player !== null && player !== undefined) playersByActor.set(player.actorIndex, player);
    }
    const eventHits = log.hits.map((hit) => ({ ...hit, key: hitKey(hit.action, hit.cap, hit.rate) }));

    // The session whose offset JOINS the most hits wins the log. The join
    // rate is the acceptance test, not the vote count: a short fight can have
    // only two uniquely-keyed hits to vote with, yet the right offset joins
    // every hit, while a wrong one joins next to nothing against keys this
    // sharp. A log the capture never saw is reported, not force-joined.
    let best = null;
    for (const session of sessions) {
      const aligned = alignOffset(session, eventHits, { minSupport: 2 });
      if (aligned === null) continue;
      const pairs = joinHits(session, eventHits, aligned.offset, tolerance);
      if (best === null || pairs.length > best.pairs.length) best = { aligned, pairs };
    }
    if (best === null || best.pairs.length < eventHits.length * minJoinRate) {
      stats.logs.push({ id: log.id, aligned: false });
      continue;
    }
    const pairs = best.pairs;
    stats.logs.push({
      id: log.id,
      aligned: true,
      offset: best.aligned.offset,
      support: best.aligned.support,
      joined: pairs.length,
      events: eventHits.length,
    });

    // (character, class, action) → per-hit percent arrays.
    const perAction = new Map();
    for (const { oracle, event } of pairs) {
      if (event.summon) continue;
      const player = playersByActor.get(event.actor);
      if (player === undefined || typeof player.characterType !== "string") continue;
      for (const term of oracle.terms) {
        if (term.paramId === PARAM_CAP_UP && term.rva !== FREE_WORK_RVA) {
          stats.foreignVtables.add(term.rva);
        }
      }
      const capClass = classOf(oracle.classFlags);
      const key = `${player.characterType}|${capClass}`;
      if (!perAction.has(key)) perAction.set(key, new Map());
      const actions = perAction.get(key);
      if (!actions.has(event.action)) actions.set(event.action, { player, hits: [] });
      actions.get(event.action).hits.push(termPercents(oracle));
    }

    for (const [key, actions] of perAction) {
      const [characterType, capClass] = key.split("|");
      const character = characterType.toLowerCase();

      const stables = new Map();
      for (const [action, { hits }] of actions) {
        if (hits.length < minHitsPerAction) {
          flags.push({ log: log.id, character, action, capClass, flag: "too-few-hits", hits: hits.length });
          continue;
        }
        stables.set(action, stableCounts(hits));
      }
      // One action tells nothing apart from itself: the baseline IS its
      // stable set and every residual is empty.
      if (stables.size < 2) continue;

      const allValues = new Set();
      for (const stable of stables.values()) for (const value of stable.keys()) allValues.add(value);
      const baseline = new Map();
      for (const value of allValues) {
        const minimum = Math.min(...[...stables.values()].map((stable) => stable.get(value) ?? 0));
        if (minimum > 0) baseline.set(value, minimum);
      }

      for (const [action, stable] of stables) {
        const { player } = actions.get(action);
        const bridged = bridgedValuesFor(player, characterType, capClass, action, assets);
        const residual = subtractCounts(subtractCounts(stable, baseline), countsOf(bridged));
        if (residual.size === 0) continue;
        const groupValues = groupValuesFor(player, characterType, capClass, assets);
        const confounders = confounderValuesFor(player, characterType, capClass, assets);
        const { groups, flags: actionFlags } = explainAction(residual, groupValues, confounders);
        if (groups === null) {
          for (const flag of actionFlags) {
            flags.push({ log: log.id, character, action, capClass, flag, residual: [...residual] });
          }
          continue;
        }
        for (const group of groups) {
          assignments[character] ??= {};
          assignments[character][group] ??= new Set();
          assignments[character][group].add(action);
        }
      }
    }
  }

  const plain = {};
  for (const [character, groups] of Object.entries(assignments)) {
    plain[character] = {};
    for (const [group, actionIds] of Object.entries(groups)) {
      plain[character][group] = [...actionIds].sort((a, b) => a - b);
    }
  }
  stats.foreignVtables = [...stats.foreignVtables].map((rva) => `0x${rva.toString(16)}`);
  return { assignments: plain, flags, stats };
};

/**
 * Merges solved memberships into the coverage asset. Existing action lists are
 * unioned (evidence accumulates across sessions) and their tags kept; status
 * and neededGroups are recomputed by the generator's own buildCoverage, so the
 * two writers can never disagree about what "derived" means.
 */
export const bank = (coverage, nodes, assignments, evidenceTag) => {
  const merged = structuredClone(coverage.characters);
  for (const [character, groups] of Object.entries(assignments)) {
    merged[character] ??= { status: "underived", neededGroups: [], groups: {} };
    for (const [group, actionIds] of Object.entries(groups)) {
      const existing = merged[character].groups[group];
      const union = [...new Set([...(existing?.actionIds ?? []), ...actionIds])].sort((a, b) => a - b);
      const evidence =
        existing === undefined || existing.evidence === evidenceTag
          ? evidenceTag
          : `${existing.evidence}; ${evidenceTag}`;
      merged[character].groups[group] = { actionIds: union, evidence };
    }
  }
  return { version: coverage.version, characters: buildCoverage(groupNeedsOf(nodes), merged) };
};

const main = () => {
  const args = process.argv.slice(2);
  const readArg = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const oraclePath = readArg("--oracle");
  const evidencePath = readArg("--evidence");
  if (!oraclePath || !evidencePath) {
    console.error("usage: node scripts/solve-attack-groups.mjs --oracle <file> --evidence <file> [--write]");
    process.exit(2);
  }

  const assets = {
    nodes: JSON.parse(readFileSync(path.join(ROOT, "src", "assets", "skillboard-cap-sources.json"), "utf8")).nodes,
    skillNameSources: JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "assets", "skill-name-sources.json"), "utf8")),
    capUpSources: JSON.parse(readFileSync(path.join(ROOT, "src", "assets", "cap-up-sources.json"), "utf8")),
  };
  const oracleText = readFileSync(oraclePath, "utf8");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));

  const { assignments, flags, stats } = solve(oracleText, evidence, assets, {
    minSupport: Number(readArg("--min-support") ?? 5),
  });

  for (const log of stats.logs) {
    console.log(
      log.aligned
        ? `log ${log.id}: offset ${log.offset}ms (support ${log.support}), joined ${log.joined}/${log.events} hits`
        : `log ${log.id}: NO ALIGNMENT — capture does not cover this log`
    );
  }
  if (stats.foreignVtables.length > 0) {
    console.log(`NOTE: cap-up terms on non-FreeWork vtables (excluded): ${stats.foreignVtables.join(", ")}`);
  }
  console.log(`\nassignments:`);
  for (const [character, groups] of Object.entries(assignments)) {
    for (const [group, actionIds] of Object.entries(groups)) {
      console.log(`  ${character} group ${group}: actions [${actionIds.join(", ")}]`);
    }
  }
  if (Object.keys(assignments).length === 0) console.log("  (none)");
  console.log(`\nflags (${flags.length}):`);
  for (const flag of flags.slice(0, 40)) console.log(`  ${JSON.stringify(flag)}`);
  if (flags.length > 40) console.log(`  ... ${flags.length - 40} more`);

  if (args.includes("--write") && Object.keys(assignments).length > 0) {
    const coveragePath = path.join(ROOT, "src", "assets", "attack-group-coverage.json");
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
    const logIds = evidence.logs.map((log) => log.id).join(",");
    const banked = bank(coverage, assets.nodes, assignments, `caporacle join, logs ${logIds}`);
    writeFileSync(coveragePath, `${JSON.stringify(banked, null, 2)}\n`);
    console.log(`\nbanked into ${coveragePath}`);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
