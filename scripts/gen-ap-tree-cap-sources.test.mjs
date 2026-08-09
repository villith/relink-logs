import { describe, expect, it } from "vitest";

import { gameXxhash32 } from "./gbfr-hash.mjs";
import {
  AP_TREE,
  BONUS_PARAM_COLUMNS,
  CAP_CLASS_BY_TYPE,
  CAP_TYPE_TEXT,
  CHARACTER_BY_HASH,
  buildTrees,
  capEffectsOf,
  potentialsOf,
  readBonuses,
  readRows,
  unresolvedParams,
  verifyAgainstText,
} from "./gen-ap-tree-cap-sources.mjs";

const EMPTY = Number.parseInt(gameXxhash32(""), 16);

/** A `limit_bonus_param` row with ten value slots, stating only what a test is
 * about. */
const param = (typeId, values) => ({
  values: [...values, ...Array.from({ length: 10 - values.length }, () => 0)],
  nameFormatId: 0,
  typeId,
});

/** One raw ap_tree table, built in memory: an 8-byte row count then `rows` rows
 * of `rowSize` bytes, so the readers under test see exactly the shape the game
 * ships. */
const table = (rows, rowSize = 140) => {
  const buffer = Buffer.alloc(8 + rows.length * rowSize);
  buffer.writeBigInt64LE(BigInt(rows.length), 0);
  rows.forEach((row, index) => {
    const at = 8 + index * rowSize;
    buffer.writeUInt32LE(row.weaponId ?? EMPTY, at + AP_TREE.weaponId);
    buffer.writeUInt32LE(row.limitBonusId ?? EMPTY, at + AP_TREE.limitBonusId);
    buffer.writeUInt32LE(row.key ?? 0, at + AP_TREE.key);
    buffer.writeUInt32LE(row.charaId ?? EMPTY, at + AP_TREE.charaId);
    buffer.writeUInt32LE(row.paramIndex ?? 0, at + AP_TREE.paramIndex);
  });
  return buffer;
};

const PL0000 = Number.parseInt(gameXxhash32("PL0000"), 16);

describe("readRows", () => {
  it("accepts a file whose length is exactly the header plus its rows", () => {
    expect(readRows(table([{}, {}]), 140, "t").rowCount).toBe(2);
  });

  it("refuses a file the row size does not divide, rather than reading shifted columns", () => {
    const truncated = table([{}, {}]).subarray(0, 8 + 140 + 4);
    expect(() => readRows(truncated, 140, "ap_tree_atk.tbl")).toThrow(/row layout moved/);
  });
});

describe("capEffectsOf", () => {
  const bonuses = new Map([[1, { paramKeys: [10, 11], titleId: 0 }]]);
  const params = new Map([
    [10, param(104, [5, 8])],
    [11, param(105, [5, 8])],
  ]);

  it("takes the value at the node's own slot index, not the first slot", () => {
    expect(capEffectsOf({ limitBonusId: 1, paramIndex: 1 }, bonuses, params)).toEqual([
      { capClass: "skill", percent: 8 },
      { capClass: "sba", percent: 8 },
    ]);
  });

  it("reports an unresolved limit_bonus as null, distinct from a node that grants no cap", () => {
    expect(capEffectsOf({ limitBonusId: 999, paramIndex: 0 }, bonuses, params)).toBeNull();
    const noCap = new Map([[2, { paramKeys: [12], titleId: 0 }]]);
    const other = new Map([[12, param(100, [10])]]);
    expect(capEffectsOf({ limitBonusId: 2, paramIndex: 0 }, noCap, other)).toEqual([]);
  });

  it("leaves the healing cap out — 107 sits next to the damage types and is not one", () => {
    const healing = new Map([[3, { paramKeys: [13], titleId: 0 }]]);
    expect(capEffectsOf({ limitBonusId: 3, paramIndex: 0 }, healing, new Map([[13, param(107, [5])]]))).toEqual([]);
  });

  it("drops a slot holding zero rather than emitting a node worth +0%", () => {
    const params0 = new Map([[10, param(104, [0, 8])]]);
    expect(capEffectsOf({ limitBonusId: 1, paramIndex: 0 }, new Map([[1, { paramKeys: [10] }]]), params0)).toEqual([]);
  });
});

describe("buildTrees", () => {
  const bonuses = new Map([[1, { paramKeys: [10], titleId: 0 }]]);
  const params = new Map([[10, param(104, [7])]]);
  const buffers = {
    atk: table([{ key: 0xaa, limitBonusId: 1, charaId: PL0000 }]),
    def: table([{ key: 0xbb, limitBonusId: 1, charaId: PL0000 }]),
    wep: table([{ key: 0xcc, limitBonusId: 1, charaId: PL0000, weaponId: 0x1234 }]),
    rebuild: table([{ key: 0xdd, limitBonusId: 1, charaId: PL0000, weaponId: 0x1234 }]),
  };

  it("files the character trees under the character and the weapon trees under the weapon", () => {
    const { owners } = buildTrees({ buffers, bonuses, params });
    expect(Object.keys(owners.character)).toEqual(["pl0000"]);
    expect(Object.keys(owners.weapon)).toEqual(["00001234"]);
    expect(owners.character.pl0000).toEqual({
      atk: [{ key: "000000aa", effects: [{ capClass: "skill", percent: 7 }] }],
      def: [{ key: "000000bb", effects: [{ capClass: "skill", percent: 7 }] }],
    });
    expect(Object.keys(owners.weapon["00001234"]).sort()).toEqual(["rebuild", "wep"]);
  });

  it("keeps the two owners apart, so a weapon's nodes never inflate its character", () => {
    const { owners } = buildTrees({ buffers, bonuses, params });
    expect(potentialsOf(owners.character).pl0000).toEqual({ skill: 14 });
    expect(potentialsOf(owners.weapon)["00001234"]).toEqual({ skill: 14 });
  });

  it("counts a node whose limit_bonus does not resolve instead of dropping it silently", () => {
    const { unresolvedBonuses } = buildTrees({
      buffers: { ...buffers, atk: table([{ key: 1, limitBonusId: 0x999, charaId: PL0000 }]) },
      bonuses,
      params,
    });
    expect(unresolvedBonuses).toBe(1);
  });

  it("reports a character hash it cannot name rather than filing it under a wrong one", () => {
    const { owners, unknownCharacters } = buildTrees({
      buffers: { ...buffers, atk: table([{ key: 1, limitBonusId: 1, charaId: 0xdeadbeef }]) },
      bonuses,
      params,
    });
    expect([...unknownCharacters]).toEqual(["deadbeef"]);
    expect(owners.character.pl0000?.atk).toBeUndefined();
  });
});

describe("verifyAgainstText", () => {
  const textFor = (overrides) =>
    new Map([
      [1, "Normal Attack Damage Cap +{0}%"],
      [2, "Skill Damage Cap +{0}%"],
      [3, "Skybound Art Damage Cap +{0}%"],
      [4, "Damage Cap +{0}%"],
      ...Object.entries(overrides ?? {}).map(([id, text]) => [Number(id), text]),
    ]);
  const params = () =>
    new Map([
      [10, { ...param(103, [1]), nameFormatId: 1 }],
      [11, { ...param(104, [1]), nameFormatId: 2 }],
      [12, { ...param(105, [1]), nameFormatId: 3 }],
      [13, { ...param(106, [1]), nameFormatId: 4 }],
    ]);

  it("passes when every cap type's text says what the type id claims", () => {
    expect(verifyAgainstText(params(), textFor())).toEqual({ mismatches: [], unconfirmedTypes: [] });
  });

  it("catches a type id a patch has repurposed", () => {
    const { mismatches } = verifyAgainstText(params(), textFor({ 2: "Healing Cap (Receiving) +{0}%" }));
    expect(mismatches).toEqual([
      { typeId: 104, expected: "Skill Damage Cap", actual: "Healing Cap (Receiving) +{0}%" },
    ]);
  });

  it("will not let 106 confirm itself off another type's text — 'Damage Cap' is a substring of all four", () => {
    const only106 = new Map([[13, { ...param(106, [1]), nameFormatId: 2 }]]);
    const { mismatches, unconfirmedTypes } = verifyAgainstText(only106, textFor());
    expect(mismatches).toHaveLength(1);
    expect(unconfirmedTypes).toContain(106);
  });

  it("treats a row with no shipped text as silent, not as a disagreement", () => {
    const unnamed = new Map([[10, { ...param(103, [1]), nameFormatId: 999 }]]);
    expect(verifyAgainstText(unnamed, textFor()).mismatches).toEqual([]);
  });

  it("fails a cap type no row confirms at all", () => {
    expect(verifyAgainstText(new Map(), textFor()).unconfirmedTypes).toEqual([103, 104, 105, 106]);
  });
});

/** One raw limit_bonus table: `IconId` is a 32-byte raw_string, so ParamId1
 * starts at 0x20 — the column whose being read as 0x24 dropped every bonus that
 * sets only its first param. */
const bonusTable = (rows) => {
  const buffer = Buffer.alloc(8 + rows.length * 100);
  buffer.writeBigInt64LE(BigInt(rows.length), 0);
  rows.forEach((row, index) => {
    const at = 8 + index * 100;
    BONUS_PARAM_COLUMNS.forEach((column, slot) => {
      buffer.writeUInt32LE(row.paramKeys?.[slot] ?? EMPTY, at + column);
    });
    // The int right after the three ParamIds. The old off-by-one column read
    // this as a param key; it is -1 in every shipped row.
    buffer.writeInt32LE(-1, at + 0x2c);
    buffer.writeUInt32LE(row.key ?? 0, at + 0x34);
  });
  return buffer;
};

describe("readBonuses", () => {
  it("reads ParamId1 at 0x20 — a bonus that sets only its first param is not empty", () => {
    const bonuses = readBonuses(bonusTable([{ key: 7, paramKeys: [0xabc] }]));
    expect(bonuses.get(7)?.paramKeys).toEqual([0xabc]);
  });

  it("never reads the -1 column past the three ParamIds as a param key", () => {
    const bonuses = readBonuses(bonusTable([{ key: 7, paramKeys: [0xabc, 0xdef, 0x123] }]));
    expect(bonuses.get(7)?.paramKeys).toEqual([0xabc, 0xdef, 0x123]);
  });
});

describe("unresolvedParams", () => {
  it("is zero when every ParamId names a row", () => {
    const bonuses = readBonuses(bonusTable([{ key: 7, paramKeys: [0xabc] }]));
    expect(unresolvedParams(bonuses, new Map([[0xabc, param(104, [5])]]))).toBe(0);
  });

  it("counts ParamIds that resolve to nothing — the guard the column bug lacked", () => {
    const bonuses = readBonuses(bonusTable([{ key: 7, paramKeys: [0xabc, 0xdef] }]));
    expect(unresolvedParams(bonuses, new Map([[0xabc, param(104, [5])]]))).toBe(1);
  });
});

describe("the shipped constants", () => {
  it("names a cap class for exactly the four types the text check covers", () => {
    expect(Object.keys(CAP_CLASS_BY_TYPE)).toEqual(Object.keys(CAP_TYPE_TEXT));
  });

  it("derives character codes by hashing, so a new character needs no edit", () => {
    expect(CHARACTER_BY_HASH.get(PL0000)).toBe("pl0000");
  });
});
