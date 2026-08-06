import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTables } from "./gen-status-classes.mjs";

const ROWS = [
  { vtable_rva: 0x29b26c0, class: "StatusPl1200UniqueBuffGuardpoint" },
  { vtable_rva: 0x29b1640, class: "StatusPl0200UniqueBuffAres" },
  { vtable_rva: 0x29b0cf0, class: "StatusBase" },
];

test("emits a hash-keyed app table with prettified names, bases excluded", () => {
  const { app } = buildTables(ROWS);
  const names = Object.values(app).map((entry) => entry.name).sort();
  assert.deepEqual(names, ["Ares", "Guardpoint"]);
  const classes = Object.values(app).map((entry) => entry.class).sort();
  assert.deepEqual(classes, ["StatusPl0200UniqueBuffAres", "StatusPl1200UniqueBuffGuardpoint"]);
});

test("emits hook rows sorted by rva, with nameless classes mapped to 0", () => {
  const { hook } = buildTables(ROWS);
  assert.deepEqual(
    hook.map((row) => row.rva),
    [0x29b0cf0, 0x29b1640, 0x29b26c0]
  );
  // StatusBase is present but carries hash 0: "known, and deliberately
  // nameless" is a different fact from "not in the table".
  assert.equal(hook[0].hash, 0);
  assert.notEqual(hook[1].hash, 0);
});

test("the hook hash and the app key agree", () => {
  const { app, hook } = buildTables(ROWS);
  const ares = hook.find((row) => row.rva === 0x29b1640);
  assert.equal(app[String(ares.hash)].name, "Ares");
});

test("rejects a duplicate rva rather than silently dropping one", () => {
  const dupes = [
    { vtable_rva: 0x1, class: "StatusPl1100Cover" },
    { vtable_rva: 0x1, class: "StatusPl1200UniqueBuffGuardpoint" },
  ];
  assert.throws(() => buildTables(dupes), /duplicate vtable rva/i);
});

test("accepts several vtables for ONE class, mapping them to the same hash", () => {
  // 100 of the 167 real classes have more than one vftable (multiple
  // inheritance). Whichever one the object carries must resolve to the same
  // name, so duplicate CLASSES are legal even though duplicate RVAs are not.
  const multi = [
    { vtable_rva: 0x5abfd78, class: "StatusPl1200UniqueBuffGuardpoint" },
    { vtable_rva: 0x5abfe30, class: "StatusPl1200UniqueBuffGuardpoint" },
  ];
  const { app, hook } = buildTables(multi);
  assert.equal(hook.length, 2);
  assert.equal(hook[0].hash, hook[1].hash);
  assert.equal(Object.keys(app).length, 1);
  assert.equal(Object.values(app)[0].name, "Guardpoint");
});
