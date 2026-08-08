/**
 * Builds `src/assets/game-icons/` from a finished atlas extraction.
 *
 * Inputs are the per-sprite PNGs cut by `scripts/slice-atlas.mjs` (under
 * `icon-export/sliced/`) and the game tables converted to SQLite (at
 * `icon-export/raw/tables.sqlite`) — see src/assets/game-icons/README.md for
 * the full pipeline that produces both. This script selects, renames, maps
 * and palette-quantizes (256 colours roughly halves the painted 128² art
 * with no visible cost; the lossless originals stay in icon-export). It
 * rebuilds each family from scratch, so re-running it is always safe.
 *
 * What it emits, and why each family is keyed the way it is:
 *
 * - `status/<IconFileNameId>.png` + `status-map.json` — the map goes
 *   statusId → icon file name, because several statuses share one icon
 *   (every stack level of a buff, its `_01`+ level variants aside) and the
 *   frontend's currency is the numeric statusId. Only the `_00` variant
 *   ships; the level variants stay in icon-export until something needs them.
 *
 * - `ability/pl####_##.png` + `ability-map.json` — the sprites are keyed by
 *   character id + ability slot (the sprite names and `ability.tbl` keys,
 *   `AB_PL####_NN`, agree), and the map goes characterType → actionId →
 *   icon file name, bridging the meter's per-character ACTION ids to ability
 *   art. The bridge is built from two independent streams of game data —
 *   see `buildAbilityMap` below for the derivation and its two gotchas.
 *
 * - `sigil/NN_MM[_plus|_ex01...].png` — the five gem shape series × tier
 *   sprites. gem.tbl does not carry an icon column (the shape choice lives in
 *   skill.tbl, which GBFRDataTools cannot parse at 2.0.3), so these ship
 *   under their sprite naming convention rather than behind a fabricated
 *   sigilId map.
 *
 *   node scripts/gen-game-icons.mjs
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

import { abilitySlotsOf, actionNameKey } from "./ability-actions.mjs";
import { msgDecode } from "./msg-decode.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SLICED = path.join(ROOT, "icon-export", "sliced");
const TABLES = path.join(ROOT, "icon-export", "raw", "tables.sqlite");
const OUT = path.join(ROOT, "src", "assets", "game-icons");

/** Rebuild the maps against the sprites already shipped, leaving the PNGs
 * alone. For fixing a MAP — a new edge in `buildAbilityMap`, a table that
 * moved — where re-quantizing 500 unchanged sprites only risks churning them
 * through whatever `sharp` is installed today. A full run still needs the
 * atlas extraction; this one needs only `tables.sqlite` and the msg files. */
const MAPS_ONLY = process.argv.includes("--maps-only");

const db = new DatabaseSync(TABLES, { readOnly: true });

/** Emits the sliced sprites whose name matches, renamed by the capture
 * group and palette-quantized, replacing whatever the family directory held
 * before. */
const emitFamily = async (family, sliceDir, pattern) => {
  if (MAPS_ONLY) {
    const kept = (await readdir(path.join(OUT, family))).length;
    console.log(`${family}: ${kept} icons (kept, --maps-only)`);
    return kept;
  }
  const outDir = path.join(OUT, family);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const files = (await readdir(path.join(SLICED, sliceDir))).sort();
  let count = 0;
  for (const file of files) {
    const m = pattern.exec(file);
    if (!m) continue;
    await sharp(path.join(SLICED, sliceDir, file))
      .png({ palette: true, quality: 90 })
      .toFile(path.join(outDir, `${m[1]}.png`));
    count++;
  }
  console.log(`${family}: ${count} icons`);
  return count;
};

// -- status: files named by IconFileNameId, plus the statusId -> file map.
await emitFamily("status", "status", /^cmn_icstts_(.+)_00\.png$/);
const statusRows = db
  .prepare("SELECT StatusId, IconFileNameId FROM status WHERE IconFileNameId != '' ORDER BY StatusId")
  .all();
const statusFiles = new Set(await readdir(path.join(OUT, "status")));
const statusMap = {};
for (const row of statusRows) {
  if (!statusFiles.has(`${row.IconFileNameId}.png`)) {
    // status.tbl can point at a sprite the atlas no longer carries (rcv_005
    // does today); a map entry with no file would break the frontend's
    // "every map entry resolves" invariant, so it is dropped loudly instead.
    console.warn(`  status ${row.StatusId}: no sprite for ${row.IconFileNameId}, omitting`);
    continue;
  }
  statusMap[row.StatusId] = row.IconFileNameId;
}
await writeFile(path.join(OUT, "status-map.json"), JSON.stringify(statusMap, null, 2) + "\n");
console.log(`status-map.json: ${Object.keys(statusMap).length} status ids`);

// -- ability: sprite name is already characterId_slot; frames excluded.
await emitFamily("ability", "ability", /^cmn_icablt_(pl\d{4}_\d{2})\.png$/);

// ---------------------------------------------------------------------------
// ability-map.json: characterType -> actionId -> icon file name.
//
// The meter's currency is per-character ACTION ids (the damage/cause id
// space); ability art is keyed by ability SLOT. The game ships the edge in
// `system/player/data/pl####/pl####_action.msg`, whose ActionInfo rows carry
// an action `id_` plus three fields that between them say which ability it
// belongs to — see `ability-actions.mjs`, which owns that reading and its
// precedence (`relatedAbilityType_` over `abilityTag_`, plus a `derivedId_`
// walk for the untagged variants).
//
// Two more streams fill what the action rows cannot answer:
//
//   1. An action whose ordinal names a slot the character has no ability.tbl
//      row for. Id's dragonform claims a sixth (Ragnarok Form) against five
//      PL2000 rows, because that art lives under his human form. Joined by
//      the action's own name across every character's rows, ambiguity
//      resolved toward the character's own art and skipped when it cannot be.
//   2. Actions that are not in `<char>_action.msg` AT ALL, yet are named in
//      ui.json `skills.<Char>` (Io's Concentration, 11000). Those are joined
//      by curated English name to the ability names in
//      `system/table/text/en/text.msg` (`TXT_AB_PL####_NN`).
//
// Every stream then resolves slot -> icon through ability.tbl's IconFileName,
// which is NOT the identity map: upgraded ability entries reuse base icons
// (AB_PL2100_13 -> 2100_02) and Id's dragonform slots scatter (AB_PL2000_02
// -> 2000_05, AB_PL2000_05 -> 1900_06), so skipping the tbl hop attaches
// wrong art silently.
// ---------------------------------------------------------------------------

const buildAbilityMap = async () => {
  const iconOfTag = new Map();
  for (const r of db.prepare("SELECT Key, IconFileName FROM ability WHERE IconFileName != ''").all())
    iconOfTag.set(r.Key, r.IconFileName);

  // TXT_AB_<char>_<slot> in text.msg carries a name row and a description row
  // under the same key; the name is the shorter of the two.
  const textBuf = await readFile(path.join(ROOT, "icon-export", "raw", "system", "table", "text", "en", "text.msg"));
  const textStr = textBuf.toString("latin1");
  const norm = (t) =>
    t
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’']/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  const nameOfSlot = new Map();
  const keyRe = /TXT_AB_(PL\d{4})_(\d{2})(?![\w])/g;
  let km;
  while ((km = keyRe.exec(textStr)) !== null) {
    const t = textStr.indexOf("text_", keyRe.lastIndex);
    if (t === -1) continue;
    let p = t + 5;
    const b0 = textBuf[p];
    let len;
    if (b0 >= 0xa0 && b0 <= 0xbf) (len = b0 - 0xa0), (p += 1);
    else if (b0 === 0xd9) (len = textBuf[p + 1]), (p += 2);
    else continue;
    const text = textBuf.slice(p, p + len).toString("utf8");
    const k = `${km[1]}|${km[2]}`;
    if (!nameOfSlot.has(k) || nameOfSlot.get(k).length > text.length) nameOfSlot.set(k, text);
  }
  const slotOfName = new Map();
  for (const [k, text] of nameOfSlot) {
    const [ch, slot] = k.split("|");
    const nk = `${ch}|${norm(text)}`;
    if (!slotOfName.has(nk)) slotOfName.set(nk, slot);
  }

  const iconOfSlot = (plUpper, slot) => iconOfTag.get(`AB_${plUpper}_${slot}`);

  const ui = JSON.parse(await readFile(path.join(ROOT, "src-tauri", "lang", "en", "ui.json"), "utf8"));
  const abilityFiles = new Set(await readdir(path.join(OUT, "ability")));
  const chars = Object.keys(ui.skills).filter((char) => /^Pl\d{4}$/.test(char));

  // Pass 1: decode each character's action rows and read the slot each action
  // belongs to. Held rather than emitted, because the name index below has to
  // see EVERY character before any one of them can fall back to it.
  const perChar = new Map();
  for (const char of chars) {
    const plLower = char.toLowerCase();
    let rows = null;
    for (const caseDir of ["data", "Data"]) {
      const p = path.join(ROOT, "icon-export", "raw", "system", "player", caseDir, plLower, `${plLower}_action.msg`);
      try {
        rows = [...msgDecode(await readFile(p))]
          .filter(([key]) => key === "ActionInfo")
          .map(([, value]) => Object.fromEntries(value));
        break;
      } catch {
        continue;
      }
    }
    if (rows === null) continue;
    perChar.set(char, { rows, slots: abilitySlotsOf(rows) });
  }

  // The cross-character name index (stream 1 above), built only from actions
  // whose slot DOES resolve — an unresolved action cannot vouch for a name.
  // A name that reaches two different icons is kept with both, and the pick
  // below prefers the looking character's own art; where neither matches and
  // the name is ambiguous it resolves to nothing rather than to a coin flip.
  const iconsOfActionName = new Map();
  for (const [char, { rows, slots }] of perChar) {
    const plUpper = char.replace(/^Pl/, "PL");
    for (const row of rows) {
      const slot = slots.get(Number(row.id_));
      const icon = slot === undefined ? undefined : iconOfSlot(plUpper, slot);
      const key = actionNameKey(row.actionName_);
      if (icon === undefined || key === "") continue;
      if (!iconsOfActionName.has(key)) iconsOfActionName.set(key, new Set());
      iconsOfActionName.get(key).add(icon);
    }
  }
  const iconByActionName = (char, name) => {
    const icons = [...(iconsOfActionName.get(actionNameKey(name)) ?? [])];
    const own = icons.find((icon) => icon.startsWith(`${char.replace(/^Pl/, "")}_`));
    return own ?? (icons.length === 1 ? icons[0] : undefined);
  };

  const result = {};
  let total = 0;
  for (const char of chars) {
    const plUpper = char.replace(/^Pl/, "PL");
    const map = {};

    // The action rows themselves, and the name fallback for the slots this
    // character has no ability row for.
    const { rows = [], slots = new Map() } = perChar.get(char) ?? {};
    const nameOf = new Map(rows.map((row) => [Number(row.id_), row.actionName_]));
    for (const [action, slot] of slots) {
      const icon = iconOfSlot(plUpper, slot) ?? iconByActionName(char, nameOf.get(action));
      if (icon) map[action] = icon;
    }

    // The curated-English join, for the actions the action rows never mention.
    // It does not override what the game data already answered — that ordering
    // is what retires the junk-tag adjudication this join used to carry, since
    // `relatedAbilityType_` now names the right ability outright.
    for (const [id, name] of Object.entries(ui.skills[char])) {
      if (!/^\d+$/.test(id) || map[id] !== undefined) continue;
      const full = norm(String(name));
      const base = norm(String(name).replace(/\s*\([^)]*\)\s*$/, ""));
      const slot = slotOfName.get(`${plUpper}|${full}`) ?? slotOfName.get(`${plUpper}|${base}`);
      if (!slot) continue;
      const icon = iconOfSlot(plUpper, slot);
      if (icon) map[id] = icon;
    }

    for (const [action, icon] of Object.entries(map))
      if (!abilityFiles.has(`pl${icon}.png`)) {
        console.warn(`  ${char} ${action}: icon pl${icon}.png missing from the sliced set, omitting`);
        delete map[action];
      }

    if (Object.keys(map).length > 0) {
      result[char] = map;
      total += Object.keys(map).length;
    }
  }
  await writeFile(path.join(OUT, "ability-map.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`ability-map.json: ${total} actions across ${Object.keys(result).length} characters`);
};
await buildAbilityMap();

// -- sigil: the shape-series gems only, not the 4-digit weapon icons that
// share the equip atlas.
await emitFamily("sigil", "equip", /^cmn_icequ_(\d{2}_\d{2}(?:_[a-z0-9_]+)?)\.png$/);

// -- enemy: the em-numbered portraits packed into the SUMMON atlas — summons
// in Relink are the primal-beast bosses, so their equip-screen portraits are
// enemy portraits for the boss roster. Base form (`_00_00`) only; the `_01`+
// variants are alternate forms the meter cannot tell apart anyway. Keyed by
// the em id, which is what `enemies.json` rows carry as `key` (`EM0610`).
await emitFamily("enemy", "summon", /^(em\d{4})_00_00\.png$/);
const enemyLang = JSON.parse(await readFile(path.join(ROOT, "src-tauri", "lang", "en", "enemies.json"), "utf8"));
const enemyFiles = new Set(await readdir(path.join(OUT, "enemy")));
const emRows = Object.values(enemyLang).filter((row) => /^EM\d{4}$/.test(row.key ?? ""));
const covered = emRows.filter((row) => enemyFiles.has(`${row.key.toLowerCase()}.png`));
console.log(`enemy coverage: ${covered.length} of ${emRows.length} named enemies have a portrait`);

// Sanity: every statuses.json id the app knows should resolve, so a patch
// that renames icon ids is caught here and not in production.
const lang = JSON.parse(await readFile(path.join(ROOT, "src-tauri", "lang", "en", "statuses.json"), "utf8"));
const unmapped = Object.keys(lang).filter((id) => !statusMap[id]);
if (unmapped.length > 0) console.warn(`statuses.json ids with no icon: ${unmapped.join(", ")}`);
else console.log(`all ${Object.keys(lang).length} statuses.json ids have an icon`);
