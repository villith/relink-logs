/**
 * Generates `src-tauri/assets/damage-cap-tables.json` — the data layer of the
 * damage-cap breakdown (see docs: the parser reproduces the game's cap formula
 * and reports whatever it cannot attribute as an explicit residual).
 *
 * Run: `node scripts/extract-cap-tables.mjs`
 *
 * ## Where the curves come from, and why they are trustworthy
 *
 * The formula and the curve SCHEMA were reverse-engineered against
 * `gbfr204fast` (v2.0.4). The curve VALUES are not in the exe —
 * `FUN_1409c1cf0` looks them up in a hash map off the save root
 * `DAT_147c22bc0`, populated at load from the game's own data tables — but
 * they ARE in those tables: `chara_damage_limit.tbl` and
 * `chara_arts_damage_limit.tbl`, which the CLI below parses. The extraction
 * was verified against the running game on 2026-08-09: every row of both
 * runtime maps (32 + 31 keys x 30 rows, dumped by
 * `src-tauri/examples/cap_ladder_dump.rs`) agrees with this file exactly.
 *
 * Three keys are not characters. `58f4dbd4` is `xxhash32("SO0000")`, the curve
 * the builder uses for any hit whose class flags carry bit 7 (summons) —
 * looked up in the NORMAL map regardless of attack class. `28a87c8a` and
 * `3529cc90` are unidentified (likely NPC allies).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The game version every RVA and offset here was derived against. */
export const GAME_VERSION = "2.0.4";

/**
 * The game's own base-cap lookup: a piecewise-linear walk over (x, y) points
 * where x is the move's attack rate. Mirrors the loop in `FUN_1409c1cf0`, which
 * finds the first point whose x exceeds the rate and interpolates against its
 * predecessor, holding flat outside the range.
 *
 * The game reads each row's x at `+4` and y at `+8` and computes
 * `lo.y + (hi.y - lo.y) * (rate - lo.x) / (hi.x - lo.x)`, which is this
 * expression exactly. Both clamps are the game's too: a rate at or below the
 * first point yields that point's y (its `lVar12 == lVar10` path), and a rate
 * past the last yields the last point's y.
 */
export const interpolateCurve = (points, rate) => {
  if (points.length === 0) return 0;
  const first = points[0];
  if (rate <= first.x) return first.y;
  for (let i = 1; i < points.length; i += 1) {
    const hi = points[i];
    if (rate <= hi.x) {
      const lo = points[i - 1];
      const span = hi.x - lo.x;
      if (span <= 0) return hi.y;
      return lo.y + ((hi.y - lo.y) * (rate - lo.x)) / span;
    }
  }
  return points[points.length - 1].y;
};

/** Bytes per row of the two damage-limit tables: u32 key, f32 x, f32 y. */
const CURVE_ROW_SIZE = 12;

/**
 * One curve per character from a `chara_damage_limit`-shaped table.
 *
 * The table is `Character | AttackRate | DamageCap` (GBFRDataTools' headers),
 * which is exactly the `(key, x, y)` triple `FUN_1409c1cf0` walks — the RE read
 * x at `+4` and y at `+8` off each row, and those are the two floats here.
 *
 * Rows are sorted by rate because [`interpolateCurve`] mirrors the game's walk,
 * which exits at the FIRST point exceeding the rate; an unsorted curve would
 * bracket against the wrong pair and return a plausible wrong base.
 */
export const parseCurveTable = (buffer) => {
  const rowCount = Number(buffer.readBigInt64LE(0));
  if (8 + rowCount * CURVE_ROW_SIZE !== buffer.length) {
    throw new Error(`damage-limit row size is no longer ${CURVE_ROW_SIZE} bytes — re-derive the columns`);
  }

  const curves = {};
  for (let i = 0; i < rowCount; i += 1) {
    const offset = 8 + i * CURVE_ROW_SIZE;
    const key = buffer.readUInt32LE(offset).toString(16).padStart(8, "0");
    (curves[key] ??= []).push({
      x: buffer.readFloatLE(offset + 4),
      y: buffer.readFloatLE(offset + 8),
    });
  }
  for (const points of Object.values(curves)) points.sort((a, b) => a.x - b.x);
  return curves;
};

/**
 * Base-cap curves, keyed by attack class and then by the character hash the
 * game looks them up with (`actor+0x5ea8`, the xxhash32 of `PL####`).
 *
 * Filled from the game's own tables by the CLI below. `normal` is
 * `chara_damage_limit`, `arts` is `chara_arts_damage_limit` — the same pair the
 * builder selects between on `class_flags & 0x40000`, which is why there are
 * exactly two.
 *
 * This is what makes the breakdown falsifiable. Deriving the base by division
 * instead (`logged_cap / (1 + Σ terms)`) makes `base × multiplier == logged_cap`
 * an identity, so the model can never disagree with the game; with a real base
 * the game's own total cap-up is `logged_cap / base - 1`, and any term set can
 * be checked against it.
 */
export const CURVES = {};

/**
 * Cap contributions, keyed by the effect descriptor's vtable RVA as an 8-digit
 * hex string.
 *
 * Populated only from ids that BOTH round-trip to a class name through
 * `SymbolAt.java` and were observed live by the `hookdiag` cap oracle. An id
 * with neither is omitted, and the parser folds it into the residual rather
 * than showing a guessed name.
 *
 * Note `0` is not a valid key: the oracle reserves it for a provider call whose
 * participant set was not exactly one, i.e. a value it declines to attribute.
 */
export const TERMS = {
  // Round-tripped: SymbolAt 0x61418d8 -> FreeWorkEnhanceEffectPassive::vftable
  // (pointer[10], so the param-id slot at +0x38 sits inside it). Observed live
  // on 2026-08-08 across 2,069 capped hits — the ONLY descriptor class the
  // chokepoint carried in that capture, always param id 2 (cap-up).
  //
  // No coefficient is recorded: this class contributes a per-provider value
  // that varies per hit (0.15 to 0.45 observed), so it is not a constant to be
  // tabulated. The entry exists to give the id a name instead of "Other".
  "061418d8": {
    labelKey: "ui.logs.cap-term-free-work-enhance-effect-passive",
    // Observed under class_flags 0x0, 0x1, 0x3, 0x8, 0xa, 0xb, 0x21, 0x2b,
    // 0x108, 0x10000, 0x10008 — i.e. with and without the 0x10000 bit that
    // selects between the Normal / Skill / Skybound-Art cap-up fields.
    appliesTo: ["normal", "skill", "sba"],
  },
};

export const buildTables = () => ({
  version: GAME_VERSION,
  curves: CURVES,
  terms: TERMS,
});

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/assets/damage-cap-tables.json",
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The curve tables, when a directory of extracted tables is given:
  //   GBFRDataTools.exe extract -i <data.i> -f system/table/chara_damage_limit.tbl -o <dir>
  //   GBFRDataTools.exe extract -i <data.i> -f system/table/chara_arts_damage_limit.tbl -o <dir>
  //   node scripts/extract-cap-tables.mjs <dir>/system/table
  const tableDir = process.argv[2];
  if (tableDir) {
    for (const [cls, file] of [
      ["normal", "chara_damage_limit.tbl"],
      ["arts", "chara_arts_damage_limit.tbl"],
    ]) {
      CURVES[cls] = parseCurveTable(readFileSync(resolve(tableDir, file)));
    }
  }

  writeFileSync(OUTPUT, `${JSON.stringify(buildTables(), null, 2)}\n`);
  const curves = Object.keys(CURVES).length;
  const terms = Object.keys(TERMS).length;
  console.log(`wrote ${OUTPUT} (${curves} curve tables, ${terms} terms)`);
  if (curves === 0) {
    console.log(
      "curves EMPTY — run with the extracted table directory, or the card " +
        "loses its independent base cap. See the header comment.",
    );
  }
}
