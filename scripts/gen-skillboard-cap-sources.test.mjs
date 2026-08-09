import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { gameXxhash32 } from "./gbfr-hash.mjs";
import {
  CAP_UP_STATUS_HASH,
  CHARACTER_BY_HASH,
  classifyPart,
  readMasterLevelCap,
  readParts,
  readRows,
  readStatusIds,
  verifyAgainstText,
} from "./gen-skillboard-cap-sources.mjs";

const EMPTY = Number.parseInt(gameXxhash32(""), 16);

/** A decoded parts row with every column at its "unset" value, so each test
 * states only the columns it is about. */
const part = (overrides) => ({
  values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  statusId: EMPTY,
  statusId2: EMPTY,
  abilityIds: [],
  subType: 0,
  conditional: 0,
  conditionBehavior: 0,
  specialEffect: 0,
  mainType: 0,
  targetAttackGroup: 0,
  ...overrides,
});

/** A raw .tbl: an i64 row count, then fixed-size rows. */
const table = (rowSize, rows) => {
  const buffer = Buffer.alloc(8 + rows.length * rowSize);
  buffer.writeBigInt64LE(BigInt(rows.length), 0);
  rows.forEach((row, index) => row.copy(buffer, 8 + index * rowSize));
  return buffer;
};

describe("readRows", () => {
  it("accepts a file whose length is exactly the declared rows", () => {
    expect(readRows(table(4, [Buffer.alloc(4), Buffer.alloc(4)]), 4, "t").rowCount).toBe(2);
  });

  // The whole reason this file parses .tbl raw: a stale .headers file shifts
  // every column after the drift point, and nothing downstream would notice.
  it("refuses a file whose length no longer matches the row size", () => {
    expect(() => readRows(table(4, [Buffer.alloc(4)]), 5, "skillboard_effect.tbl")).toThrow(
      /skillboard_effect\.tbl.*row layout moved/s
    );
  });
});

describe("classifyPart", () => {
  it("reads a plain self cap-up as raising every class", () => {
    expect(classifyPart(part({ mainType: 0, subType: 1, values: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))).toEqual({
      stat: "cap",
      percent: 20,
      capClass: "all",
      scope: "always",
    });
  });

  it("ignores a part whose stat is not the cap", () => {
    // SubType 3 is Skill Cooldown, SubType 0 is ATK.
    expect(classifyPart(part({ mainType: 0, subType: 3, values: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))).toBeNull();
    expect(classifyPart(part({ mainType: 8, subType: 4, values: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))).toBeNull();
  });

  it("reads SubType 9 against its MainType, not on its own", () => {
    // Self stat: the Chain Burst cap. Attack-scoped: Elemental ATK, not a cap.
    expect(classifyPart(part({ mainType: 0, subType: 9, values: [40, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))).toMatchObject({
      stat: "chain-burst-cap",
      percent: 40,
    });
    expect(
      classifyPart(part({ mainType: 2, subType: 9, targetAttackGroup: 10, values: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))
    ).toBeNull();
  });

  it("claims the skill class only for the ability target group", () => {
    const scoped = (targetAttackGroup, abilityIds = []) =>
      classifyPart(
        part({ mainType: 2, subType: 1, targetAttackGroup, abilityIds, values: [45, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
      );
    expect(scoped(10, [0x6fd0843a])).toEqual({
      stat: "cap",
      percent: 45,
      capClass: "skill",
      scope: "attack-group",
      targetAttackGroup: 10,
      abilityIds: ["6fd0843a"],
    });
    // Group 8 is "Combo Finishers" for one character and 2 for another, so the
    // class is left unclaimed and the raw group id carried instead.
    expect(scoped(8)).toMatchObject({ capClass: null, targetAttackGroup: 8, abilityIds: [] });
  });

  it("resolves a status gate to the id the hook emits", () => {
    const poison = Number.parseInt(gameXxhash32("STATUS_POISONAILMENT"), 16);
    expect(
      classifyPart(
        part({
          mainType: 0,
          subType: 1,
          conditional: 1,
          conditionBehavior: 2,
          statusId2: poison,
          values: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        }),
        new Map([[poison, 1000]])
      )
    ).toEqual({
      stat: "cap",
      percent: 100,
      capClass: "all",
      scope: "gated",
      gateKind: "status",
      gateStatusId: 1000,
      gateStatusHash: poison.toString(16),
    });
  });

  it("keeps an engine-state gate distinguishable instead of dropping it", () => {
    expect(
      classifyPart(
        part({ mainType: 0, subType: 1, conditional: 2, conditionBehavior: 2, values: [30, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
      )
    ).toMatchObject({ scope: "gated", gateKind: "engine-state", gateState: 2 });
  });

  it("reads a per-sigil rule as a per-unit grant with the game's own ceiling", () => {
    expect(
      classifyPart(
        part({ mainType: 1, subType: 1, conditional: 0, conditionBehavior: 3, values: [20, 5, 0, 0, 0, 0, 0, 0, 0, 0] })
      )
    ).toEqual({
      stat: "cap",
      scope: "counted",
      capClass: "all",
      countKind: "basic-sigil",
      percent: 20,
      maxCount: 5,
    });
  });

  it("reads a per-quest counter at the ceiling the table states", () => {
    expect(
      classifyPart(
        part({
          mainType: 1,
          subType: 1,
          conditional: 3,
          conditionBehavior: 3,
          values: [0, 10, 0, 40, 0, 0, 0, 0, 0, 0],
        })
      )
    ).toMatchObject({ countKind: "quest-counter", percent: 40, perUnit: 10 });
  });

  it("reads a granted cap buff, and only the cap one", () => {
    expect(
      classifyPart(
        part({
          mainType: 3,
          conditionBehavior: 1,
          statusId: CAP_UP_STATUS_HASH,
          values: [10, 30, 0, 0, 0, 0, 0, 0, 0, 0],
        }),
        new Map([[CAP_UP_STATUS_HASH, 56]])
      )
    ).toMatchObject({ scope: "grants-status", percent: 10, durationSeconds: 30, grantsStatusId: 56 });
    // A part that grants Shield is a status grant too, and is not a cap source.
    expect(
      classifyPart(
        part({ mainType: 3, conditionBehavior: 1, statusId: 0x1234, values: [1000, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
      )
    ).toBeNull();
  });
});

describe("raw row offsets", () => {
  it("reads a parts row's key, values and enums from their byte offsets", () => {
    const row = Buffer.alloc(136);
    row.writeFloatLE(35, 0x20); // Value1
    row.writeUInt32LE(0xdeadbeef, 0x48); // Key
    row.writeUInt32LE(EMPTY, 0x54); // StatusId
    row.writeUInt32LE(0x6fd0843a, 0x58); // AbilityId1
    row.writeUInt32LE(EMPTY, 0x5c); // StatusId2
    row.writeUInt32LE(EMPTY, 0x60); // AbilityId2
    row.writeUInt32LE(0x6fd0843a, 0x64); // AbilityId3 — the same ability, once
    row.writeInt32LE(1, 0x68); // SubType
    row.writeInt32LE(2, 0x7c); // MainType
    row.writeInt32LE(10, 0x80); // TargetAttackGroup

    const decoded = readParts(table(136, [row])).get(0xdeadbeef);
    expect(decoded).toMatchObject({ subType: 1, mainType: 2, targetAttackGroup: 10, abilityIds: [0x6fd0843a] });
    expect(decoded.values[0]).toBe(35);
  });

  it("keys status rows by their hash and yields the decimal id", () => {
    const row = Buffer.alloc(140);
    row.writeUInt32LE(CAP_UP_STATUS_HASH, 0x60);
    row.writeUInt32LE(56, 0x7c);
    expect(readStatusIds(table(140, [row])).get(CAP_UP_STATUS_HASH)).toBe(56);
  });

  it("accumulates the master-level cap-up into a per-level total", () => {
    const level = (masterLevel, dmgCapAdd) => {
      const row = Buffer.alloc(32);
      row.writeInt32LE(masterLevel, 0x10);
      row.writeInt32LE(dmgCapAdd, 0x1c);
      return row;
    };
    expect(readMasterLevelCap(table(32, [level(1, 0), level(2, 5), level(3, 0), level(4, 6)]))).toEqual([
      0, 0, 5, 5, 11,
    ]);
  });
});

describe("CHARACTER_BY_HASH", () => {
  it("maps the id hash the layout table stores back to the node-key prefix", () => {
    expect(CHARACTER_BY_HASH.get(gameXxhash32("PL0000"))).toBe("pl0000");
    expect(CHARACTER_BY_HASH.get(gameXxhash32("PL2900"))).toBe("pl2900");
  });
});

describe("verifyAgainstText", () => {
  const lang = {
    a: { text: "DMG Cap +20%" },
    b: { text: "ATK +20%" },
    c: { text: "At Arts Lvl IV, the captain gains DMG Cap +100%" },
    d: { text: "Skill DMG Cap +35%" },
  };

  it("flags a priced node whose own text says nothing about the cap", () => {
    expect(verifyAgainstText({ b: {} }, {}, lang).falsePositives).toEqual(["b"]);
  });

  it("flags a cap node that is neither priced nor reported as engine-defined", () => {
    const { missed, capMentions } = verifyAgainstText({ a: {} }, { c: {} }, lang);
    expect(capMentions).toBe(3);
    expect(missed).toEqual(["d"]);
  });
});

describe("the shipped asset", () => {
  const asset = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/assets/skillboard-cap-sources.json"), "utf8")
  );

  it("prices the plain cap node, the skill-scoped node and the sigil rule", () => {
    expect(asset.nodes.pl0000_000c.effects).toEqual([{ stat: "cap", percent: 20, capClass: "all", scope: "always" }]);
    expect(asset.nodes.pl0000_0033.effects[0]).toMatchObject({
      capClass: "skill",
      percent: 45,
      // Reginleiv, as the ability hash the game stores — not the name.
      abilityIds: [gameXxhash32("AB_PL0000_10")],
    });
    expect(asset.nodes.pl0000_0023.effects[0]).toMatchObject({ countKind: "basic-sigil", percent: 20, maxCount: 5 });
  });

  it("gives a buff-gated node the status id rather than the prose gate", () => {
    expect(asset.nodes.pl0000_001b.effects[0]).toMatchObject({ gateKind: "status", gateStatusId: 1000 });
  });

  it("reports the engine-defined nodes instead of pricing or dropping them", () => {
    // The Summon Cost EX node carries a cap-shaped payload the engine
    // repurposes; pricing it would invent a source the game never grants.
    expect(asset.nodes.pl0000_003e).toBeUndefined();
    expect(asset.engineDefined.pl0000_003e).toMatchObject({ effectKind: 9 });
    expect(asset.engineDefined.pl0000_0002).toMatchObject({ effectKind: 6 });
  });

  it("carries the master-level cap-up as a per-level total", () => {
    expect(asset.masterLevelCap).toHaveLength(51);
    expect(asset.masterLevelCap[0]).toBe(0);
    expect(asset.masterLevelCap[50]).toBe(100);
  });
});
