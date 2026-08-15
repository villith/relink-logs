import { describe, expect, it } from "vitest";

import { GATE_BYTE_OFFSET, parseInstSnapshot, type GateBytes } from "./damageSnapshot";

/** Builds a well-formed snapshot blob (640 bytes, window base `0xC0`) with
 * the given game-offset byte runs written in, everything else zero. Exported
 * so `damageExplain.test.ts` can build the same fixtures. */
export const blob = (entries: Array<[number, number[]]>): number[] => {
  const out = new Array(0x340 - 0xc0).fill(0);
  for (const [gameOffset, bytes] of entries) bytes.forEach((b, i) => (out[gameOffset - 0xc0 + i] = b));
  return out;
};

describe("parseInstSnapshot", () => {
  it("reads gate bytes at their documented offsets", () => {
    const snap = parseInstSnapshot(
      blob([
        [0x15d, [1]],
        [0xd0, [0xe8, 0x03, 0, 0]],
      ])
    );
    expect(snap?.gates.crit).toBe(true);
    expect(snap?.gates.weakPoint).toBe(false);
    expect(snap?.builderPopulated).toBe(true);
  });

  it("treats a remote-style snapshot as unpopulated", () => {
    const snap = parseInstSnapshot(blob([[0x15d, [1]]]));
    expect(snap?.builderPopulated).toBe(false);
  });

  it("rejects absent and wrong-length blobs", () => {
    expect(parseInstSnapshot(null)).toBeNull();
    expect(parseInstSnapshot(undefined)).toBeNull();
    expect(parseInstSnapshot([1, 2, 3])).toBeNull();
  });

  it("treats builder-populated via the precap (+0x2D4) alone", () => {
    // d0 stays zero (Path B / pre-set damage hits can leave it 0), but a
    // nonzero precap float still proves the builder ran.
    const snap = parseInstSnapshot(blob([[0x2d4, [0, 0, 0x80, 0x3f]]])); // 1.0f32
    expect(snap?.builderPopulated).toBe(true);
  });

  /** Mirrors the Rust test `each_gate_byte_reads_its_own_offset_alone`:
   * setting exactly one byte lights exactly one gate, so an adjacent-byte
   * transposition in the offset map cannot pass silently. */
  it("pins each of the seven gate bytes to its own offset alone", () => {
    const names = Object.keys(GATE_BYTE_OFFSET) as (keyof GateBytes)[];
    for (const name of names) {
      const offset = GATE_BYTE_OFFSET[name];
      const snap = parseInstSnapshot(blob([[offset, [1]]]));
      expect(snap).not.toBeNull();
      for (const other of names) {
        expect(snap!.gates[other]).toBe(other === name);
      }
    }
  });
});
