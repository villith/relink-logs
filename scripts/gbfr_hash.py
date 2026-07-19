"""The game's custom-XXHash32 id hashing, shared by the .tbl generator scripts."""

import struct

PRIME32_1 = 0x9E3779B1
PRIME32_2 = 0x85EBCA77
PRIME32_3 = 0xC2B2AE3D
PRIME32_4 = 0x27D4EB2F
PRIME32_5 = 0x165667B1
M32 = 0xFFFFFFFF


def rotl(x, r):
    return ((x << r) | (x >> (32 - r))) & M32


def game_xxhash32(data: bytes) -> int:
    """The game's custom XXHash32 (seed 0x178A54A4, hardcoded lane seeds, and
    a `> 16`-not-`>= 16` inner loop — faithful port of GBFRDataTools'
    XXHash32Custom)."""
    p = 0
    n = len(data)
    h32 = 0x178A54A4
    if n >= 16:
        v1, v2, v3, v4 = 0x2557311B, 0x871FB76A, 0x0133ECF3, 0x62FC7342
        while True:
            for i, v in enumerate((v1, v2, v3, v4)):
                lane = struct.unpack_from("<I", data, p + i * 4)[0]
                v = rotl((v + lane * PRIME32_2) & M32, 13) * PRIME32_1 & M32
                if i == 0:
                    v1 = v
                elif i == 1:
                    v2 = v
                elif i == 2:
                    v3 = v
                else:
                    v4 = v
            p += 16
            if n - p <= 16:
                break
        h32 = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M32
    h32 = (h32 + n) & M32
    while n - p >= 4:
        h32 = rotl((h32 + struct.unpack_from("<I", data, p)[0] * PRIME32_3) & M32, 17) * PRIME32_4 & M32
        p += 4
    while p < n:
        h32 = rotl((h32 + data[p] * PRIME32_5) & M32, 11) * PRIME32_1 & M32
        p += 1
    h32 ^= h32 >> 15
    h32 = h32 * PRIME32_2 & M32
    h32 ^= h32 >> 13
    h32 = h32 * PRIME32_3 & M32
    h32 ^= h32 >> 16
    return h32


def cell_hash(value) -> int | None:
    """A hash_string sqlite cell is either the resolved id string or 8 raw hex
    chars; empty/None means no value."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        if len(value) == 8:
            try:
                return int(value, 16)
            except ValueError:
                pass
        return game_xxhash32(value.encode("ascii"))
    return int(value) & M32
