/**
 * Generates `src-tauri/assets/damage-cap-tables.json` — the data layer of the
 * damage-cap breakdown (see docs: the parser reproduces the game's cap formula
 * and reports whatever it cannot attribute as an explicit residual).
 *
 * Run: `node scripts/extract-cap-tables.mjs`
 *
 * ## What is derivable here, and what is not
 *
 * The formula and the curve SCHEMA were reverse-engineered against
 * `gbfr204fast` (v2.0.4) and are encoded below. The curve VALUES are not in the
 * exe: `FUN_1409c1cf0` looks a curve up by id in a hash map hanging off the
 * save root `DAT_147c22bc0`, populated at load from the game's data tables. So
 * this script emits a schema-correct file whose `curves` and `terms` are filled
 * in from observation, not from the binary — and emits them EMPTY until that
 * observation exists, because a guessed coefficient on a damage breakdown is
 * worse than an honest "unaccounted" row.
 */
import { writeFileSync } from "node:fs";
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

/**
 * Base-cap curves, keyed by the id the game hashes to find them.
 *
 * Empty until a runtime dump provides them. Until then the parser derives
 * `trunc(baseCap)` by division — `logged_cap / (1 + Σ terms)` — which costs the
 * independent cross-check and nothing else.
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
  writeFileSync(OUTPUT, `${JSON.stringify(buildTables(), null, 2)}\n`);
  const curves = Object.keys(CURVES).length;
  const terms = Object.keys(TERMS).length;
  console.log(`wrote ${OUTPUT} (${curves} curves, ${terms} terms)`);
  const empty = [curves === 0 && "curves", terms === 0 && "terms"].filter(Boolean);
  if (empty.length > 0) {
    console.log(
      `${empty.join(" and ")} empty by design — they come from a runtime dump ` +
        "and the live cap-oracle capture, not from the exe. See the header comment.",
    );
  }
}
