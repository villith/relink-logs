/**
 * Emits src-tauri/lang/<lang>/enemy-attacks.json from the game's
 * text_battle.msg bundles in the local icon-export/ dump: the boss cast-bar
 * callout names, keyed EM#### -> callout ordinal -> text. The ordinal is the
 * <n> of TXT_BT_<em>_<n>; the edge from the hook's action ids to these
 * ordinals lives separately in src-tauri/assets/enemy-attack-map.json, because
 * the game reaches the ordinal through the enemy's FSM state rather than
 * through any action-id table (see the 2026-08-04 enemy-attack-names plan's
 * discovery log) — so that half cannot be generated from game data.
 *
 * Usage: node scripts/gen-enemy-attack-names.mjs
 * Reads: icon-export/raw/system/table/text/<code>/text_battle.msg
 * Writes: src-tauri/lang/<app-lang>/enemy-attacks.json (one per language found)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { msgDecode } from "./msg-decode.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Archive language code -> app lang dir (identity where omitted). */
const LANG_MAP = { cs: "zh-CN", ct: "zh-TW" };
const ARCHIVE_LANGS = ["bp", "cs", "ct", "en", "es", "fr", "ge", "it", "jp", "ko"];

const BT_KEY = /^TXT_BT_(\d{4})_(\d+)$/;

/** Flattens msgDecode's tree to its column rows. */
export const flattenRows = (tree) => {
  const out = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (node.length === 1 && Array.isArray(node[0]) && node[0][0] === "column_") {
      out.push(Object.fromEntries(node[0][1]));
      return;
    }
    node.forEach(walk);
  };
  walk(tree);
  return out;
};

/** TXT_BT rows -> { EM7000: { 1: "Skyfall", ... }, ... }.
 *
 * A row with no text is dropped rather than emitted blank: the frontend's
 * fallback is "Attack N", which says more than an empty callout would. */
export const bundleFromRows = (rows) => {
  const bundle = {};
  for (const row of rows) {
    const match = BT_KEY.exec(row.id_hash_ ?? "");
    if (match === null) continue;
    const text = row.text_ ?? "";
    if (text === "") continue;
    (bundle[`EM${match[1]}`] ??= {})[Number(match[2])] = text;
  }
  return bundle;
};

const main = () => {
  let wrote = 0;
  for (const code of ARCHIVE_LANGS) {
    const source = path.join(ROOT, "icon-export", "raw", "system", "table", "text", code, "text_battle.msg");
    if (!existsSync(source)) {
      console.warn(`[gen] missing ${source} — extract it first (see the plan / game-icons README)`);
      continue;
    }
    const bundle = bundleFromRows(flattenRows(msgDecode(readFileSync(source))));
    const lang = LANG_MAP[code] ?? code;
    const target = path.join(ROOT, "src-tauri", "lang", lang, "enemy-attacks.json");
    writeFileSync(target, JSON.stringify(bundle, null, 2) + "\n");
    console.log(`[gen] ${target}: ${Object.keys(bundle).length} enemies`);
    wrote += 1;
  }
  if (wrote === 0) process.exit(1);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
