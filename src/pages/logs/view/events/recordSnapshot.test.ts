import { describe, expect, it } from "vitest";

import { parseRecordSnapshot } from "./recordSnapshot";

/** Builds a well-formed record-snapshot blob (16 bytes, window base `0x18`)
 * with the given game-offset byte runs written in, everything else zero.
 * Exported so `damageExplain.test.ts` imports this rather than keeping its
 * own copy — same convention as `damageSnapshot.test.ts`'s `blob`. */
export const blob = (entries: Array<[number, number[]]>): number[] => {
  const out = new Array(0x28 - 0x18).fill(0);
  for (const [gameOffset, bytes] of entries) bytes.forEach((b, i) => (out[gameOffset - 0x18 + i] = b));
  return out;
};

/** Little-endian f32 bytes for a value, so tests can write "15%" instead of
 * hand-encoding IEEE-754. Exported for the same reason `blob` is. */
export const f32Bytes = (value: number): number[] => {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return Array.from(new Uint8Array(buf));
};

describe("parseRecordSnapshot", () => {
  it("reads the SBA and Skill dmg% fields at their documented offsets", () => {
    const snap = parseRecordSnapshot(
      blob([
        [0x1c, f32Bytes(7.5)],
        [0x24, f32Bytes(15)],
      ])
    );
    expect(snap?.sba).toBeCloseTo(7.5);
    expect(snap?.skill).toBeCloseTo(15);
  });

  it("rejects absent and wrong-length blobs", () => {
    expect(parseRecordSnapshot(null)).toBeNull();
    expect(parseRecordSnapshot(undefined)).toBeNull();
    expect(parseRecordSnapshot([1, 2, 3])).toBeNull();
  });

  it("reads a negative percent (a class dmg% debuff)", () => {
    const snap = parseRecordSnapshot(blob([[0x24, f32Bytes(-10)]]));
    expect(snap?.skill).toBeCloseTo(-10);
  });
});
