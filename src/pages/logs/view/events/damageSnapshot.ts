/**
 * Read-time interpretation of `DamageEvent.instance_snapshot` — the raw
 * DamageInstance window `0xC0..0x340` (640 bytes) the hook now records per
 * hit, carrying seven gate bytes at `+0x15D..+0x163`.
 *
 * Offset map into the snapshot (window base `0xC0`). Mirrors
 * `src-tauri/src/parser/v1/damage_facts.rs` and the hook's
 * `INSTANCE_SNAPSHOT_START`/`INSTANCE_SNAPSHOT_LEN` constants
 * (`src-hook/src/hooks/damage.rs`) — three copies of one fact; change them
 * together.
 *
 * A hit whose snapshot is BUILDER-POPULATED (`u32@0x2D4 != 0`, the precap)
 * has MEASURED gate verdicts. An unpopulated snapshot — the remote-player
 * case, precap zero — means the bytes may mean "not computed here" rather
 * than "no", so its gates must not be read as measured. d0 (`+0xD0`) is NOT
 * part of the test: remote hits arrive with it nonzero off the network
 * (online log 2657), so it proves nothing about the local builder.
 *
 * Snapshots from the damage-TAKEN stream only prove bytes up to `+0x2D8` (the
 * apply path builds its instance on the stack) — every offset this reader
 * touches (`0x15D..0x163`, `0x2D4`) sits inside that proven span, so this
 * reader is unaffected by that caveat.
 */

const BASE = 0xc0;
const LEN = 0x340 - 0xc0;

export type GateBytes = {
  crit: boolean;
  weakPoint: boolean;
  backAttack: boolean;
  vulnAction: boolean;
  debuffed: boolean;
  overdrive: boolean;
  breakMode: boolean;
};

/** Each gate byte's game offset — the same order `GateByte::ALL` walks
 * Rust-side. Exported so callers (the trait registry's `source` strings) can
 * name the byte a verdict came from without re-deriving the offset. */
export const GATE_BYTE_OFFSET: Record<keyof GateBytes, number> = {
  crit: 0x15d,
  weakPoint: 0x15e,
  backAttack: 0x15f,
  vulnAction: 0x160,
  debuffed: 0x161,
  overdrive: 0x162,
  breakMode: 0x163,
};

export type ParsedSnapshot = {
  gates: GateBytes;
  builderPopulated: boolean;
};

const u32At = (bytes: number[], gameOffset: number): number => {
  const at = gameOffset - BASE;
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
};

/** Exact-length blobs only: a future hook changing the window changes the
 * length, and interpreting a differently-sized blob with THIS offset map
 * would read neighbours as gate bytes. */
export const parseInstSnapshot = (bytes: number[] | null | undefined): ParsedSnapshot | null => {
  if (bytes === null || bytes === undefined || bytes.length !== LEN) return null;
  const gate = (off: number): boolean => bytes[off - BASE] !== 0;
  return {
    gates: {
      crit: gate(GATE_BYTE_OFFSET.crit),
      weakPoint: gate(GATE_BYTE_OFFSET.weakPoint),
      backAttack: gate(GATE_BYTE_OFFSET.backAttack),
      vulnAction: gate(GATE_BYTE_OFFSET.vulnAction),
      debuffed: gate(GATE_BYTE_OFFSET.debuffed),
      overdrive: gate(GATE_BYTE_OFFSET.overdrive),
      breakMode: gate(GATE_BYTE_OFFSET.breakMode),
    },
    // Precap (+0x2D4) nonzero. Remote players' hits arrive deserialized
    // with precap zero but d0 (+0xD0) NONZERO (online log 2657), so d0 is
    // no proof the local builder ran and their gate bytes may mean "not
    // computed here" rather than "no": only a populated snapshot's bytes
    // are MEASURED.
    builderPopulated: u32At(bytes, 0x2d4) !== 0,
  };
};
