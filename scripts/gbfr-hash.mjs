/**
 * The game's custom XXHash32 id hashing.
 *
 * A JS port of `scripts/gbfr_hash.py`, itself a port of GBFRDataTools'
 * XXHash32Custom: seed 0x178A54A4, hardcoded lane seeds, and a `> 16`-not-
 * `>= 16` inner-loop exit. `scripts/gbfr-hash.test.mjs` pins it to vectors that
 * are literally keys in the shipped lang files, so the two ports cannot drift.
 *
 * Used to derive a summon body class hash from its `So####` id, which is what
 * lets the bridge map pair a class with a summons.json entry by IDENTITY rather
 * than by display name — two different summons can share a name.
 */

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

/** Multiply two u32s without losing the low bits to float64 rounding. */
const mul32 = (a, b) => Math.imul(a, b) >>> 0;

const rotl = (x, r) => (((x << r) | (x >>> (32 - r))) & 0xffffffff) >>> 0;

const readU32LE = (bytes, p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;

/** @returns the hash as eight lowercase hex digits, matching the lang file keys. */
export const gameXxhash32 = (text) => {
  const bytes = new TextEncoder().encode(text);
  const n = bytes.length;
  let p = 0;
  let h32 = 0x178a54a4;

  if (n >= 16) {
    let v1 = 0x2557311b;
    let v2 = 0x871fb76a;
    let v3 = 0x0133ecf3;
    let v4 = 0x62fc7342;

    for (;;) {
      v1 = mul32(rotl((v1 + mul32(readU32LE(bytes, p), PRIME32_2)) >>> 0, 13), PRIME32_1);
      v2 = mul32(rotl((v2 + mul32(readU32LE(bytes, p + 4), PRIME32_2)) >>> 0, 13), PRIME32_1);
      v3 = mul32(rotl((v3 + mul32(readU32LE(bytes, p + 8), PRIME32_2)) >>> 0, 13), PRIME32_1);
      v4 = mul32(rotl((v4 + mul32(readU32LE(bytes, p + 12), PRIME32_2)) >>> 0, 13), PRIME32_1);
      p += 16;
      // `<= 16`, not `< 16` — the quirk that makes this "Custom".
      if (n - p <= 16) break;
    }

    h32 = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  }

  h32 = (h32 + n) >>> 0;

  while (n - p >= 4) {
    h32 = mul32(rotl((h32 + mul32(readU32LE(bytes, p), PRIME32_3)) >>> 0, 17), PRIME32_4);
    p += 4;
  }

  while (p < n) {
    h32 = mul32(rotl((h32 + mul32(bytes[p], PRIME32_5)) >>> 0, 11), PRIME32_1);
    p += 1;
  }

  h32 = (h32 ^ (h32 >>> 15)) >>> 0;
  h32 = mul32(h32, PRIME32_2);
  h32 = (h32 ^ (h32 >>> 13)) >>> 0;
  h32 = mul32(h32, PRIME32_3);
  h32 = (h32 ^ (h32 >>> 16)) >>> 0;

  return h32.toString(16).padStart(8, "0");
};
