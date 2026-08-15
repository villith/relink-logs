import characterIdHashes from "@/assets/character-id-hashes.json";
import type { CharacterType } from "@/types";

import { selectCapUp, type PlayerCapUp } from "./capBreakdown";
import {
  DMG_CAP_TRAIT,
  collectCapFactors,
  evaluateCapFactors,
  type CapConditions,
  type CapFactor,
  type CapFactorReason,
  type CapFactorResult,
} from "./capFactors";
import { capConsistent, gameLadderTrace, ladderCurveFor, type LadderRow } from "./capLadder";
import { capClassOf, dmgCapTraitValue, type CapClass, type CapExclusion, type CapLoadout } from "./capSources";

/**
 * The damage-cap derivation with its working shown — every input, every
 * intermediate, every source considered, and the arithmetic that joined them.
 *
 * The hover card projects the same facts down to the dozen rows that fit in a
 * tooltip; this is the unabridged form the debug panel reads. Both draw their
 * numbers from the same primitives (`capLadder`, `capSources`), so the long
 * version can never say something the short one contradicts.
 *
 * Pure: no React, no i18n, no formatting decisions. Values carry their KIND and
 * the renderer decides how a count, a percentage or an f32 intermediate reads
 * in the reader's locale.
 */

/** How a line's number should read. `float` is deliberately unrounded — it is
 * for the f32 intermediates whose fractional part is the point. */
export type ExplainValue =
  | { kind: "count"; value: number }
  | { kind: "percent"; value: number }
  | { kind: "multiplier"; value: number }
  | { kind: "rate"; value: number }
  | { kind: "float"; value: number }
  | { kind: "hex"; value: number }
  | { kind: "text"; value: string }
  | { kind: "verdict"; value: boolean }
  /** The fact exists but this log cannot supply it — rendered as a dash, never
   * as a zero, which would claim the term contributed nothing. */
  | { kind: "absent" };

/** What names a line. A cap breakdown mixes prose labels, game entities and
 * bare identifiers, and they must not be flattened into one: an identifier put
 * through i18n becomes an untranslated key, and an entity spelled as a literal
 * stops following the player's language. */
export type ExplainName =
  | { kind: "key"; value: string }
  | { kind: "literal"; value: string }
  | { kind: "trait"; id: number }
  | { kind: "overmastery"; id: number }
  | { kind: "summon-bonus"; id: number }
  /** A master-board node. Keyed by character as well as id: the same node id
   * means a different effect on every character's board. */
  | { kind: "skillboard"; characterType: CharacterType; id: number }
  /** The runtime state that would resolve a factor, listed by name. Not a
   * label — an answer to "what would you have to know?". */
  | { kind: "params"; values: readonly string[] };

/** Why a line contributed nothing. The factor registry's own reasons, plus the
 * two placements only this projection knows about. */
export type ExplainReason = CapExclusion | CapFactorReason | "needs-params" | "gate-unrecorded";

export type ExplainLine = {
  key: string;
  name: ExplainName;
  value: ExplainValue;
  /** Where the number came from — a wire field, a table lookup, an expression.
   * Rendered beside the value; this is the column that answers "says who?". */
  source?: ExplainName;
  /** Itemization depth. 1 is a sub-row OF the line above it, which is how the
   * record's components read as inside the record rather than beside it. */
  depth?: number;
  /** Why this contributor added nothing. Present means "considered, rejected". */
  excluded?: ExplainReason;
  /** A term that is a total rather than an addend. */
  emphasis?: "total";
  /** The verdict was DERIVED — a window/state reconstruction — rather than
   * read off this hit's own recorded snapshot. Weaker provenance than a
   * measured line, even when it is not `excluded`: it says what the game
   * probably did, not what the hit itself proved. */
  inferred?: true;
};

export type ExplainSection = {
  key: string;
  titleKey: string;
  /** The expression in symbols, before substitution. */
  formula: string | null;
  /** The same expression with this hit's numbers in it. */
  substituted: string | null;
  /** Non-null when the section could not be derived, naming WHICH fact was
   * missing — "no curve for this character" and "this log predates the capture"
   * are different problems and a reader has to be able to tell them apart. */
  unavailableKey: string | null;
  /** A standing caveat about the section's meaning, not about this hit. */
  noteKey?: string;
  lines: ExplainLine[];
};

/** The damage-event fields this derivation reads. Narrower than the wire type
 * on purpose: the explanation cannot depend on anything it does not use. */
export type ExplainHit = {
  damage: number;
  damage_cap: number | null;
  base_damage: number | null;
  attack_rate: number | null;
  class_flags: number | null;
  flags: number;
  /** Raw DamageInstance window `0xC0..0x340`, as `DamageEvent.instance_snapshot`
   * carries it — `null` on old logs and on hits the hook could not capture.
   * Read by `damageExplain.ts` via `damageSnapshot.ts`'s `parseInstSnapshot`;
   * `capExplain.ts` itself does not interpret it. */
  instance_snapshot: number[] | null;
};

export type ExplainInput = {
  hit: ExplainHit;
  /** The acting player's captured per-class cap-up record. */
  capUp?: PlayerCapUp;
  /** The acting player's stored loadout, which the itemization reads. */
  loadout?: CapLoadout;
  /** The acting player's character — the key the base-cap ladder is looked up by. */
  characterType?: CharacterType;
  /** What the caller knows about the moment the hit landed. Absent fields leave
   * the factors that need them unresolved rather than assumed. */
  conditions?: CapConditions;
};

/** `"Pl0300"` -> `"079df0cc"`. The ladder maps are keyed by the hash, and the
 * panel shows the key it actually looked up rather than the name it started
 * from — a lookup that missed is the thing worth seeing. */
const HASH_BY_CHARACTER: Map<string, string> = new Map(
  Object.entries(characterIdHashes as Record<string, string>).map(([hash, name]) => [name, hash])
);

/** `xxhash32("SO0000")`, the shared summon curve. Mirrors `capLadder`'s own
 * constant, which is private to it; kept here only to NAME the key in the
 * panel, never to look one up. */
const SUMMON_CURVE_KEY = "58f4dbd4";

const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

const percent = (fraction: number): ExplainValue => ({ kind: "percent", value: round(fraction * 100, 2) });
const count = (value: number): ExplainValue => ({ kind: "count", value });
const text = (value: string): ExplainValue => ({ kind: "text", value });
const verdict = (value: boolean): ExplainValue => ({ kind: "verdict", value });

const key = (value: string): ExplainName => ({ kind: "key", value });
const literal = (value: string): ExplainName => ({ kind: "literal", value });

/**
 * A ladder coordinate at f32's own precision.
 *
 * The shipped rows are f32 values widened to f64, so a row authored as 0.6
 * reads back as 0.6000000238418579 — seventeen digits of which only seven mean
 * anything, since f32 cannot distinguish any of the rest. Trimming to exactly
 * that width loses no information and makes a bracket legible. The f32
 * INTERMEDIATES (span, offset, lerped) are deliberately not put through this:
 * there the trailing digits are the point.
 */
const coordText = (value: number): string => String(Number(Math.fround(value).toPrecision(7)));

/** A ladder row as the panel prints it: its position and its coordinates. The
 * index is what lets a reader find the row in the shipped table. */
const rowText = (row: LadderRow): string => `#${row.index} (${coordText(row.point.x)}, ${coordText(row.point.y)})`;

/** The attack-class decode. Every bit the builder tests is listed, set or not —
 * a bit shown as absent is what rules out the branch it would have taken. */
const classSection = (hit: ExplainHit): ExplainSection => {
  const flags = hit.class_flags;
  const capClass = capClassOf(flags);
  return {
    key: "class",
    titleKey: "ui.debug.cap-section-class",
    formula: null,
    substituted: null,
    unavailableKey: flags === null ? "ui.debug.cap-no-class" : null,
    lines: [
      {
        key: "flags",
        name: literal("class_flags"),
        value: flags === null ? { kind: "absent" } : { kind: "hex", value: flags },
        source: literal("instance+0xF0"),
      },
      // Tested in the builder's own order. The summon bit is the sign of the
      // flag byte and is read FIRST, which is why it wins over the arts bit.
      {
        key: "bit-summon",
        name: literal("0x80"),
        value: flags === null ? { kind: "absent" } : verdict((flags & 0x80) !== 0),
        source: key("ui.debug.cap-bit-summon"),
        depth: 1,
      },
      {
        key: "bit-arts",
        name: literal("0x40000"),
        value: flags === null ? { kind: "absent" } : verdict((flags & 0x40000) !== 0),
        source: key("ui.debug.cap-bit-arts"),
        depth: 1,
      },
      {
        key: "bit-skill",
        name: literal("0x10000"),
        value: flags === null ? { kind: "absent" } : verdict((flags & 0x10000) !== 0),
        source: key("ui.debug.cap-bit-skill"),
        depth: 1,
      },
      {
        key: "resolved",
        name: key("ui.debug.cap-resolved-class"),
        value: capClass === null ? { kind: "absent" } : text(capClass),
        source: key("ui.debug.cap-resolved-class-source"),
        emphasis: "total",
      },
    ],
  };
};

/** What the ladder walk resolved, or the first fact that stopped it. */
type BaseResolution = { base: number; section: ExplainSection };

const unavailableBase = (reason: string): BaseResolution => ({
  base: 0,
  section: {
    key: "base",
    titleKey: "ui.debug.cap-section-base",
    formula: BASE_FORMULA,
    substituted: null,
    unavailableKey: reason,
    lines: [],
  },
});

const BASE_FORMULA = "base = trunc( lo.y + (hi.y - lo.y) x (rate - lo.x) / (hi.x - lo.x) )";

/**
 * The independent base cap, from the game's own shipped ladder.
 *
 * Every step of the lookup is a line, because every step is a place the model
 * can be wrong: the wrong map, the wrong key, the wrong bracket, or arithmetic
 * done in the wrong precision.
 */
const baseSection = (hit: ExplainHit, characterType: CharacterType | undefined): BaseResolution => {
  const flags = hit.class_flags;
  if (flags === null) return unavailableBase("ui.debug.cap-no-class");

  const summon = (flags & 0x80) !== 0;
  const arts = (flags & 0x40000) !== 0;
  // The character only matters off the summon path — the shared SO0000 curve
  // is not keyed by the attacker.
  if (!summon && typeof characterType !== "string") return unavailableBase("ui.debug.cap-no-character");

  const curve = ladderCurveFor(characterType, flags);
  if (curve === null) return unavailableBase("ui.debug.cap-no-curve");
  if (hit.attack_rate === null) return unavailableBase("ui.debug.cap-no-rate");

  const curveKey = summon ? SUMMON_CURVE_KEY : HASH_BY_CHARACTER.get(characterType as string) ?? "";
  const trace = gameLadderTrace(curve, hit.attack_rate);

  const lines: ExplainLine[] = [
    {
      key: "map",
      name: key("ui.debug.cap-curve-map"),
      // The summon path reads the NORMAL map whatever the attack class is.
      value: text(!summon && arts ? "arts" : "normal"),
      source: literal(summon ? "0x80 -> SO0000" : arts ? "0x40000" : "-"),
    },
    {
      key: "curve-key",
      name: key("ui.debug.cap-curve-key"),
      value: text(curveKey),
      source: summon ? key("ui.debug.cap-curve-key-summon") : literal(String(characterType)),
    },
    { key: "rows", name: key("ui.debug.cap-curve-rows"), value: count(curve.length), source: literal("cap-tables") },
    {
      key: "rate",
      name: key("ui.debug.cap-rate"),
      value: { kind: "rate", value: hit.attack_rate },
      source: literal("event.attack_rate"),
    },
    {
      key: "branch",
      name: key("ui.debug.cap-walk-branch"),
      value: text(trace.branch),
      source: key("ui.debug.cap-walk-branch-source"),
    },
    {
      key: "lo",
      name: key("ui.debug.cap-walk-lo"),
      value: trace.lo === null ? { kind: "absent" } : text(rowText(trace.lo)),
      depth: 1,
    },
    {
      key: "hi",
      name: key("ui.debug.cap-walk-hi"),
      value: trace.hi === null ? { kind: "absent" } : text(rowText(trace.hi)),
      depth: 1,
    },
  ];

  if (trace.branch === "lerp") {
    // The f32 operands, at full precision. These are where a double-precision
    // mirror of the same expression diverges, so they are worth seeing.
    lines.push(
      { key: "rise", name: literal("hi.y - lo.y"), value: { kind: "float", value: trace.rise }, depth: 1 },
      { key: "span", name: literal("hi.x - lo.x"), value: { kind: "float", value: trace.span }, depth: 1 },
      { key: "offset", name: literal("rate - lo.x"), value: { kind: "float", value: trace.offset }, depth: 1 }
    );
  }
  lines.push(
    {
      key: "lerped",
      name: key("ui.debug.cap-walk-lerped"),
      value: { kind: "float", value: trace.lerped },
      source: key("ui.debug.cap-walk-lerped-source"),
      depth: 1,
    },
    {
      key: "result",
      name: key("ui.debug.cap-base"),
      value: count(trace.base),
      source: literal("gameLadderTrace"),
      emphasis: "total",
    }
  );

  const substituted =
    trace.branch === "lerp" && trace.lo !== null && trace.hi !== null
      ? `trunc( ${coordText(trace.lo.point.y)} + (${coordText(trace.hi.point.y)} - ${coordText(trace.lo.point.y)}) x (${hit.attack_rate} - ${coordText(trace.lo.point.x)}) / (${coordText(trace.hi.point.x)} - ${coordText(trace.lo.point.x)}) )`
      : null;

  return {
    base: trace.base,
    section: {
      key: "base",
      titleKey: "ui.debug.cap-section-base",
      formula: BASE_FORMULA,
      substituted,
      unavailableKey: trace.base > 0 ? null : "ui.debug.cap-no-base",
      lines,
    },
  };
};

/** What names a factor's row. Most contributors carry a game id the reader's
 * own language can translate; board nodes need the character too, and the
 * account terms carry a label key because they have no game entity at all. */
const factorName = (factor: CapFactor, characterType: CharacterType | undefined): ExplainName => {
  switch (factor.kind) {
    case "trait":
      return { kind: "trait", id: factor.id };
    case "overmastery":
      return { kind: "overmastery", id: factor.id };
    case "summon-bonus":
      return { kind: "summon-bonus", id: factor.id };
    case "board-node":
      return typeof characterType === "string"
        ? { kind: "skillboard", characterType, id: factor.id }
        : literal(`#${factor.id}`);
    case "account":
      return key(factor.label ?? "");
  }
};

/** The provenance column for a factor: what would settle it, or why nothing can. */
const factorSource = (factor: CapFactor, result: CapFactorResult): ExplainName | undefined => {
  // What the factor IS wins over what it needs: a boundary trait's two blocks
  // share one translated name, and without this they read as a duplicated row.
  if (factor.sourceKey !== undefined) return key(factor.sourceKey);
  if (result.state === "unknown" && result.missing.length > 0) return { kind: "params", values: result.missing };
  if (factor.kind === "overmastery" && result.state === "active") return key("ui.debug.cap-om-source");
  if (factor.kind === "board-node") return key("ui.debug.cap-board-source");
  if (factor.level !== null) return literal(`L${factor.level}`);
  return undefined;
};

/**
 * One evaluated factor as a line.
 *
 * A factor that did not apply still renders its POTENTIAL rather than a dash
 * whenever it has one: "+70%, if you had been above 75% HP" is a different
 * fact from "+0%", and collapsing the two is what made the old breakdown's
 * remainder unreadable.
 */
const factorLine = (
  factor: CapFactor,
  result: CapFactorResult,
  characterType: CharacterType | undefined,
  depth: number
): ExplainLine => {
  const shown =
    result.state === "active"
      ? percent(result.percent / 100)
      : result.potential > 0
        ? percent(result.potential / 100)
        : ({ kind: "absent" } as ExplainValue);

  const reason: ExplainReason | undefined =
    result.state === "active"
      ? undefined
      : result.reason ??
        (result.state === "unknown" ? "needs-params" : result.state === "inactive" ? "conditional" : undefined);

  return {
    key: factor.key,
    name: factorName(factor, characterType),
    value: shown,
    depth,
    ...(factorSource(factor, result) === undefined ? {} : { source: factorSource(factor, result) }),
    ...(reason === undefined ? {} : { excluded: reason }),
  };
};

/**
 * The cap-up side: the game's own total for this hit, the grid check that says
 * whether the formula could have produced it, and every term we can attribute
 * against it.
 *
 * The base is divided out of the GAME's number and never the reconstruction —
 * dividing by a partial model would overstate the base by exactly the share
 * not yet attributed.
 */
const capUpSection = (input: ExplainInput, base: number): ExplainSection => {
  const { hit, capUp, loadout, characterType, conditions = {} } = input;
  const cap = hit.damage_cap;
  const capClass = capClassOf(hit.class_flags);

  const blank = {
    key: "capup",
    titleKey: "ui.debug.cap-section-capup",
    formula: "game cap-up = cap / base - 1",
    substituted: null,
    lines: [] as ExplainLine[],
  };
  if (cap === null || cap <= 0) return { ...blank, unavailableKey: "ui.debug.cap-no-cap" };
  if (base <= 0) return { ...blank, unavailableKey: "ui.debug.cap-no-base" };

  const gameTotal = cap / base - 1;
  const record = selectCapUp(capUp, hit.class_flags);
  const dmgCapTrait = dmgCapTraitValue(loadout, capClass);

  const lines: ExplainLine[] = [
    { key: "cap", name: key("ui.debug.cap-logged"), value: count(cap), source: literal("event.damage_cap") },
    {
      key: "game",
      name: key("ui.debug.cap-game-total"),
      value: percent(gameTotal),
      source: literal("cap / base - 1"),
      emphasis: "total",
    },
  ];

  // The grid check: every cap-up source is an integer percent count, so the
  // game's own cap must be trunc(base x K/100) for some integer K. A cap
  // between grid points is one this base cannot have produced.
  const k = Math.round((100 * cap) / base);
  lines.push(
    { key: "grid-k", name: literal("K = round(100 x cap / base)"), value: count(k), depth: 1 },
    {
      key: "grid-predicted",
      name: literal("base x K / 100"),
      value: { kind: "float", value: round((base * k) / 100, 4) },
      depth: 1,
    },
    {
      key: "grid-verdict",
      name: key("ui.debug.cap-grid-check"),
      value: verdict(capConsistent(cap, base)),
      source: key("ui.debug.cap-grid-check-source"),
      depth: 1,
    }
  );

  let attributed = 0;
  lines.push({
    key: "record",
    name: key("ui.debug.cap-record"),
    value: record === null ? { kind: "absent" } : percent(record),
    source: capClass === null ? key("ui.debug.cap-no-class") : literal(`capUp.${capClass}`),
    depth: 1,
  });
  if (record !== null) attributed += record;

  const rows = evaluateCapFactors(collectCapFactors({ loadout, capClass }), conditions);

  // Everything the game fused into the record at load: the other cap traits,
  // the overmastery rolls, the summon bonuses, and the record-side board nodes
  // (counted-sigil totals). These are sub-rows OF the number above and never
  // add to the attributed total; the record already contains them.
  let explained = 0;
  for (const { factor, result } of rows.rows) {
    if (factor.placement === "channel") continue;
    // The plain DMG Cap trait renders here with the others because it IS a
    // trait the player equipped, but the game reads it through its own second
    // lookup, so it is not inside the record and is attributed separately.
    if (factor.kind === "trait" && factor.id === DMG_CAP_TRAIT) {
      lines.push({
        key: factor.key,
        name: { kind: "trait", id: factor.id },
        value: dmgCapTrait > 0 ? percent(dmgCapTrait) : { kind: "absent" },
        source: key("ui.debug.cap-dmg-cap-source"),
        depth: 2,
      });
      continue;
    }
    // A conditional trait belongs beside the record, not inside it: its live
    // value is runtime state the load-time fusion never saw.
    if (factor.kind === "trait" && factor.params.length > 0) continue;
    explained += result.percent;
    lines.push(factorLine(factor, result, characterType, 2));
  }

  // How much of the captured record these sub-rows actually name. This is the
  // number that says whether the reconstruction is working: the record is
  // ground truth, and whatever share of it stays unnamed is the real gap.
  if (record !== null) {
    lines.push({
      key: "record-explained",
      name: key("ui.debug.cap-record-explained"),
      value: percent(explained / 100),
      source: literal(`${round((explained / 100 / record) * 100, 1)}% of the record`),
      depth: 2,
    });
  }

  // Attributed even though it renders up in the trait list: the record does not
  // contain it, so the remainder below has to account for it separately.
  attributed += dmgCapTrait;

  // The channel-side factors, beside the record: the per-hit FreeWork terms
  // the record never contained. An ACTIVE one is a derived fact about this
  // hit (an always-on node, a group membership the coverage registry banked)
  // and attributes against the game total; an unresolved or inactive one
  // renders its potential and reason like any other rejected source.
  for (const { factor, result } of rows.rows) {
    if (factor.placement !== "channel") continue;
    if (result.state === "active") attributed += result.percent / 100;
    lines.push(factorLine(factor, result, characterType, 1));
  }

  // The conditional traits, beside the record rather than inside it. Rendered
  // at their potential, never summed: counting a maximum the runtime state may
  // not have granted would shrink the remainder by a number the formula did not
  // necessarily use.
  for (const { factor, result } of rows.rows) {
    if (factor.kind !== "trait" || factor.params.length === 0) continue;
    lines.push(factorLine(factor, result, characterType, 1));
  }

  lines.push({
    key: "unaccounted",
    name: key("ui.debug.cap-unaccounted"),
    value: percent(gameTotal - attributed),
    source: literal("game - attributed"),
    emphasis: "total",
  });

  // What the open factors are collectively worth, and the shortest list of
  // things a caller could learn to close them. Not part of the answer — the
  // size of the question.
  if (rows.unresolved > 0) {
    lines.push({
      key: "unresolved",
      name: key("ui.debug.cap-unresolved"),
      value: percent(rows.unresolved / 100),
      source: rows.missing.length > 0 ? { kind: "params", values: rows.missing } : key("ui.debug.cap-no-params"),
      depth: 1,
    });
  }

  return {
    ...blank,
    substituted: `${cap} / ${base} - 1`,
    unavailableKey: null,
    lines,
  };
};

/** The clamp itself: what the hit would have dealt, what bound it, and whether
 * the cap was the binding one. */
const clampSection = (hit: ExplainHit): ExplainSection => {
  const cap = hit.damage_cap;
  const base = hit.base_damage;
  const lines: ExplainLine[] = [
    {
      key: "damage",
      name: key("ui.debug.cap-damage-dealt"),
      value: count(hit.damage),
      source: literal("event.damage"),
    },
  ];

  if (cap === null || cap <= 0 || base === null || !Number.isFinite(base) || base <= 0) {
    return {
      key: "clamp",
      titleKey: "ui.debug.cap-section-clamp",
      formula: CLAMP_FORMULA,
      substituted: null,
      unavailableKey: "ui.debug.cap-no-precap",
      lines,
    };
  }

  const bound = Math.min(base, cap);
  lines.push(
    { key: "precap", name: key("ui.debug.cap-precap"), value: count(base), source: literal("event.base_damage") },
    { key: "cap", name: key("ui.debug.cap-logged"), value: count(cap), source: literal("event.damage_cap") },
    {
      key: "bound",
      name: key("ui.debug.cap-bound"),
      value: count(bound),
      source: literal("min(base_damage, damage_cap)"),
      emphasis: "total",
    },
    // >= : a hit exactly at cap IS at cap — matches hitSection's own verdict
    // in damageExplain.ts, so the two panels never disagree on the same hit.
    { key: "capped", name: key("ui.debug.cap-was-capped"), value: verdict(base >= cap), depth: 1 },
    {
      key: "overcap",
      name: key("ui.debug.cap-overcap"),
      value: percent(base / cap),
      source: literal("base_damage / damage_cap"),
      depth: 1,
    }
  );

  return {
    key: "clamp",
    titleKey: "ui.debug.cap-section-clamp",
    formula: CLAMP_FORMULA,
    substituted: `min(${base}, ${cap}) = ${bound}`,
    unavailableKey: null,
    lines,
  };
};

const CLAMP_FORMULA = "clamped = min( base_damage, damage_cap )";

/**
 * What happened to the number after the clamp.
 *
 * The chain is `cap x (m1 x m2) + additive`, and the builder stores none of the
 * three on the instance — so the log can only ever show their combined effect.
 * The panel says so rather than splitting a product it cannot observe.
 */
const postCapSection = (hit: ExplainHit): ExplainSection => {
  const cap = hit.damage_cap;
  const base = hit.base_damage;
  const formula = "post-cap = damage / min(base_damage, damage_cap)";
  if (cap === null || cap <= 0 || base === null || !Number.isFinite(base) || base <= 0) {
    return {
      key: "postcap",
      titleKey: "ui.debug.cap-section-postcap",
      formula,
      substituted: null,
      unavailableKey: "ui.debug.cap-no-precap",
      noteKey: "ui.debug.cap-postcap-note",
      lines: [],
    };
  }

  // The clamp bound, not the cap: an UNCAPPED hit was never clamped to the cap,
  // so dividing by the cap would understate its multiplier.
  const bound = Math.min(base, cap);
  return {
    key: "postcap",
    titleKey: "ui.debug.cap-section-postcap",
    formula,
    substituted: `${hit.damage} / ${bound}`,
    unavailableKey: null,
    noteKey: "ui.debug.cap-postcap-note",
    lines: [
      {
        key: "multiplier",
        name: key("ui.debug.cap-postcap-mult"),
        value: { kind: "multiplier", value: round(hit.damage / bound, 4) },
        source: literal("damage / bound"),
        emphasis: "total",
      },
      {
        key: "echo",
        name: key("ui.debug.cap-supp-echo"),
        value: verdict((hit.flags & (1 << 15)) !== 0),
        source: literal("flags bit 15"),
        depth: 1,
      },
    ],
  };
};

/** The whole derivation for one hit, in the order the game computes it. */
export const explainCapHit = (input: ExplainInput): ExplainSection[] => {
  const { base, section } = baseSection(input.hit, input.characterType);
  return [
    classSection(input.hit),
    section,
    capUpSection(input, base),
    clampSection(input.hit),
    postCapSection(input.hit),
  ];
};

export type { CapClass };
