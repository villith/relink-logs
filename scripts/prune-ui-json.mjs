/**
 * One-shot pruner for src-tauri/lang/<lang>/ui.json.
 *
 * Deletes, in every language that ships a ui.json:
 *   - `sigils`, `traits`, and `quest` except `quest.unknown` — verified unread.
 *     Every live lookup goes to the generated namespaces (traits:<hash>.text,
 *     quests:<hash>.text); nothing in src/ reads a `sigils.`, `traits.` or
 *     `quest.<id>` ui-namespace key. They predate those namespaces.
 *   - `characters` entries that duplicate characters.json. translateCharacterType
 *     already prefers `characters:<type>`.
 *   - `enemies.unknown` entries already in enemies.json, which shadows them.
 *   - `skills` leaves the bridge map now resolves.
 *
 * Kept in `characters`: Pl2000, Unknown, ai — no generated equivalent.
 * Kept in `skills.summon-classes`: Silverslime/Goldslime — hand-coined, in no
 * game lang file.
 *
 * Run once: node scripts/prune-ui-json.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANG_DIR = path.join(ROOT, "src-tauri", "lang");
const SOURCES = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "assets", "skill-name-sources.json"), "utf8"));

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

for (const lang of ["en", "bp", "es", "fr", "ge", "it", "jp", "ko", "zh-CN", "zh-TW"]) {
  const uiFile = path.join(LANG_DIR, lang, "ui.json");
  const ui = readJson(uiFile);
  if (ui === null) {
    console.log(`${lang}: no ui.json, skipping`);
    continue;
  }

  const before = JSON.stringify(ui).length;
  const removed = { sigils: 0, traits: 0, quest: 0, characters: 0, enemies: 0, skills: 0 };

  for (const block of ["sigils", "traits"]) {
    removed[block] = Object.keys(ui[block] ?? {}).length;
    delete ui[block];
  }

  if (ui.quest !== undefined) {
    const unknown = ui.quest.unknown;
    removed.quest = Object.keys(ui.quest).length - (unknown === undefined ? 0 : 1);
    ui.quest = unknown === undefined ? {} : { unknown };
  }

  const characters = readJson(path.join(LANG_DIR, lang, "characters.json")) ?? {};
  for (const key of Object.keys(ui.characters ?? {})) {
    if (characters[key] !== undefined) {
      delete ui.characters[key];
      removed.characters += 1;
    }
  }

  const enemies = readJson(path.join(LANG_DIR, lang, "enemies.json")) ?? {};
  for (const hash of Object.keys(ui.enemies?.unknown ?? {})) {
    if (enemies[hash] !== undefined) {
      delete ui.enemies.unknown[hash];
      removed.enemies += 1;
    }
  }

  for (const [block, entries] of Object.entries(SOURCES)) {
    for (const id of Object.keys(entries)) {
      if (ui.skills?.[block]?.[id] !== undefined) {
        delete ui.skills[block][id];
        removed.skills += 1;
      }
    }
    if (ui.skills?.[block] !== undefined && Object.keys(ui.skills[block]).length === 0) delete ui.skills[block];
  }

  writeFileSync(uiFile, `${JSON.stringify(ui, null, 2)}\n`, "utf8");

  const after = JSON.stringify(ui).length;
  console.log(`${lang}: ${before} -> ${after} bytes | removed ${JSON.stringify(removed)}`);
}
