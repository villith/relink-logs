#!/usr/bin/env node
/**
 * Generates src/assets/skillboard-cap-sources.json — what the master trait
 * board grants the damage cap, per node, FROM THE GAME'S OWN TABLES.
 *
 * The previous version of this file ran regexes over the English node text in
 * `src-tauri/lang/en/skillboard.json`. That was wrong twice over: the board's
 * effects are data, not prose, and prose cannot yield an id — a node scoped to
 * one move produced the string "Dead Lands" where the game stores an ability
 * hash, and a node gated on a debuff produced "While inflicted with Poison"
 * where the game stores a status. Both are now numeric ids.
 *
 * ## The join, proved
 *
 *   skillboard_layout.EffectUiId   the id the hook emits per unlocked node
 *                                  (`PlayerData.skillboard`), int at +0x74
 *     + skillboard_layout.CharacterId                       -> the node key
 *   skillboard_layout.SkillboardEffectOrUiId (+0x48)
 *     -> skillboard_effect.Key (+0x34)                      2895/2895 resolve
 *   skillboard_effect.SkillboardEffectActionPartsId1..3 (+0x20..+0x28)
 *     -> skillboard_effect_action_parts.Key (+0x48)         2901 rows, 0 misses
 *
 * Proof that this is the SAME node the UI names: for 2894 of 2895 rows the
 * effect row's EXPL text id (+0x48) equals the `key` the shipped
 * `lang/en/skillboard.json` carries for `<character>_<uiId hex>` — the one
 * exception (pl1200_0017) has a junk id in the table itself. Every run then
 * re-checks the decode against that text (see [`verifyAgainstText`]) and fails
 * if a node it priced says nothing about the cap.
 *
 * ## The columns, decoded
 *
 * `skillboard_effect.Unk21` is the EFFECT KIND, and it is the gate that makes
 * everything below safe:
 *   5   plain, data-driven node   (2126 nodes; MainSkillboardEffectType is
 *                                  always 0 and the parts ARE the effect)
 *   6   character keystone ("SP") node
 *   7,8 keystone rank-up node (Insight / Essence / Crux Rank)
 *   9   the "Summon Cost -1" EX node
 *   10  the "Summon Cost +1" EX node
 * Kinds 6-8 carry a non-zero `MainSkillboardEffectType` naming one of nine
 * hardcoded per-character effects; their Value columns hold the magnitudes but
 * WHICH slot means what is in the exe, not the tables. Kinds 9/10 carry a
 * cap-shaped payload the engine repurposes — the game's own text for those two
 * nodes says nothing about the damage cap, so reading their `SubType 1` as a
 * cap-up (as a text-blind decode would) invents 57 sources that do not exist.
 * Only kind 5 is read as data here; everything else is reported, never guessed.
 *
 * Within a kind-5 part:
 *   MainType    0  a self stat            2  scoped to a subset of attacks
 *               1  a self stat x a count  3  grants a status
 *               4  modifies a status granted by an ability
 *   SubType     the stat inside MainType 0/1/2: 1 = DMG Cap, 9 = Chain Burst
 *               DMG Cap, 0 = ATK, 2 = DEF, 3 = Skill Cooldown, 8 = DMG Dealt...
 *   Value1..10  the magnitudes. The node's own EXPL template indexes them
 *               0-based across the CONCATENATION of its parts' ten slots —
 *               "Infinito Creare: DMG Cap +{0}% / Cooldown +{10}%" reads
 *               part 0 slot 0 then part 1 slot 0. That is what pins Value1 as
 *               the magnitude of a single-effect part.
 *   ConditionBehavior  0 always on, 1 grants a status on a trigger,
 *                      2 active while a gate holds, 3 scales with a count
 *   Conditional        which gate/trigger/count, read against the behavior
 *   TargetAttackGroup  10 = the ability or ability group in AbilityId1 (all 298
 *                      such parts carry one: 226 resolve in ability.tbl, 72 in
 *                      ability_group.tbl, and ability.tbl holds only the 16
 *                      equippable SKILLS per character). Every other value is a
 *                      per-character attack group — 8 is "Combo Finishers" for
 *                      one character and 2 for another — so no class is claimed
 *                      for it; the raw group id is emitted instead.
 *   StatusId / StatusId2  status.tbl keys. StatusId is what MainType 3 grants;
 *                      StatusId2 is the gate of `ConditionBehavior 2 /
 *                      Conditional 1`. Both are re-keyed to status.tbl's
 *                      decimal `StatusId`, which is what the hook emits.
 *
 * No board node has a Skybound Art cap-up (nor a normal-attack-only one that
 * says so): the only class the tables prove is `skill`, via TargetAttackGroup
 * 10. `capClass` is `"all"`, `"skill"`, or null — never a guess.
 *
 * ## Running it
 *
 *   GBFRDataTools.exe extract -i <game>/data.i -f system/table/skillboard_layout.tbl -o <tmp>
 *   ...also skillboard_effect, skillboard_effect_action_parts,
 *      skillboard_unlock, status
 *   node scripts/gen-skillboard-cap-sources.mjs <tmp>/system/table
 *
 * The .tbl files are read RAW rather than through GBFRDataTools' sqlite export,
 * because a `.headers` file that has drifted from the live table misaligns
 * every column after the drift point SILENTLY. Each table asserts
 * `8 + rowCount * rowSize === fileLength` before reading a byte; all five hold
 * on v2.0.4. Raw reading also keeps hash columns as the u32s they are, which is
 * the whole point of this rewrite.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gameXxhash32 } from "./gbfr-hash.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "src", "assets", "skillboard-cap-sources.json");
/** English node text. Read ONLY to check the decode after the fact, never as a
 * lookup path — see [`verifyAgainstText`]. */
const LANG_PATH = join(ROOT, "src-tauri", "lang", "en", "skillboard.json");

/** The game version the row layouts below were derived and checked against. */
export const GAME_VERSION = "2.0.4";

/** Bytes per row, and the offsets this reads, per table. A row size that no
 * longer divides the file is a hard failure: it means the layout moved, and
 * every offset below would then read a neighbouring column. */
export const TABLES = {
  layout: { file: "skillboard_layout.tbl", rowSize: 140 },
  effect: { file: "skillboard_effect.tbl", rowSize: 100 },
  parts: { file: "skillboard_effect_action_parts.tbl", rowSize: 136 },
  unlock: { file: "skillboard_unlock.tbl", rowSize: 32 },
  status: { file: "status.tbl", rowSize: 140 },
};

/** Row count and row base offsets for one raw .tbl. */
export const readRows = (buffer, rowSize, name) => {
  const rowCount = Number(buffer.readBigInt64LE(0));
  if (rowCount < 0 || 8 + rowCount * rowSize !== buffer.length) {
    throw new Error(
      `${name}: ${buffer.length} bytes is not 8 + ${rowCount} x ${rowSize} — ` +
        "the row layout moved, re-derive the offsets before trusting any column"
    );
  }
  return { rowCount, offsetOf: (index) => 8 + index * rowSize };
};

/** `skillboard_effect.Unk21`: which engine path reads the node's parts. */
export const EFFECT_KIND_PLAIN = 5;

/** `MainType` — what the part's value applies to. */
export const MAIN_TYPE = { self: 0, counted: 1, attackScoped: 2, grantsStatus: 3, statusModifier: 4 };

/** `SubType` inside MainType 0/1/2 — which stat. */
export const SUB_TYPE = { damageCap: 1, chainBurstCap: 9 };

/** `ConditionBehavior` — how the value is delivered. */
export const CONDITION_BEHAVIOR = { always: 0, grantsStatus: 1, gated: 2, counted: 3 };

/** `TargetAttackGroup` 10 means "the ability (or ability group) in AbilityId1",
 * and ability.tbl holds only the equippable skills — so, the skill class. */
export const TARGET_GROUP_ABILITY = 10;

/** `Conditional` under `ConditionBehavior 3`: which thing is being counted. */
export const COUNT_KIND = {
  0: "basic-sigil",
  1: "attack-sigil",
  2: "defense-support-sigil",
  3: "quest-counter",
};

/** `Conditional` under `ConditionBehavior 2`: which gate. Only `1` names its
 * subject in a column (StatusId2); the rest are per-character engine states
 * with no table row, and are emitted as their raw id rather than as prose. */
export const GATE_STATUS = 1;

/** status.tbl key of `dmglimitup` (DMG Cap↑), the buff a MainType 3 part can
 * grant. Its decimal StatusId (56 on v2.0.4) is resolved from the table, not
 * pinned — only the key hash is, because a hash is an identity and a row id is
 * not. */
export const CAP_UP_STATUS_HASH = 0x64103e42;

/** What an EMPTY hash_string column holds: the hash of the empty string, not
 * zero and not -1. A decode that filters on 0 instead silently treats 0x887ae0b0
 * as a real id and then fails to resolve it. */
const HASH_NONE = Number.parseInt(gameXxhash32(""), 16);

/** Id hash (8-digit hex, as `gameXxhash32` returns it) -> character code, for
 * the 29 boards plus room for new ones. Built by hashing, so a character added
 * by a game update needs no edit here beyond the range. */
export const CHARACTER_BY_HASH = (() => {
  const byHash = new Map();
  for (let index = 0; index <= 40; index += 1) {
    const code = `PL${index.toString().padStart(2, "0")}00`;
    byHash.set(gameXxhash32(code), code.toLowerCase());
  }
  return byHash;
})();

/**
 * The cap effect one kind-5 part describes, or `null` when it is not a cap-up.
 *
 * `part` is the decoded row; see the header for what each field means. The
 * caller has already established that the owning node is EffectKind 5, which is
 * what makes `SubType` readable as a stat at all.
 */
export const classifyPart = (part, statusIdByHash = new Map()) => {
  const {
    mainType,
    subType,
    conditional,
    conditionBehavior,
    targetAttackGroup,
    abilityIds,
    statusId,
    statusId2,
    values,
  } = part;

  // A status grant: the magnitude is the buff's strength, the buff itself is a
  // status id, and whether it is up is runtime state the log alone cannot say.
  if (mainType === MAIN_TYPE.grantsStatus) {
    if (statusId !== CAP_UP_STATUS_HASH) return null;
    return {
      stat: "cap",
      scope: "grants-status",
      capClass: null,
      percent: values[0],
      durationSeconds: values[1] || null,
      grantsStatusId: statusIdByHash.get(statusId) ?? null,
      grantsStatusHash: hex(statusId),
    };
  }

  if (mainType !== MAIN_TYPE.self && mainType !== MAIN_TYPE.counted && mainType !== MAIN_TYPE.attackScoped) {
    return null;
  }
  // SubType is an index into MainType's own stat list, so the same number means
  // different things across them: 9 is the Chain Burst cap for a self stat and
  // Elemental ATK for an attack-scoped one.
  const chainBurst = subType === SUB_TYPE.chainBurstCap && mainType === MAIN_TYPE.self;
  if (subType !== SUB_TYPE.damageCap && !chainBurst) return null;

  const stat = chainBurst ? "chain-burst-cap" : "cap";

  // Scaled by a count. Value1 is the per-unit grant and Value2 the count the
  // game stops at — except for the per-quest counters, whose only stated number
  // is the ceiling in Value4.
  if (conditionBehavior === CONDITION_BEHAVIOR.counted) {
    const countKind = COUNT_KIND[conditional] ?? null;
    if (countKind === "quest-counter") {
      return { stat, scope: "counted", capClass: "all", countKind, percent: values[3], perUnit: values[1] };
    }
    return {
      stat,
      scope: "counted",
      capClass: "all",
      countKind,
      percent: values[0],
      maxCount: values[1] || null,
    };
  }

  const scoped = mainType === MAIN_TYPE.attackScoped;
  const base = {
    stat,
    percent: values[0],
    capClass: scoped ? (targetAttackGroup === TARGET_GROUP_ABILITY ? "skill" : null) : "all",
  };
  const attack = scoped ? { targetAttackGroup, abilityIds: abilityIds.map(hex) } : {};

  // Gated on runtime state. `Conditional 1` names a status; every other gate is
  // a per-character engine state, kept as its raw id so a caller can at least
  // tell two different gates apart.
  if (conditionBehavior === CONDITION_BEHAVIOR.gated) {
    const gate =
      conditional === GATE_STATUS
        ? { gateKind: "status", gateStatusId: statusIdByHash.get(statusId2) ?? null, gateStatusHash: hex(statusId2) }
        : { gateKind: "engine-state", gateState: conditional };
    return { ...base, scope: "gated", ...gate, ...attack };
  }

  if (conditionBehavior !== CONDITION_BEHAVIOR.always) return null;
  return { ...base, scope: scoped ? "attack-group" : "always", ...attack };
};

const hex = (value) => (value === HASH_NONE ? null : value.toString(16).padStart(8, "0"));

/** Every row of skillboard_effect_action_parts, by its key hash. */
export const readParts = (buffer) => {
  const { rowCount, offsetOf } = readRows(buffer, TABLES.parts.rowSize, TABLES.parts.file);
  const byKey = new Map();
  for (let index = 0; index < rowCount; index += 1) {
    const at = offsetOf(index);
    const values = [];
    for (let slot = 0; slot < 10; slot += 1) values.push(buffer.readFloatLE(at + 0x20 + slot * 4));
    byKey.set(buffer.readUInt32LE(at + 0x48), {
      values,
      statusId: buffer.readUInt32LE(at + 0x54),
      statusId2: buffer.readUInt32LE(at + 0x5c),
      abilityIds: [buffer.readUInt32LE(at + 0x58), buffer.readUInt32LE(at + 0x60), buffer.readUInt32LE(at + 0x64)]
        .filter((id) => id !== HASH_NONE)
        .filter((id, position, all) => all.indexOf(id) === position),
      subType: buffer.readInt32LE(at + 0x68),
      conditional: buffer.readInt32LE(at + 0x6c),
      conditionBehavior: buffer.readInt32LE(at + 0x70),
      specialEffect: buffer.readInt32LE(at + 0x74),
      mainType: buffer.readInt32LE(at + 0x7c),
      targetAttackGroup: buffer.readInt32LE(at + 0x80),
    });
  }
  return byKey;
};

/** Every row of skillboard_effect, by its key hash. */
export const readEffects = (buffer) => {
  const { rowCount, offsetOf } = readRows(buffer, TABLES.effect.rowSize, TABLES.effect.file);
  const byKey = new Map();
  for (let index = 0; index < rowCount; index += 1) {
    const at = offsetOf(index);
    byKey.set(buffer.readUInt32LE(at + 0x34), {
      partKeys: [buffer.readUInt32LE(at + 0x20), buffer.readUInt32LE(at + 0x24), buffer.readUInt32LE(at + 0x28)].filter(
        (key) => key !== HASH_NONE
      ),
      explainId: buffer.readUInt32LE(at + 0x48),
      kind: buffer.readInt32LE(at + 0x50),
    });
  }
  return byKey;
};

/** status.tbl key hash -> the decimal StatusId the runtime (and the hook) uses. */
export const readStatusIds = (buffer) => {
  const { rowCount, offsetOf } = readRows(buffer, TABLES.status.rowSize, TABLES.status.file);
  const byHash = new Map();
  for (let index = 0; index < rowCount; index += 1) {
    const at = offsetOf(index);
    byHash.set(buffer.readUInt32LE(at + 0x60), buffer.readUInt32LE(at + 0x7c));
  }
  return byHash;
};

/**
 * The cap-up the board grants for reaching a master level, cumulative.
 *
 * The one genuinely per-level dimension the board has: nodes are unlocked, not
 * levelled, but `skillboard_unlock` adds a flat DmgCapAdd at ten of the fifty
 * master levels (+100% in total at level 50). Index = master level, so
 * `masterLevelCap[lvl]` is what a player at that level carries.
 */
export const readMasterLevelCap = (buffer) => {
  const { rowCount, offsetOf } = readRows(buffer, TABLES.unlock.rowSize, TABLES.unlock.file);
  const perLevel = new Map();
  let top = 0;
  for (let index = 0; index < rowCount; index += 1) {
    const at = offsetOf(index);
    const level = buffer.readInt32LE(at + 0x10);
    perLevel.set(level, buffer.readInt32LE(at + 0x1c));
    top = Math.max(top, level);
  }
  const cumulative = [0];
  for (let level = 1; level <= top; level += 1) {
    cumulative.push(cumulative[level - 1] + (perLevel.get(level) ?? 0));
  }
  return cumulative;
};

/**
 * Every board node that touches the damage cap, plus every node whose effect
 * the engine defines rather than the tables.
 *
 * A node is never dropped for being hard: an unattributed source that the
 * breakdown does not even name reads as "complete but wrong", which is the one
 * failure mode this whole file exists to avoid.
 */
export const buildNodes = ({ layoutBuffer, effectBuffer, partsBuffer, statusIdByHash }) => {
  const effects = readEffects(effectBuffer);
  const parts = readParts(partsBuffer);
  const { rowCount, offsetOf } = readRows(layoutBuffer, TABLES.layout.rowSize, TABLES.layout.file);

  const nodes = {};
  const engineDefined = {};
  const unknownCharacters = new Set();
  let missingEffects = 0;
  let missingParts = 0;
  const explainIdByKey = {};

  for (let index = 0; index < rowCount; index += 1) {
    const at = offsetOf(index);
    const characterHash = hex(buffer32(layoutBuffer, at + 0x58));
    const character = CHARACTER_BY_HASH.get(characterHash);
    if (character === undefined) {
      unknownCharacters.add(characterHash);
      continue;
    }
    const uiId = layoutBuffer.readInt32LE(at + 0x74);
    const key = `${character}_${uiId.toString(16).padStart(4, "0")}`;

    const effect = effects.get(buffer32(layoutBuffer, at + 0x48));
    if (effect === undefined) {
      missingEffects += 1;
      continue;
    }
    explainIdByKey[key] = effect.explainId;

    const rows = effect.partKeys.map((partKey) => parts.get(partKey));
    if (rows.includes(undefined)) missingParts += 1;

    if (effect.kind !== EFFECT_KIND_PLAIN) {
      // The engine, not the table, decides what these Values mean. Reported
      // with everything the table DOES say, so a reader can see there is an
      // effect here without the model pretending to have priced it.
      engineDefined[key] = {
        effectKind: effect.kind,
        specialEffects: rows.filter(Boolean).map((row) => row.specialEffect),
        values: rows.filter(Boolean).map((row) => row.values.filter((value) => value !== 0)),
      };
      continue;
    }

    const capEffects = rows
      .filter(Boolean)
      .map((row) => classifyPart(row, statusIdByHash))
      .filter((effectRow) => effectRow !== null);
    if (capEffects.length > 0) nodes[key] = { effects: capEffects };
  }

  return { nodes, engineDefined, explainIdByKey, unknownCharacters, missingEffects, missingParts };
};

const buffer32 = (buffer, at) => buffer.readUInt32LE(at);

const sortedByKey = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Cross-checks the decode against the game's own English node text.
 *
 * The text is ground truth for a check, never a lookup: a column that has
 * shifted still produces a plausible-looking number, and only the text can say
 * the number is now attached to the wrong node. Returns the disagreements
 * rather than throwing, so the caller decides how loud to be.
 */
export const verifyAgainstText = (nodes, engineDefined, lang) => {
  const mentionsCap = (key) => (lang[key]?.text ?? "").includes("DMG Cap");
  const falsePositives = Object.keys(nodes).filter((key) => !mentionsCap(key));
  const missed = Object.keys(lang).filter(
    (key) => mentionsCap(key) && nodes[key] === undefined && engineDefined[key] === undefined
  );
  const capMentions = Object.keys(lang).filter(mentionsCap).length;
  return { falsePositives, missed, capMentions };
};

const main = () => {
  const tableDir = process.argv[2];
  if (!tableDir) {
    console.error(`usage: ${process.argv[1]} <dir with the extracted system/table/*.tbl>`);
    process.exit(2);
  }
  const read = (name) => readFileSync(resolve(tableDir, TABLES[name].file));

  const statusIdByHash = readStatusIds(read("status"));
  const built = buildNodes({
    layoutBuffer: read("layout"),
    effectBuffer: read("effect"),
    partsBuffer: read("parts"),
    statusIdByHash,
  });
  const masterLevelCap = readMasterLevelCap(read("unlock"));

  const out = {
    version: GAME_VERSION,
    masterLevelCap,
    nodes: sortedByKey(built.nodes),
    engineDefined: sortedByKey(built.engineDefined),
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  const lang = JSON.parse(readFileSync(LANG_PATH, "utf8"));
  const { falsePositives, missed, capMentions } = verifyAgainstText(built.nodes, built.engineDefined, lang);

  const byScope = {};
  for (const node of Object.values(built.nodes)) {
    for (const effect of node.effects) byScope[effect.scope] = (byScope[effect.scope] ?? 0) + 1;
  }
  console.log(
    `${Object.keys(built.nodes).length} cap nodes (${Object.entries(byScope)
      .sort()
      .map(([scope, count]) => `${count} ${scope}`)
      .join(", ")}), ` +
      `${Object.keys(built.engineDefined).length} engine-defined, ` +
      `master level 50 = +${masterLevelCap[masterLevelCap.length - 1]}% -> ${OUT_PATH}`
  );
  console.log(
    `verify: ${capMentions} nodes mention DMG Cap; ${missed.length} of them are neither classified nor ` +
      `reported; ${falsePositives.length} classified nodes say nothing about the cap`
  );
  if (built.unknownCharacters.size > 0) {
    console.log(`WARN: unknown character hashes: ${[...built.unknownCharacters].join(", ")}`);
  }
  if (built.missingEffects > 0 || built.missingParts > 0) {
    console.log(`WARN: ${built.missingEffects} unresolved effects, ${built.missingParts} unresolved part rows`);
  }
  if (falsePositives.length > 0) {
    console.error(`FAIL: classified nodes whose own text has no cap: ${falsePositives.slice(0, 10).join(", ")}`);
    process.exit(1);
  }
};

// Only when run as a script — the decode is imported by the test. Compared as
// resolved PATHS rather than as URLs, which is what clean-target.mjs does:
// string-building a file:// URL from the Windows argv path drops a slash and
// the comparison then silently never matches.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
