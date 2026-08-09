#!/usr/bin/env node
/**
 * Generates src/assets/ap-tree-cap-sources.json — what the four AP trees grant
 * the damage cap, per node, FROM THE GAME'S OWN TABLES.
 *
 * These are the "Mastery / Collection" terms the cap breakdown has so far only
 * been able to name. Their VALUES are solved here. Their INPUT — which nodes a
 * player unlocked — is still not on the log, so the panel keeps reporting them
 * as unknown; what this file adds is a real `potential` per owner in place of a
 * hardcoded zero, and the per-node table a future hook capture can price
 * against.
 *
 * ## The join, proved
 *
 *   ap_tree_*.LimitBonusId (+0x48)
 *     -> limit_bonus.Key (+0x34)                        0 unresolved, all four trees
 *   limit_bonus.ParamId1..3 (+0x24..+0x2c)
 *     -> limit_bonus_param.Key (+0x34)                  a bonus grants 1-3 params
 *   ap_tree_*.LimitBonusParamIndex (+0x5c)
 *     -> which of the param's ten value slots THIS node takes
 *
 * `LimitBonusParamIndex` is a slot index, not a level. Proof: in
 * `ap_tree_rebuild` one bonus row is shared by several weapons, and each weapon's
 * node carries a different index into the same param's ten slots (weapon
 * ac65075c takes slots 0 and 1, weapon cf9c4808 slots 2 and 3, at different MSP
 * costs). Reading the index as a level would give every weapon the same number.
 *
 * ## Which type ids are the damage cap
 *
 * `limit_bonus_param`'s type id is at row **+0x48**, NOT where the shipped
 * `.headers` puts it — the header list is one column short, so its
 * `LimitBonusParamTypeId` lands on +0x44, which is -1 in all 1123 rows. The
 * column at +0x48 has the game's own text attached, and that text is what names
 * these four (checked on every run by [`verifyAgainstText`]):
 *
 *   103  "Normal Attack Damage Cap +{0}%"   -> capClass "normal"
 *   104  "Skill Damage Cap +{0}%"           -> capClass "skill"
 *   105  "Skybound Art Damage Cap +{0}%"    -> capClass "sba"
 *   106  "Damage Cap +{0}%"                 -> capClass "all"
 *
 * 107 is the HEALING cap ("Healing Cap (Receiving)") and is deliberately not in
 * the set: a text-blind decode that took every id in the 100..110 band would add
 * a healing term to a damage number.
 *
 * ## The four trees do not share an owner, and that is the point
 *
 *   ap_tree_atk      per CHARACTER   29 characters, WeaponId empty on all rows
 *   ap_tree_def      per CHARACTER   29 characters, WeaponId empty on all rows
 *   ap_tree_wep      per WEAPON      160 weapons
 *   ap_tree_rebuild  per WEAPON      160 weapons
 *
 * Summing all four into one "Mastery" number would price every weapon a
 * character owns at once. They are emitted under separate owners so a caller
 * can add the character's two trees to the EQUIPPED weapon's two, and nothing
 * else.
 *
 * ## Running it
 *
 *   GBFRDataTools.exe extract -i <game>/data.i -f system/table/ap_tree_atk.tbl -o <tmp>
 *   ...also ap_tree_def, ap_tree_wep, ap_tree_rebuild, limit_bonus,
 *      limit_bonus_param, text/en/text_limit_bonus.msg
 *   node scripts/gen-ap-tree-cap-sources.mjs <tmp>/system/table
 *
 * The .tbl files are read RAW rather than through GBFRDataTools' sqlite export,
 * for the reason the header note above gives: a `.headers` file that has drifted
 * from the live table misaligns every column after the drift point SILENTLY, and
 * this table's headers HAVE drifted. Each table asserts
 * `8 + rowCount * rowSize === fileLength` before reading a byte.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gameXxhash32 } from "./gbfr-hash.mjs";
import { msgDecode } from "./msg-decode.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "src", "assets", "ap-tree-cap-sources.json");

/** The game version the row layouts below were derived and checked against. */
export const GAME_VERSION = "2.0.4";

/** Bytes per row per table. A row size that no longer divides the file is a hard
 * failure: it means the layout moved, and every offset below would then read a
 * neighbouring column. All four AP trees share one layout. */
export const TABLES = {
  atk: { file: "ap_tree_atk.tbl", rowSize: 140, owner: "character" },
  def: { file: "ap_tree_def.tbl", rowSize: 140, owner: "character" },
  wep: { file: "ap_tree_wep.tbl", rowSize: 140, owner: "weapon" },
  rebuild: { file: "ap_tree_rebuild.tbl", rowSize: 140, owner: "weapon" },
  bonus: { file: "limit_bonus.tbl", rowSize: 100 },
  param: { file: "limit_bonus_param.tbl", rowSize: 84 },
};

/** The columns this reads out of one ap_tree row. */
export const AP_TREE = {
  weaponId: 0x3c,
  limitBonusId: 0x48,
  key: 0x4c,
  charaId: 0x58,
  paramIndex: 0x5c,
  mspCost: 0x60,
};

/** `limit_bonus_param`'s type id -> the attack class its cap applies to. 107,
 * the healing cap, is absent on purpose. */
export const CAP_CLASS_BY_TYPE = { 103: "normal", 104: "skill", 105: "sba", 106: "all" };

/** What the game's own text for each cap type must contain. The decode is
 * checked against this every run; a type id that has been repurposed by a patch
 * fails the build rather than quietly repricing the panel. */
export const CAP_TYPE_TEXT = {
  103: "Normal Attack Damage Cap",
  104: "Skill Damage Cap",
  105: "Skybound Art Damage Cap",
  106: "Damage Cap",
};

/** What an EMPTY hash_string column holds: the hash of the empty string, not
 * zero and not -1. */
const HASH_NONE = Number.parseInt(gameXxhash32(""), 16);

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

const hex = (value) => value.toString(16).padStart(8, "0");

/** Id hash -> character code, built by hashing rather than by a hand-written
 * table, so a character added by a game update needs no edit here. */
export const CHARACTER_BY_HASH = (() => {
  const byHash = new Map();
  for (let index = 0; index <= 40; index += 1) {
    const code = `PL${index.toString().padStart(2, "0")}00`;
    byHash.set(Number.parseInt(gameXxhash32(code), 16), code.toLowerCase());
  }
  return byHash;
})();

/** Every `limit_bonus_param` row, by its key hash. */
export const readParams = (buffer) => {
  const { rowCount, offsetOf } = readRows(buffer, TABLES.param.rowSize, TABLES.param.file);
  const byKey = new Map();
  for (let index = 0; index < rowCount; index += 1) {
    const at = offsetOf(index);
    const values = [];
    for (let slot = 0; slot < 10; slot += 1) values.push(buffer.readFloatLE(at + 0x0c + slot * 4));
    byKey.set(buffer.readUInt32LE(at + 0x34), {
      values,
      nameFormatId: buffer.readUInt32LE(at + 0x3c),
      typeId: buffer.readInt32LE(at + 0x48),
    });
  }
  return byKey;
};

/** Every `limit_bonus` row, by its key hash. */
export const readBonuses = (buffer) => {
  const { rowCount, offsetOf } = readRows(buffer, TABLES.bonus.rowSize, TABLES.bonus.file);
  const byKey = new Map();
  for (let index = 0; index < rowCount; index += 1) {
    const at = offsetOf(index);
    byKey.set(buffer.readUInt32LE(at + 0x34), {
      paramKeys: [0x24, 0x28, 0x2c]
        .map((column) => buffer.readUInt32LE(at + column))
        .filter((key) => key !== HASH_NONE),
      titleId: buffer.readUInt32LE(at + 0x44),
    });
  }
  return byKey;
};

/** Text id hash -> the English string, across the given .msg files. */
export const readText = (buffers) => {
  const byHash = new Map();
  for (const buffer of buffers) {
    const rows = msgDecode(buffer).find(([key]) => key === "rows_")?.[1] ?? [];
    for (const row of rows) {
      const column = row.find(([key]) => key === "column_")?.[1] ?? [];
      const id = column.find(([key]) => key === "id_hash_")?.[1];
      const text = column.find(([key]) => key === "text_")?.[1];
      if (typeof id === "string") byHash.set(Number.parseInt(gameXxhash32(id), 16), text);
    }
  }
  return byHash;
};

/**
 * The cap effects one AP-tree node grants, or `[]` when it grants none.
 *
 * A node names a `limit_bonus`, which names up to three `limit_bonus_param`s;
 * each param that is a cap type contributes its value at the node's slot index.
 * A node whose bonus does not resolve is an unresolved JOIN, not an absence, so
 * it is counted and reported rather than dropped silently.
 */
export const capEffectsOf = (node, bonuses, params) => {
  const bonus = bonuses.get(node.limitBonusId);
  if (bonus === undefined) return null;
  const effects = [];
  for (const paramKey of bonus.paramKeys) {
    const param = params.get(paramKey);
    if (param === undefined) continue;
    const capClass = CAP_CLASS_BY_TYPE[param.typeId];
    if (capClass === undefined) continue;
    const percent = param.values[node.paramIndex] ?? 0;
    // A resolved cap param whose slot holds nothing is a real row of the game's
    // that grants nothing here — kept out of the list rather than emitted as +0,
    // which would read as a node the player can unlock for no gain.
    if (percent === 0) continue;
    effects.push({ capClass, percent });
  }
  return effects;
};

/**
 * Every cap-granting node of every AP tree, grouped by the thing that owns the
 * tree — a character for atk/def, a weapon for wep/rebuild.
 *
 * Keyed by the node's own `Key` hash, which is what a hook capture of unlocked
 * nodes would carry.
 */
export const buildTrees = ({ buffers, bonuses, params }) => {
  const owners = { character: {}, weapon: {} };
  let unresolvedBonuses = 0;
  const unknownCharacters = new Set();

  for (const [tree, spec] of Object.entries(TABLES)) {
    if (spec.owner === undefined) continue;
    const buffer = buffers[tree];
    const { rowCount, offsetOf } = readRows(buffer, spec.rowSize, spec.file);
    for (let index = 0; index < rowCount; index += 1) {
      const at = offsetOf(index);
      const node = {
        key: buffer.readUInt32LE(at + AP_TREE.key),
        limitBonusId: buffer.readUInt32LE(at + AP_TREE.limitBonusId),
        paramIndex: buffer.readUInt32LE(at + AP_TREE.paramIndex),
        charaId: buffer.readUInt32LE(at + AP_TREE.charaId),
        weaponId: buffer.readUInt32LE(at + AP_TREE.weaponId),
      };
      const effects = capEffectsOf(node, bonuses, params);
      if (effects === null) {
        if (node.limitBonusId !== HASH_NONE) unresolvedBonuses += 1;
        continue;
      }
      if (effects.length === 0) continue;

      let ownerKey;
      if (spec.owner === "character") {
        ownerKey = CHARACTER_BY_HASH.get(node.charaId);
        if (ownerKey === undefined) {
          unknownCharacters.add(hex(node.charaId));
          continue;
        }
      } else {
        if (node.weaponId === HASH_NONE) continue;
        ownerKey = hex(node.weaponId);
      }

      const bucket = (owners[spec.owner][ownerKey] ??= {});
      (bucket[tree] ??= []).push({ key: hex(node.key), effects });
    }
  }

  return { owners, unresolvedBonuses, unknownCharacters };
};

/**
 * Per owner, the cap a fully completed set of trees would grant, by class.
 *
 * This is a CEILING, not a player's number. It exists so the breakdown can name
 * what an unresolved Mastery row is worth at most, which is strictly more than
 * the zero it reports today and strictly less than a claim about this player.
 */
export const potentialsOf = (owners) => {
  const out = {};
  for (const [ownerKey, trees] of Object.entries(owners)) {
    const total = {};
    for (const nodes of Object.values(trees)) {
      for (const node of nodes) {
        for (const effect of node.effects) total[effect.capClass] = (total[effect.capClass] ?? 0) + effect.percent;
      }
    }
    out[ownerKey] = total;
  }
  return out;
};

/**
 * Cross-checks the type-id decode against the game's own English text.
 *
 * The text is ground truth for a check, never a lookup: a type id that a patch
 * repurposes still yields a plausible number, and only the text can say the
 * number is now a healing cap. Returns the disagreements rather than throwing,
 * so the caller decides how loud to be.
 *
 * A row whose name-format id resolves to no string is SILENT, not wrong — a
 * handful of cap rows carry an id the shipped text does not define, and failing
 * on those would mean the check could never pass. What must hold is that every
 * cap type has at least one row the text DOES name, and that no named row
 * disagrees.
 */
export const verifyAgainstText = (params, text) => {
  const mismatches = [];
  const confirmed = new Set();
  for (const param of params.values()) {
    const expected = CAP_TYPE_TEXT[param.typeId];
    if (expected === undefined) continue;
    const actual = text.get(param.nameFormatId);
    if (typeof actual !== "string") continue;
    // startsWith, not includes: every one of the four formats leads with its own
    // label, and "Damage Cap" (106) is a substring of the other three — an
    // `includes` check would let a mislabelled 106 row confirm itself off
    // "Skill Damage Cap".
    if (actual.startsWith(expected)) confirmed.add(param.typeId);
    else mismatches.push({ typeId: param.typeId, expected, actual });
  }
  const unconfirmedTypes = Object.keys(CAP_TYPE_TEXT)
    .map(Number)
    .filter((typeId) => !confirmed.has(typeId));
  return { mismatches, unconfirmedTypes };
};

const sortedByKey = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

const main = () => {
  const tableDir = process.argv[2];
  if (!tableDir) {
    console.error(`usage: ${process.argv[1]} <dir with the extracted system/table/*.tbl>`);
    process.exit(2);
  }
  const read = (name) => readFileSync(resolve(tableDir, TABLES[name].file));

  const params = readParams(read("param"));
  const bonuses = readBonuses(read("bonus"));
  const built = buildTrees({
    buffers: { atk: read("atk"), def: read("def"), wep: read("wep"), rebuild: read("rebuild") },
    bonuses,
    params,
  });

  const out = {
    version: GAME_VERSION,
    capClassByTypeId: CAP_CLASS_BY_TYPE,
    character: sortedByKey(built.owners.character),
    weapon: sortedByKey(built.owners.weapon),
    characterPotential: sortedByKey(potentialsOf(built.owners.character)),
    weaponPotential: sortedByKey(potentialsOf(built.owners.weapon)),
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  const text = readText([
    readFileSync(resolve(tableDir, "text", "en", "text_limit_bonus.msg")),
    readFileSync(resolve(tableDir, "text", "en", "text.msg")),
  ]);
  const { mismatches, unconfirmedTypes } = verifyAgainstText(params, text);

  const count = (owner) => Object.values(owner).reduce((sum, trees) => sum + Object.values(trees).flat().length, 0);
  console.log(
    `${count(built.owners.character)} cap nodes across ${Object.keys(built.owners.character).length} characters, ` +
      `${count(built.owners.weapon)} across ${Object.keys(built.owners.weapon).length} weapons -> ${OUT_PATH}`
  );
  const sample = Object.entries(out.characterPotential)[0];
  if (sample) console.log(`potential (${sample[0]}, both character trees complete): ${JSON.stringify(sample[1])}`);
  console.log(
    `verify: ${mismatches.length} named rows whose text disagrees, ` +
      `${unconfirmedTypes.length} cap type(s) the text never confirms`
  );

  if (built.unknownCharacters.size > 0) {
    console.log(`WARN: unknown character hashes: ${[...built.unknownCharacters].join(", ")}`);
  }
  if (built.unresolvedBonuses > 0) {
    console.log(`WARN: ${built.unresolvedBonuses} nodes name a limit_bonus that does not resolve`);
  }
  if (mismatches.length > 0 || unconfirmedTypes.length > 0) {
    console.error(
      `FAIL: cap type ids no longer match the game's text: ` +
        `${mismatches
          .slice(0, 5)
          .map((m) => `${m.typeId} expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.actual)}`)
          .join("; ")}` +
        `${unconfirmedTypes.length > 0 ? `; no named row confirms type(s) ${unconfirmedTypes.join(", ")}` : ""}`
    );
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
