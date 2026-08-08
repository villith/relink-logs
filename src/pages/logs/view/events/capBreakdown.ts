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
};

const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** The rows for one hit.
 *
 * Everything past `damage` is derived from the cap fields, which are absent on
 * old logs. A hit without them reports the one number it does have rather than
 * rendering zeroes, which would read as "the cap was zero". */
export const capCardRows = (hit: CapHit): CapRow[] => {
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
