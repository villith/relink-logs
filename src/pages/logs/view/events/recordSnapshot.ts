/**
 * Read-time interpretation of `DamageEvent.record_snapshot` — the raw
 * player-record window `record+0x18..0x28` (16 bytes) the hook records per
 * hit, off the attacker's own per-player stats record.
 *
 * Offset map into the snapshot (window base `0x18`). Mirrors the hook's
 * `RECORD_SNAPSHOT_START`/`RECORD_SNAPSHOT_LEN` constants
 * (`src-hook/src/hooks/damage.rs`) — two copies of one fact, change them
 * together. There is no Rust-side (parser) interpreter for this window yet;
 * the hook constants are its only counterpart.
 *
 * Both known fields are `f32`, per the oracle that first read them
 * (`dmg_oracle.rs`'s `RECORD_DMG_SBA`/`RECORD_DMG_SKILL`, both fetched with
 * `read_f32_guarded` — NOT an integer reinterpreted as a percent). The
 * damage-head formula tree applies each as `1 + v * 0.01` ("f24 | class
 * record dmg%"), the same `x0.01` convention every other %-scaled record/
 * trait field in that doc uses, so the float itself IS the percent number
 * (e.g. `15.0` -> +15%, not `0.15`).
 */

const BASE = 0x18;
const LEN = 0x10;

/** `record+0x1C`: SBA class dmg%. */
const SBA_OFFSET = 0x1c;
/** `record+0x24`: Skill class dmg%. */
const SKILL_OFFSET = 0x24;

const f32At = (bytes: number[], gameOffset: number): number => {
  const at = gameOffset - BASE;
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, bytes[at + i]);
  return view.getFloat32(0, /* littleEndian */ true);
};

export type ParsedRecordSnapshot = {
  /** `record+0x1C`, as a percent number (`15` means `+15%`, applied as
   * `1 + v * 0.01`). */
  sba: number;
  /** `record+0x24`, same encoding as `sba`. */
  skill: number;
};

/** Exact-length blobs only: a future hook changing the window changes the
 * length, and interpreting a differently-sized blob with THIS offset map
 * would read neighbours as these fields. */
export const parseRecordSnapshot = (bytes: number[] | null | undefined): ParsedRecordSnapshot | null => {
  if (bytes === null || bytes === undefined || bytes.length !== LEN) return null;
  return {
    sba: f32At(bytes, SBA_OFFSET),
    skill: f32At(bytes, SKILL_OFFSET),
  };
};
