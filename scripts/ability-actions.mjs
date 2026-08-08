/**
 * Which ABILITY an action belongs to, read out of `pl####_action.msg`.
 *
 * The meter's currency is per-character action ids; ability art is keyed by
 * ability slot (`AB_PL####_NN`). `gen-game-icons.mjs` bridges the two, and
 * this module owns the half of that bridge that is pure game data, so it can
 * be tested without an atlas extraction.
 *
 * Three fields of an `ActionInfo` row carry the edge, and they disagree often
 * enough that the precedence below is the whole point:
 *
 *   - `relatedAbilityType_` — the ability's ORDINAL (slot minus one), or
 *     `NOT_AN_ABILITY` for the actions that belong to no ability at all
 *     (combos, guard, charged attacks). Verified against every tagged row in
 *     the 2.0.3 tables: 333 agree with their tag, and the 22 that do not are
 *     exactly the known junk tags — where this field is the one telling the
 *     truth. So it wins.
 *   - `abilityTag_` — only base actions carry one, and a few carry a wrong
 *     one. It is the fallback for the rows that claim no ordinal but are
 *     still tagged (Cagliostro's Mimic Doll, pl1800 10000).
 *   - `derivedId_` — the base action a variant follows from. This is what
 *     reaches the untagged, unnamed variants that neither of the above sees:
 *     Vane's successful counter (pl2700 1310), arts levels, follow-up hits.
 *     Before it existed here they were guessed at by joining English names,
 *     which cannot reach an action the language files never name.
 */

/** The `relatedAbilityType_` value meaning "this action is not an ability
 * cast". Every real ability ordinal is below it. */
export const NOT_AN_ABILITY = 16;

const TAG = /^AB_(?:PL|NP)\d{4}_(\d{2})$/;

const slotOfOrdinal = (ordinal) => String(ordinal + 1).padStart(2, "0");

/**
 * Ability slot per action id, for one character's `ActionInfo` rows.
 *
 * Actions with no ability behind them are simply absent — `undefined` is data
 * here, exactly as it is at the `abilityIconForAction` end of the bridge.
 *
 * @param {Array<Record<string, string>>} rows decoded `ActionInfo` rows
 * @returns {Map<number, string>} action id → two-digit slot
 */
export const abilitySlotsOf = (rows) => {
  const slots = new Map();
  const derivedFrom = new Map();

  for (const row of rows) {
    const id = Number(row.id_);
    if (!Number.isInteger(id)) continue;

    const ordinal = Number(row.relatedAbilityType_);
    if (Number.isInteger(ordinal) && ordinal >= 0 && ordinal < NOT_AN_ABILITY) {
      slots.set(id, slotOfOrdinal(ordinal));
      continue;
    }

    // No ordinal. A tag is the next best answer — but only for a row that
    // derives from nothing, because a junk tag on a variant (pl0000 1610
    // carries Decimate's) would otherwise beat the base action it follows.
    const base = Number(row.derivedId_);
    if (Number.isInteger(base) && base > 0) {
      derivedFrom.set(id, base);
      continue;
    }

    const tag = TAG.exec(row.abilityTag_ ?? "");
    if (tag) slots.set(id, tag[1]);
  }

  // Walk each unresolved action up its derivation chain. Bounded by the
  // number of links seen, so a cycle in the data ends the walk rather than
  // spinning — nothing guarantees `derivedId_` is acyclic.
  for (const [id, base] of derivedFrom) {
    let at = base;
    for (let hops = 0; hops <= derivedFrom.size; hops += 1) {
      const slot = slots.get(at);
      if (slot !== undefined) {
        slots.set(id, slot);
        break;
      }
      const next = derivedFrom.get(at);
      if (next === undefined) break;
      at = next;
    }
  }

  return slots;
};

/**
 * A comparison key for an action's own (Japanese) name.
 *
 * The last resort for an action whose slot resolves to an ability row the
 * character does not have: Id's dragonform claims a sixth ability ordinal,
 * but `ability.tbl` gives PL2000 five rows, so Ragnarok Form's art has to be
 * found under his human form. Action names are the join, and the two forms
 * spell the same ability differently ("ラグナロク・フォーム" against
 * "ラグナロクフォーム"), so the interpunct, both widths of space and the
 * 【アビリティ】 category prefix all come out.
 */
export const actionNameKey = (name) =>
  String(name ?? "")
    .replace(/【[^】]*】/g, "")
    .replace(/[・\s　]/g, "")
    .trim();
