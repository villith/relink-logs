import assert from "node:assert/strict";
import { test } from "vitest";

import { bundleFromRows } from "./gen-enemy-attack-names.mjs";

test("folds TXT_BT rows into an em-keyed ordinal map", () => {
  const rows = [
    { id_hash_: "TXT_BT_7000_1", text_: "Skyfall" },
    { id_hash_: "TXT_BT_7000_15", text_: "Catastrophe: Zero" },
    { id_hash_: "TXT_BT_8300_4", text_: "Arcarum: The World Beyond" },
    { id_hash_: "TXT_COMMON_CMD_000", text_: "not a battle row" },
  ];
  assert.deepEqual(bundleFromRows(rows), {
    EM7000: { 1: "Skyfall", 15: "Catastrophe: Zero" },
    EM8300: { 4: "Arcarum: The World Beyond" },
  });
});

test("skips rows with no text rather than emitting a blank name", () => {
  // A blank would render as an empty callout, which reads worse than the
  // "Attack N" fallback the frontend already has.
  const rows = [
    { id_hash_: "TXT_BT_7000_1", text_: "" },
    { id_hash_: "TXT_BT_7000_2", text_: "Catastrophe" },
    { id_hash_: "TXT_BT_7000_3" },
  ];
  assert.deepEqual(bundleFromRows(rows), { EM7000: { 2: "Catastrophe" } });
});

test("ignores ids that only look like battle keys", () => {
  const rows = [
    { id_hash_: "TXT_BT_700_1", text_: "three digits" },
    { id_hash_: "TXT_BT_7000_1_2", text_: "trailing segment" },
    { id_hash_: "PRE_TXT_BT_7000_1", text_: "prefixed" },
  ];
  assert.deepEqual(bundleFromRows(rows), {});
});
