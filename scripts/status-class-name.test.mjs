import assert from "node:assert/strict";
import { test } from "vitest";

import { isNameless, prettifyClassName } from "./status-class-name.mjs";

test("strips the Status prefix and the actor code, then splits CamelCase", () => {
  assert.equal(prettifyClassName("StatusPl1200UniqueBuffGuardpoint"), "Guardpoint");
  assert.equal(prettifyClassName("StatusPl0200UniqueBuffAres"), "Ares");
  assert.equal(prettifyClassName("StatusPl1100Cover"), "Cover");
  // Em is the only other actor code prefix that occurs in the real family (12 classes).
  assert.equal(prettifyClassName("StatusEm1700AttackBuff"), "Attack Buff");
});

test("handles classes that omit the Status prefix", () => {
  // Naming is inconsistent in the binary — Pl0400ConcentrationEx has no prefix.
  assert.equal(prettifyClassName("Pl0400ConcentrationEx"), "Concentration Ex");
});

test("splits single-letter words before capitalized words", () => {
  // Three real classes have uppercase runs before capitalized words.
  assert.equal(prettifyClassName("StatusPl2200UpgradeABuff"), "Upgrade A Buff");
  assert.equal(prettifyClassName("StatusPl2200UpgradeBBuff"), "Upgrade B Buff");
  assert.equal(prettifyClassName("StatusPl2400UniqueDebuffBanGSwing"), "Debuff Ban G Swing");
});

test("keeps a trailing Buff rather than guessing", () => {
  // "Attack" alone would be a different claim than "Attack Buff"; curation via
  // ui.json is the place to improve these, not a lossy rule here.
  assert.equal(prettifyClassName("StatusPl1200AttackBuff"), "Attack Buff");
  assert.equal(prettifyClassName("StatusPl2400SuperModeBuff"), "Super Mode Buff");
});

test("treats non-distinguishing bases as nameless", () => {
  assert.equal(isNameless("StatusBase"), true);
  assert.equal(isNameless("ExStatus"), true);
  assert.equal(isNameless("StatusPl1100Cover"), false);
});

test("a class that reduces to nothing is nameless", () => {
  assert.equal(isNameless("StatusPl1200"), true);
  assert.equal(prettifyClassName("StatusPl1200"), "");
});
