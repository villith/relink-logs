#!/usr/bin/env node
/**
 * Generates src/assets/skillboard-cap-sources.json — the damage-cap magnitudes
 * the master trait board grants, per node.
 *
 * The board was the largest unattributed slice of a hit's cap-up, and it did
 * not have to be. `PlayerData.skillboard` carries the ids of the nodes a player
 * has unlocked, and the game's own node text carries what each one does
 * ("DMG Cap +35%", "Dead Lands: DMG Cap +45%"). Joining the two turns the board
 * from a caveat into a line item.
 *
 * The source is `src-tauri/lang/en/skillboard.json`, which is itself generated
 * on a game update — so this runs after that, with no game extraction of its
 * own:
 *
 *     node scripts/gen-skillboard-cap-sources.mjs
 *
 * ENGLISH ONLY, deliberately. The node text is localized and the classification
 * is not: parsing whichever language happened to be installed would produce a
 * different asset per machine. Every player reads the same magnitudes.
 *
 * Output shape:
 *   {
 *     "nodes":    { "pl0000_000c": { percent, capClass, scope, ... } },
 *     "unparsed": { "pl0000_0000": "<the node's text>" }
 *   }
 *
 * A node this cannot classify goes to `unparsed` WITH ITS TEXT rather than
 * being dropped. A dropped node is silent under-counting: the breakdown would
 * read as complete while quietly missing a source. An unparsed one shows up as
 * a named factor the model admits it cannot value.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src-tauri", "lang", "en", "skillboard.json");
const OUT_PATH = join(ROOT, "src", "assets", "skillboard-cap-sources.json");

/** The class prefix the game writes in front of "DMG Cap", to our own names.
 * A bare "DMG Cap" raises all three. */
const CLASS_BY_PREFIX = {
  "": "all",
  "Normal Attack ": "normal",
  "Skill ": "skill",
  "Skybound Art ": "sba",
};

const CLASS_PREFIX = "(?:Normal Attack |Skill |Skybound Art )?";

/** `DMG Cap +35%`, optionally class-prefixed, and nothing else. */
const FLAT = new RegExp(`^(${CLASS_PREFIX})DMG Cap \\+(\\d+)%$`);

/** The one countable rule on the board: a flat percent per equipped sigil of a
 * type, with the game stating its own ceiling on the count. */
const SIGIL_COUNT = /^DMG Cap \+(\d+)% per Basic Stats-type sigil equipped \(max sigils: (\d+)\)$/;

/** `Dead Lands: DMG Cap +45%` — a move, then what it gains. The label is capped
 * short so a sentence with a colon in it cannot masquerade as a move name. */
const ACTION_COLON = new RegExp(`^(.{1,40}?)\\s*:\\s*(${CLASS_PREFIX})DMG Cap \\+(\\d+)%$`);

/** `Chain Burst DMG Cap +40%` — the same thing written without the colon. */
const ACTION_BARE = new RegExp(`^(.{1,40}?) (${CLASS_PREFIX})DMG Cap \\+(\\d+)%$`);

/** A gate, then what passing it grants. */
const CONDITIONAL = new RegExp(`^((?:While|When|Whenever|During|Upon|After|At) .{1,80}?)\\s*:\\s*(${CLASS_PREFIX})DMG Cap \\+(\\d+)%$`);

/** `Crux Rank :`, `Insight Rank :`, `Essence Rank :` — which awakening rank a
 * node belongs to, not what it does. An unlocked node has its rank. */
const RANK_PREFIX = /^\S+ Rank\s*:\s*/;

/** An unresolved table reference the text never substituted. */
const PLACEHOLDER = /\{\d+\}/;

const CAP_MENTION = /DMG Cap/g;
const CAP_MAGNITUDE = /DMG Cap\s*\+\d+%/g;

/** Everything on one line, and the game's own spacing quirks smoothed out. */
const normalize = (text) => text.replace(/\s+/g, " ").trim();

const matched = (percent, capClass, extra) => ({ percent: Number(percent), capClass, ...extra });

/**
 * What one node grants the damage cap, or `null` when it grants nothing.
 *
 * Returns `{ scope: "unparsed" }` for a node that clearly DOES raise the cap
 * but whose text this cannot reduce to one magnitude and one scope — the
 * caller keeps it, with its text, rather than dropping it.
 */
export const classifyNode = (raw) => {
  const text = normalize(raw);
  if (!text.includes("DMG Cap")) return null;

  // Two magnitudes in one node means a per-stack or per-grade table, and
  // picking one of them would be picking arbitrarily.
  if (PLACEHOLDER.test(text)) return { scope: "unparsed" };
  if ((text.match(CAP_MAGNITUDE) ?? []).length > 1) return { scope: "unparsed" };

  // The rank prefix says which awakening rank owns the node, not what it does;
  // an unlocked node has already met it.
  const body = text.replace(RANK_PREFIX, "");

  const sigils = SIGIL_COUNT.exec(body);
  if (sigils !== null) {
    return matched(sigils[1], "all", { scope: "sigil-count", maxCount: Number(sigils[2]) });
  }

  const flat = FLAT.exec(body);
  if (flat !== null) return matched(flat[2], CLASS_BY_PREFIX[flat[1]], { scope: "always" });

  // Conditional before action: "While X: DMG Cap +N%" also matches the
  // move-scoped shape, and a gate is the more specific reading.
  const gated = CONDITIONAL.exec(body);
  if (gated !== null) {
    return matched(gated[3], CLASS_BY_PREFIX[gated[2]], { scope: "conditional", condition: gated[1] });
  }

  const colon = ACTION_COLON.exec(body);
  if (colon !== null) {
    return matched(colon[3], CLASS_BY_PREFIX[colon[2]], { scope: "action", label: colon[1] });
  }

  const bare = ACTION_BARE.exec(body);
  if (bare !== null) {
    return matched(bare[3], CLASS_BY_PREFIX[bare[2]], { scope: "action", label: bare[1] });
  }

  // It raises the cap — the text says so — but not in a shape this understands.
  if ((text.match(CAP_MENTION) ?? []).length > 0) return { scope: "unparsed" };
  return null;
};

const main = () => {
  const bundle = JSON.parse(readFileSync(SOURCE, "utf8"));
  const nodes = {};
  const unparsed = {};
  const counts = { always: 0, "sigil-count": 0, action: 0, conditional: 0, unparsed: 0 };

  for (const [key, entry] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
    const classified = classifyNode(entry.text);
    if (classified === null) continue;
    counts[classified.scope] += 1;
    if (classified.scope === "unparsed") unparsed[key] = normalize(entry.text);
    else nodes[key] = classified;
  }

  writeFileSync(OUT_PATH, `${JSON.stringify({ nodes, unparsed }, null, 2)}\n`, "utf8");
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(
    `${total} cap nodes: ${counts.always} flat, ${counts["sigil-count"]} per-sigil, ` +
      `${counts.action} move-scoped, ${counts.conditional} conditional, ${counts.unparsed} unparsed -> ${OUT_PATH}`
  );
};

// Only when run as a script — the classifier is imported by the test.
// Compared as resolved PATHS rather than as URLs, which is what clean-target.mjs
// does: string-building a file:// URL from the Windows argv path drops a slash
// and the comparison then silently never matches.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
