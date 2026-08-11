#!/usr/bin/env node
/**
 * Banks attack-group memberships from the BUTTON MAP — Scott's per-family
 * left/right assignments in src/assets/action-button-map.json — into
 * src/assets/attack-group-coverage.json, alongside the oracle-derived entries.
 *
 * ## The reading, and where each part is anchored
 *
 * - The twin "Attacks" groups are the two input buttons (attack-group-icons:
 *   group 0 renders icon 4 / left, group 1 icon 3 / right, on every
 *   character). A button's Attacks group gets every action assigned to that
 *   button — INCLUDING its charge mechanics (Percival's oracle data has his
 *   Schlacht in both his right-Attacks and Charged groups) — EXCEPT actions
 *   whose own name matches one of the character's word-named groups (Tweyen's
 *   Power Finishers demonstrably sit outside her unlocked Attacks/Charged
 *   groups while a "Power Finishers" group exists to claim them).
 * - "Charged Attacks" groups get the charge families of their icon's side,
 *   minus charged FINISHERS (Tweyen's per-hit counts cap those at one group,
 *   and which one is unresolved).
 * - Word-named groups ("Multilock Hail", "Grade II Shots", "Stomp Attacks"…)
 *   match per-action names from ui.json — the same names the meter shows —
 *   with roman numerals normalized and generic words dropped. Button is
 *   irrelevant to them.
 *
 * Everything banked here is tagged `manual:button-map` (plus `inferred` where
 * the button came from pattern-inference rather than an explicit answer), so
 * oracle-derived evidence stays distinguishable and future captures can audit
 * these entries. Unresolved families and unmatched groups are printed, never
 * guessed.
 *
 * The ENGINE layer (src/assets/action-input-map.json, from the combo-branch
 * graph — see gen-action-input-map.py) overrides the family button per
 * action, per Scott's 2026-08-10 ruling; such contributions are tagged
 * `engine:action-branch`. Family buttons still decide the engine-silent
 * actions (charge releases, stance entries, the launcher).
 *
 * Run: node scripts/gen-attack-groups-from-buttons.mjs [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bank } from "./solve-attack-groups.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const ATTACK_ICON_LEFT = 4;
const ATTACK_ICON_RIGHT = 3;

/** Family-name patterns that identify a CHARGE mechanic — the same set the
 * button map's inference rules treat as a character's charge/special. */
const CHARGE_FAMILY =
  /^(charged string|power strike|power raise|schlacht|collapse \(|enhanced collapse|heavy swing|lunge|stargaze|oathsworn|pactstrike|noble stance|stiller glanz|grade \d shot|yellow power strike|sharpened focus)/i;

/** Words in a group phrase that carry no identity ("Attacks" would match
 * every basic swing; "DMG"/"Cap" are the stat, not the mechanic). */
const GENERIC_WORDS = new Set([
  "dmg",
  "cap",
  "attack",
  "attacks",
  "gains",
  "gain",
  "upon",
  "with",
  "by",
  "a",
  "the",
  "and",
  "or",
  "per",
]);

const ROMAN = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6" };

const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ROMAN[word] ?? word)
    .map((word) => (word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word));

/** The identifying words of a word-named group's phrase (text before the
 * colon), or null when nothing identifying remains. */
const phraseWords = (text) => {
  const phrase = text.split(":")[0];
  const words = normalize(phrase)
    .filter((word) => !GENERIC_WORDS.has(word))
    // Percent magnitudes leak into colon-less texts ("Turbine DMG Cap +35%");
    // grade/tier numerals (1-9) are identity, big numbers are values.
    .filter((word) => !/^\d+$/.test(word) || Number(word) <= 9);
  return words.length > 0 ? words : null;
};

// Parentheticals are context, not identity: "Power Finisher 1 (After Charged
// Combo Finisher)" is a Power Finisher, and matching the words inside the
// parens would file it under Combo Finishers too.
const actionMatches = (words, actionName) => {
  const nameWords = new Set(normalize(actionName.replace(/\([^)]*\)/g, " ")));
  return words.every((word) => nameWords.has(word));
};

/** Group kind from its nodes' shipped text: the twin button groups, the
 * charged groups, or a word-named mechanic. */
const groupKind = (texts) => {
  if (texts.some((t) => /^Attacks:/.test(t))) return { kind: "attacks" };
  if (texts.some((t) => /^(Charged Attacks|Power Raise)/.test(t))) return { kind: "charged" };
  return { kind: "named", words: phraseWords(texts[0] ?? "") };
};

/**
 * Pure derivation: per character, the memberships the button map supports.
 * `engineInputs` (per character, action id → ["left"|"right"...], from the
 * combo-branch graph) OVERRIDES the family's button per action — Scott's
 * ruling — so a family button only decides engine-silent actions (charge
 * releases, stance entries, the launcher). Engine evidence for actions no
 * family curates is reported, never banked. Returns { memberships,
 * unresolved, unmatchedGroups, engineOnly } — all but the first are report
 * material, not errors.
 */
export const deriveButtonMemberships = ({ buttonMap, icons, nodes, lang, skillNames, engineInputs = {} }) => {
  // character -> group -> [node texts]
  const groupTexts = new Map();
  for (const [key, node] of Object.entries(nodes)) {
    for (const effect of node.effects) {
      if (effect.stat !== "cap" || effect.scope !== "attack-group") continue;
      if ((effect.abilityIds ?? []).length > 0) continue;
      const character = key.split("_")[0];
      const group = effect.targetAttackGroup;
      if (!groupTexts.has(character)) groupTexts.set(character, new Map());
      const texts = groupTexts.get(character);
      if (!texts.has(group)) texts.set(group, []);
      const text = lang[key]?.text;
      if (text) texts.get(group).push(text);
    }
  }

  const memberships = {};
  const unresolved = [];
  const unmatchedGroups = [];
  const engineOnly = [];

  for (const [character, { families }] of Object.entries(buttonMap)) {
    const texts = groupTexts.get(character);
    if (texts === undefined) continue;
    const characterIcons = icons[character] ?? {};
    const names = skillNames[character[0].toUpperCase() + character.slice(1)] ?? {};

    const engine = engineInputs[character] ?? {};
    const engineOf = (id) => {
      const buttons = engine[id] ?? engine[String(id)];
      return Array.isArray(buttons) && buttons.length > 0 ? buttons : null;
    };

    // Per-action side resolution: engine evidence wins over the family's
    // button; a both-button action genuinely belongs to both sides.
    const perAction = [];
    const familyIds = new Set();
    for (const family of families) {
      for (const id of family.ids) {
        familyIds.add(id);
        const engineButtons = engineOf(id);
        perAction.push({
          id,
          sides: engineButtons ?? (family.button ? [family.button] : []),
          engineDecided: engineButtons !== null,
          family,
        });
      }
    }

    for (const family of families) {
      if (family.button === null || family.button === undefined) {
        if (family.note !== "unresolved") continue;
        const remaining = family.ids.filter((id) => engineOf(id) === null);
        if (remaining.length > 0) unresolved.push({ character, family: family.name, ids: remaining });
      }
    }
    for (const [id, buttons] of Object.entries(engine)) {
      if (!familyIds.has(Number(id)) && Array.isArray(buttons) && buttons.length > 0) {
        engineOnly.push({ character, action: Number(id), buttons });
      }
    }

    // The character's word-named groups, resolved first: their matches are
    // excluded from the button groups (see module doc). A charged group whose
    // nodes render no input icon ("Power Raise") resolves by name too.
    const matchIds = (words, excluded) =>
      Object.entries(names)
        // Ability/skill ids live at 1000+ and are scoped by ability HASH, not
        // by attack group — only normal-range actions are group members.
        .filter(
          ([id, name]) =>
            Number(id) < 1000 && typeof name === "string" && !excluded.has(Number(id)) && actionMatches(words, name)
        )
        .map(([id]) => Number(id))
        .sort((a, b) => a - b);

    const candidates = [];
    for (const [group, groupNodeTexts] of texts) {
      const { kind } = groupKind(groupNodeTexts);
      const iconList = (icons[character] ?? {})[String(group)] ?? [];
      const chargedNoIcon =
        kind === "charged" && !iconList.includes(ATTACK_ICON_LEFT) && !iconList.includes(ATTACK_ICON_RIGHT);
      // A group rendering BOTH input icons ("/ Attacks") is a button group,
      // not a named mechanic — the attacks path banks it from both sides.
      if (iconList.includes(ATTACK_ICON_LEFT) && iconList.includes(ATTACK_ICON_RIGHT)) continue;
      if (kind !== "named" && !chargedNoIcon) continue;
      const words = phraseWords(groupNodeTexts[0] ?? "");
      if (words === null) {
        unmatchedGroups.push({ character, group, reason: "no-identifying-words" });
        continue;
      }
      candidates.push({ group, words, kind });
    }
    const namedActionIds = new Set();
    const named = [];
    const misses = [];
    for (const candidate of candidates) {
      const matched = matchIds(candidate.words, new Set());
      if (matched.length === 0) {
        misses.push(candidate);
        continue;
      }
      named.push({ group: candidate.group, matched });
      if (candidate.kind === "named") for (const id of matched) namedActionIds.add(id);
    }
    // Fallback ONLY for the known "Combo Finishers" naming mismatch (some
    // characters name the actions just "Finisher 1") — minus every action a
    // full-phrase group already claimed, so a "Power Finisher" never leaks in.
    // It must NOT generalize: "Turbine Finishers" falling back to bare
    // "finisher" would swallow a character's basic combo finishers.
    for (const candidate of misses) {
      if (candidate.words.join(" ") !== "combo finisher") {
        unmatchedGroups.push({
          character,
          group: candidate.group,
          reason: "no-action-matches",
          words: candidate.words,
        });
        continue;
      }
      const matched = matchIds([candidate.words.at(-1)], namedActionIds);
      if (matched.length === 0) {
        unmatchedGroups.push({
          character,
          group: candidate.group,
          reason: "no-action-matches",
          words: candidate.words,
        });
        continue;
      }
      named.push({ group: candidate.group, matched });
      if (candidate.kind === "named") for (const id of matched) namedActionIds.add(id);
    }

    const entriesOn = (side) => perAction.filter((entry) => entry.sides.includes(side));
    const evidenceFor = (entries) => {
      const manual = entries.filter((entry) => !entry.engineDecided);
      const parts = [];
      if (manual.length > 0) {
        const inferred = manual.some((entry) => (entry.family.source ?? "inferred") === "inferred");
        parts.push(`manual:button-map 2026-08-10${inferred ? " (partly inferred)" : ""}`);
      }
      if (entries.some((entry) => entry.engineDecided)) parts.push("engine:action-branch 2026-08-10");
      return parts.join("; ");
    };

    const bankGroup = (group, entries) => {
      if (entries.length === 0) return;
      memberships[character] ??= {};
      memberships[character][group] = {
        actionIds: [...new Set(entries.map((entry) => entry.id))].sort((a, b) => a - b),
        evidence: entries.some((entry) => entry.family !== undefined)
          ? evidenceFor(entries)
          : "manual:button-map 2026-08-10",
      };
    };

    for (const [group, groupNodeTexts] of texts) {
      const { kind } = groupKind(groupNodeTexts);
      const iconList = characterIcons[String(group)] ?? [];
      const hasLeft = iconList.includes(ATTACK_ICON_LEFT);
      const hasRight = iconList.includes(ATTACK_ICON_RIGHT);
      const side = hasLeft ? "left" : hasRight ? "right" : null;
      if (hasLeft && hasRight) {
        // Both icons: the group spans both buttons ("/ Attacks").
        bankGroup(
          group,
          perAction.filter((entry) => entry.sides.length > 0 && !namedActionIds.has(entry.id))
        );
      } else if (kind === "attacks") {
        if (side === null) continue;
        bankGroup(
          group,
          entriesOn(side).filter((entry) => !namedActionIds.has(entry.id))
        );
      } else if (kind === "charged") {
        if (side === null) continue;
        bankGroup(
          group,
          entriesOn(side)
            .filter((entry) => CHARGE_FAMILY.test(entry.family.name))
            .filter((entry) => !namedActionIds.has(entry.id))
            .filter((entry) => !/finisher/i.test(names[String(entry.id)] ?? ""))
        );
      }
    }
    for (const { group, matched } of named)
      bankGroup(
        group,
        matched.map((id) => ({ id }))
      );
  }

  return { memberships, unresolved, unmatchedGroups, engineOnly };
};

const main = () => {
  const asset = (file) => JSON.parse(readFileSync(path.join(ROOT, "src", "assets", file), "utf8"));
  const buttonMap = asset("action-button-map.json").characters;
  const icons = asset("attack-group-icons.json").characters;
  const nodes = asset("skillboard-cap-sources.json").nodes;
  const engineInputs = asset("action-input-map.json").characters;
  const lang = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "lang", "en", "skillboard.json"), "utf8"));
  const skillNames = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "lang", "en", "ui.json"), "utf8")).skills;

  const { memberships, unresolved, unmatchedGroups, engineOnly } = deriveButtonMemberships({
    buttonMap,
    icons,
    nodes,
    lang,
    skillNames,
    engineInputs,
  });

  for (const [character, groups] of Object.entries(memberships)) {
    for (const [group, { actionIds, evidence }] of Object.entries(groups)) {
      console.log(`${character} g${group}: [${actionIds.join(",")}] (${evidence})`);
    }
  }
  console.log(`\nunresolved families (${unresolved.length}):`);
  for (const item of unresolved) console.log(`  ${item.character} ${item.family} [${item.ids.join(",")}]`);
  console.log(`unmatched word-named groups (${unmatchedGroups.length}):`);
  for (const item of unmatchedGroups) console.log(`  ${item.character} g${item.group} (${item.reason})`);
  console.log(`engine evidence outside every family — NOT banked (${engineOnly.length}):`);
  for (const item of engineOnly) console.log(`  ${item.character} ${item.action} ${item.buttons.join("+")}`);

  if (process.argv.includes("--write")) {
    const coveragePath = path.join(ROOT, "src", "assets", "attack-group-coverage.json");
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
    // bank() takes plain group -> actionIds; feed it per-group so each keeps
    // its own evidence string.
    let merged = coverage;
    for (const [character, groups] of Object.entries(memberships)) {
      for (const [group, { actionIds, evidence }] of Object.entries(groups)) {
        merged = bank(merged, nodes, { [character]: { [group]: actionIds } }, evidence);
      }
    }
    writeFileSync(coveragePath, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`\nbanked into ${coveragePath}`);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
