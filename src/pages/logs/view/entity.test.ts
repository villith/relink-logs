import { describe, expect, it } from "vitest";

import { cellOfKey, cellOfRow, rowRefOfRow, type EntityResolvers } from "./entity";
import type { MetricRow } from "./metrics/types";
import {
  ROLLUP_KEY,
  SBA_UNATTRIBUTED_KEY,
  enemyRowKey,
  playerRowKey,
  skillKey,
  spawnRowKey,
  takenAttackRowLabel,
  takenRowKey,
} from "./rowKey";

const ENEMY = { Unknown: 0xaa };
const ATTACK = { Normal: 42 };

/** Every branch answers with all three fields, so a test that loses one has
 * lost it in the dispatch rather than in the fixture. */
const resolvers: EntityResolvers = {
  player: (index) => ({ name: `P${index}`, iconUrl: `p${index}.png`, color: "#p" }),
  target: (segment) => ({ name: `S${segment}`, iconUrl: `s${segment}.png`, color: "#s" }),
  actor: (actorIndex) => ({ name: String(actorIndex) }),
  enemy: (enemyType) => ({ name: `E${JSON.stringify(enemyType)}`, iconUrl: "e.png", color: "#e" }),
  takenAttack: (enemyType, actionId) => ({ name: `${JSON.stringify(enemyType)}/${JSON.stringify(actionId)}` }),
  ability: (rowKey, owner) => ({ name: owner ? `${rowKey}@${owner.index}` : rowKey, iconUrl: "a.png" }),
  status: (statusKey) => ({ name: `ST${statusKey}`, iconUrl: "st.png" }),
  reserved: (ref) => ({ name: ref.kind === "sbaCause" ? ref.key : ref.kind }),
};

const row = (over: Partial<MetricRow>): MetricRow => ({
  key: "k",
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
  ...over,
});

describe("cellOfKey", () => {
  it("resolves each namespace through its own branch", () => {
    expect(cellOfKey(playerRowKey(1), resolvers)).toEqual({ name: "P1", iconUrl: "p1.png", color: "#p" });
    expect(cellOfKey(spawnRowKey(2), resolvers).name).toBe("S2");
    expect(cellOfKey(enemyRowKey(ENEMY), resolvers).iconUrl).toBe("e.png");
    expect(cellOfKey(takenRowKey(takenAttackRowLabel(ENEMY, ATTACK)), resolvers).name).toContain("Normal");
    expect(cellOfKey(skillKey("Normal:100"), resolvers)).toEqual({ name: "Normal:100", iconUrl: "a.png" });
    expect(cellOfKey("status:1:2:3", resolvers).iconUrl).toBe("st.png");
  });

  // The whole point of the bundle: a surface that asks for a name gets the art
  // and the colour it did not know to ask for.
  it("carries art and colour with the name", () => {
    const cell = cellOfKey(spawnRowKey(2), resolvers);
    expect(cell.iconUrl).toBe("s2.png");
    expect(cell.color).toBe("#s");
  });

  // A gauge cause that reached the ability join would draw whichever art the
  // fallback landed on, under a name it never asked for.
  it("sends the self-naming keys to the reserved branch", () => {
    expect(cellOfKey(ROLLUP_KEY, resolvers)).toEqual({ name: "rollup" });
    expect(cellOfKey(SBA_UNATTRIBUTED_KEY, resolvers)).toEqual({ name: SBA_UNATTRIBUTED_KEY });
    expect(cellOfKey("source:questStart", resolvers)).toEqual({ name: "source:questStart" });
  });

  // A stale or hand-edited URL: showing the key back is what tells the user
  // what is wrong, and it depicts nothing because nothing is known about it.
  it("falls back to the raw key, with no art", () => {
    expect(cellOfKey("nonsense", resolvers)).toEqual({ name: "nonsense" });
  });

  it("names an ability against the owner when one is given", () => {
    const owner = { index: 4 } as Parameters<typeof cellOfKey>[2];
    expect(cellOfKey(skillKey("Normal:120"), resolvers, owner).name).toBe("Normal:120@4");
  });
});

describe("rowRefOfRow", () => {
  it("reads the bare payloads the row grammar carries", () => {
    expect(rowRefOfRow(row({ label: "3", kind: "player" }), "ability")).toEqual({ kind: "player", index: 3 });
    expect(rowRefOfRow(row({ label: JSON.stringify(ENEMY), kind: "enemy" }), "ability")).toEqual({
      kind: "enemy",
      enemyType: ENEMY,
    });
    expect(rowRefOfRow(row({ label: "Normal:100", kind: "ability" }), "ability")).toEqual({
      kind: "ability",
      rowKey: "Normal:100",
    });
    expect(rowRefOfRow(row({ label: "status:1:2:3", kind: "status" }), "ability")).toEqual({
      kind: "status",
      statusKey: "status:1:2:3",
    });
  });

  // The holder row's label carries its own prefix, because `target:` and
  // `actor:` are two different things at one level.
  it("reads a holder row through the key grammar", () => {
    expect(rowRefOfRow(row({ label: "target:5", kind: "target" }), "ability")).toEqual({ kind: "target", segment: 5 });
    expect(rowRefOfRow(row({ label: "actor:900", kind: "target" }), "ability")).toEqual({
      kind: "actor",
      actorIndex: 900,
    });
  });

  it("falls back to the table's kind where the row declares none", () => {
    expect(rowRefOfRow(row({ label: "2" }), "player")).toEqual({ kind: "player", index: 2 });
  });

  // The groups path declares a kind per row, and it outranks the table's: one
  // level can produce more than one shape of row.
  it("prefers the row's own declared kind", () => {
    expect(rowRefOfRow(row({ label: "3", kind: "player" }), "status")).toEqual({ kind: "player", index: 3 });
  });

  // Putting a self-naming row's sentinel through any join prints whatever that
  // join makes of a name it has never seen.
  it("answers null for a row that names itself", () => {
    expect(rowRefOfRow(row({ label: "x", labelKey: "ui.logs.sba-unattributed" }), "ability")).toBeNull();
  });
});

describe("cellOfRow", () => {
  it("draws a self-naming row's own text and nothing else", () => {
    const selfNamed = row({ label: "x", labelKey: "ui.logs.sba-unattributed" });
    expect(cellOfRow(selfNamed, "ability", resolvers, () => "Unattributed")).toEqual({ name: "Unattributed" });
  });

  // A row and the band that decomposes it land on one ladder, so they cannot
  // be named — or illustrated — differently.
  it("agrees with the key form for the same entity", () => {
    const fromRow = cellOfRow(row({ label: "3", kind: "player" }), "ability", resolvers, () => "");
    expect(fromRow).toEqual(cellOfKey(playerRowKey(3), resolvers));
  });
});
