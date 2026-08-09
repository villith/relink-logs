/** What a cap-card row renders as. The card formats by kind rather than
 * pre-formatting here, so the projection stays a pure numeric fact and the
 * locale decides how it reads. */
export type CapRowKind = "count" | "rate" | "percent" | "multiplier";

export type CapRow = {
  key: string;
  labelKey: string;
  value: number;
  kind: CapRowKind;
};

/** The fields of a damage event this card reads. Narrower than the wire type on
 * purpose: the projection cannot depend on anything it does not use. */
export type CapHit = {
  damage: number;
  damage_cap: number | null;
  base_damage: number | null;
  attack_rate: number | null;
  /** Which of the player's three cap-ups applied. Read by the CALLER to pick
   * one, not by `capCardRows`, which is handed the already-selected total. */
  class_flags: number | null;
};

/** One cap-up contribution reconstructed from the stored loadout, as the
 * fraction the formula adds (0.5 renders as +50%). */
export type CapSource = {
  key: string;
  labelKey: string;
  value: number;
};

/** The cap-up side of a hit: the game's own fused total, and whatever share of
 * it we have managed to attribute.
 *
 * The game hands over ONE number per attack class — it has already summed every
 * sigil, trait, node and bonus before the hook sees it. So `terms` is not a
 * decomposition handed to us; it is an independent reconstruction from the
 * loadout, and `totalCapUp` is what it must be checked against. The difference
 * is reported rather than hidden, which is what makes the model falsifiable. */
export type CapUp = {
  totalCapUp: number;
  terms: CapSource[];
};

/** Mirrors the Rust `PlayerCapUp`. */
export type PlayerCapUp = {
  normal: number | null;
  skill: number | null;
  sba: number | null;
};

/** The cap-up total that applied to a hit of this attack class.
 *
 * Mirrors the Rust `selected_cap_up`, and the order is the game builder's own:
 * it tests `0x10000` first, but the `0x40000` branch jumps past the skill
 * assignment, so a hit carrying both is a Skybound Art.
 *
 * `null` rather than a fallback when the hit's own class was never captured —
 * substituting another class's total would attribute a number the formula did
 * not use. */
export const selectCapUp = (capUp: PlayerCapUp | undefined, classFlags: number | null): number | null => {
  if (capUp === undefined || classFlags === null) return null;
  if (classFlags & 0x40000) return capUp.sba;
  if (classFlags & 0x10000) return capUp.skill;
  return capUp.normal;
};

const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** A fraction as a percentage row, e.g. 13.13 -> 1313. */
const asPercent = (key: string, labelKey: string, fraction: number): CapRow => ({
  key,
  labelKey,
  value: round(fraction * 100, 2),
  kind: "percent",
});

/** The rows for one hit.
 *
 * Everything past `damage` is derived from the cap fields, which are absent on
 * old logs. A hit without them reports the one number it does have rather than
 * rendering zeroes, which would read as "the cap was zero". */
export const capCardRows = (hit: CapHit, capUp?: CapUp): CapRow[] => {
  const rows: CapRow[] = [{ key: "damage", labelKey: "ui.logs.cap-damage-dealt", value: hit.damage, kind: "count" }];

  const cap = hit.damage_cap;
  const base = hit.base_damage;
  if (cap === null || cap <= 0 || base === null || !Number.isFinite(base) || base <= 0) {
    return rows;
  }

  rows.push({ key: "cap", labelKey: "ui.logs.cap-logged", value: cap, kind: "count" });
  if (hit.attack_rate !== null) {
    rows.push({ key: "mv", labelKey: "ui.logs.cap-mv", value: hit.attack_rate, kind: "rate" });
  }

  // The cap-up block, when the log carries a cap-up for this hit's player and
  // attack class. The base is divided out of the GAME's multiplier and never
  // the reconstructed one: the terms are a partial reconstruction, so dividing
  // by them would overstate the base by exactly the part not yet attributed.
  if (capUp !== undefined && Number.isFinite(capUp.totalCapUp) && 1 + capUp.totalCapUp > 0) {
    rows.push({
      key: "basecap",
      labelKey: "ui.logs.cap-base",
      value: round(cap / (1 + capUp.totalCapUp), 2),
      kind: "count",
    });
    rows.push(asPercent("capup", "ui.logs.cap-term-record", capUp.totalCapUp));
    for (const term of capUp.terms) {
      rows.push(asPercent(term.key, term.labelKey, term.value));
    }
    // Always rendered, however large — hiding it exactly when the model is
    // doing badly is when the reader most needs it.
    const attributed = capUp.terms.reduce((sum, term) => sum + term.value, 0);
    rows.push(asPercent("unaccounted", "ui.logs.cap-unaccounted", capUp.totalCapUp - attributed));
  }

  rows.push({ key: "base", labelKey: "ui.logs.cap-precap-base", value: base, kind: "count" });
  rows.push({
    key: "overcap",
    labelKey: "ui.logs.cap-overcap",
    value: round((base / cap) * 100, 2),
    kind: "percent",
  });
  // The clamp bound is min(base, cap): an UNCAPPED hit was never clamped to the
  // cap, so dividing by the cap would understate its multiplier.
  rows.push({
    key: "postcap",
    labelKey: "ui.logs.cap-postcap-mult",
    value: round(hit.damage / Math.min(base, cap), 3),
    kind: "multiplier",
  });

  return rows;
};
