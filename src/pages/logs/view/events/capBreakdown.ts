/** What a cap-card row renders as. The card formats by kind rather than
 * pre-formatting here, so the projection stays a pure numeric fact and the
 * locale decides how it reads. `verdict` renders as a pass/fail mark. */
export type CapRowKind = "count" | "rate" | "percent" | "multiplier" | "verdict";

/** How a row participates in the attribution, when it is not a plain term.
 * `sub` itemizes the row above it (informational, outside the sum);
 * `conditional` is a potential the runtime state may or may not have granted,
 * excluded from the sum for the reason `deriveConditionalSources` gives. */
export type CapRowVariant = "sub" | "conditional";

export type CapRow = {
  key: string;
  labelKey: string;
  value: number;
  kind: CapRowKind;
  variant?: CapRowVariant;
  /** For rows named after a trait rather than a fixed label — the renderer
   * translates the trait id and ignores `labelKey`. */
  traitId?: number;
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

/** One cap-up contribution, as the fraction the formula adds (0.5 renders as
 * +50%). `traitId` set when the row is named after a specific trait. */
export type CapSource = {
  key: string;
  labelKey: string;
  value: number;
  traitId?: number;
};

/** Everything the caller could resolve about a hit's cap-up side.
 *
 * `ladderBase` is the independent base from the game's own shipped ladder —
 * when it is known, the game's total is `cap / base − 1` PER HIT and every
 * attributed term reconciles against that. Without it (old logs, unknown
 * character) the captured `record` is the best total available, which is the
 * pre-ladder behaviour. */
export type CapContext = {
  ladderBase: number | null;
  /** Whether the logged cap sits on the integer-percent grid the formula
   * produces from `ladderBase` — the per-hit validity check. `null` when the
   * ladder cannot say. */
  consistent: boolean | null;
  /** The captured per-player record channel for this hit's class — the fused
   * loadout total the game computed at load (overmasteries, summon bonuses,
   * every cap trait except plain DMG Cap, board nodes). */
  record: number | null;
  /** Informational components of `record`; rendered as sub-rows, never summed. */
  recordComponents: CapSource[];
  /** The plain DMG Cap trait — the one derived term OUTSIDE the record. */
  dmgCapTrait: number;
  /** Conditional traits at their maximum; rendered, never summed. */
  conditional: CapSource[];
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
const asPercent = (key: string, labelKey: string, fraction: number, extra?: Partial<CapRow>): CapRow => ({
  key,
  labelKey,
  value: round(fraction * 100, 2),
  kind: "percent",
  ...extra,
});

/** The cap-up block: the total, what explains it, and the honest remainder. */
const capUpRows = (cap: number, context: CapContext): CapRow[] => {
  const rows: CapRow[] = [];
  const { ladderBase, record } = context;

  // The game's own total for THIS hit, when the independent base is known;
  // the captured record otherwise. The base is divided out of the GAME's
  // number and never the reconstruction — dividing by a partial model would
  // overstate the base by exactly the share not yet attributed.
  const gameTotal = ladderBase !== null && ladderBase > 0 ? cap / ladderBase - 1 : null;
  const total = gameTotal ?? record;
  if (total === null || 1 + total <= 0) return rows;

  if (gameTotal !== null) {
    rows.push({ key: "basecap", labelKey: "ui.logs.cap-base", value: ladderBase!, kind: "count" });
    rows.push(asPercent("gamecapup", "ui.logs.cap-game-capup", gameTotal));
    if (context.consistent !== null) {
      rows.push({
        key: "verdict",
        labelKey: "ui.logs.cap-formula-check",
        value: context.consistent ? 1 : 0,
        kind: "verdict",
      });
    }
  } else {
    rows.push({
      key: "basecap",
      labelKey: "ui.logs.cap-base",
      value: round(cap / (1 + total), 2),
      kind: "count",
    });
  }

  let attributed = 0;
  if (record !== null) {
    rows.push(asPercent("capup", "ui.logs.cap-term-record", record));
    attributed += record;
    for (const component of context.recordComponents) {
      rows.push(asPercent(component.key, component.labelKey, component.value, { variant: "sub" }));
    }
  }
  if (gameTotal !== null && context.dmgCapTrait > 0) {
    rows.push(asPercent("dmgcap", "ui.logs.cap-source-dmg-cap", context.dmgCapTrait));
    attributed += context.dmgCapTrait;
  }
  for (const source of context.conditional) {
    rows.push(
      asPercent(source.key, source.labelKey, source.value, { variant: "conditional", traitId: source.traitId })
    );
  }

  // Against the game total: whatever no attributed term explains. Against the
  // record only: whatever share of the record its components fail to name.
  // Always rendered, however large — hiding it exactly when the model is doing
  // badly is when the reader most needs it.
  const unaccounted =
    gameTotal !== null ? gameTotal - attributed : total - context.recordComponents.reduce((sum, c) => sum + c.value, 0);
  rows.push(asPercent("unaccounted", "ui.logs.cap-unaccounted", unaccounted));
  return rows;
};

/** The rows for one hit.
 *
 * Everything past `damage` is derived from the cap fields, which are absent on
 * old logs. A hit without them reports the one number it does have rather than
 * rendering zeroes, which would read as "the cap was zero". */
export const capCardRows = (hit: CapHit, context?: CapContext): CapRow[] => {
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

  if (context !== undefined) {
    rows.push(...capUpRows(cap, context));
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
