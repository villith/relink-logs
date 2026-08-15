import damageTraitValues from "@/assets/damage-trait-values.json";
import type { LogEvent } from "@/types";
import { computeCombinedTraits } from "@/utils";

import statusClasses from "../../../../../src-tauri/assets/status-classes.json";
import type { ExplainHit, ExplainLine, ExplainSection, ExplainValue } from "./capExplain";
import type { CapConditions } from "./capFactors";
import { capClassOf, type CapLoadout } from "./capSources";
import { GATE_BYTE_OFFSET, parseInstSnapshot, type GateBytes, type ParsedSnapshot } from "./damageSnapshot";

/**
 * The damage-calculation walk for one hit, in the game's own order — the
 * milestone-2 counterpart of `explainCapHit`. Shows the RE'd formula shape
 * with this hit's recorded inputs substituted, values the equipped damage
 * traits from the shipped tables, and states every un-captured input as an
 * explicit exclusion instead of omitting it.
 *
 * Pure like `capExplain`: no React, no i18n, no formatting.
 */

export type DamageTraitEntry = {
  key: string;
  name: string;
  textless?: boolean;
  values: Record<string, number[]>;
};

export type DamageTraitTable = { version: string; traits: Record<string, DamageTraitEntry> };

const DEFAULT_TABLE = damageTraitValues as DamageTraitTable;

/** How a chain trait decides whether this hit used it. */
type Gate =
  | { kind: "class-flag"; bit: number } // resolvable from class_flags
  | { kind: "flags-bit"; bit: number } // resolvable from flags (low 32 bits only are used)
  // The named byte in DamageEvent.instance_snapshot (+0x15D..+0x163) that
  // gates this slot — a real verdict on a builder-populated snapshot,
  // gate-unrecorded otherwise (an old log, or a remote player's hit).
  | { kind: "gate-byte"; byte: keyof GateBytes }
  | { kind: "hp-curve" } // Stamina/Enmity: value is curve-scaled by attacker HP
  | { kind: "hp-gate"; cmp: "gte" | "lte" } // Celestial Lumen/Nyx: threshold in `hpGate` slot
  | { kind: "conditional" }; // runtime state beyond any capture (Less Is More, Roll of the Die…)

type DamageTraitSpec = {
  id: number;
  section: "chain" | "crit" | "postcap" | "taken";
  /** One row per labeled slot; a slot named `hpGate`/`rateMin`/`rateMax` is a
   * threshold, meant to render as depth-1 context under its trait rather than
   * as a value row of its own — not yet rendered; `CONTEXT_SLOTS` only
   * suppresses it from the value list today. */
  gates: Record<string, Gate>;
};

/** The registry: which section each RE'd trait reports under and what gates
 * each of its value slots. Tags and gates are the formula tree's. */
const DAMAGE_TRAITS: DamageTraitSpec[] = [
  { id: 0x1c360c63, section: "chain", gates: { value: { kind: "class-flag", bit: 0x2 } } },
  { id: 0x8d078597, section: "chain", gates: { value: { kind: "class-flag", bit: 0x40 } } },
  { id: 0xeae321eb, section: "chain", gates: { value: { kind: "class-flag", bit: 0x10000 } } },
  {
    id: 0x3fec5f80,
    section: "chain",
    gates: { link: { kind: "class-flag", bit: 0x20000 }, sba: { kind: "class-flag", bit: 0x40000 } },
  },
  { id: 0xa7a45f28, section: "chain", gates: { value: { kind: "class-flag", bit: 0x20 } } },
  { id: 0xb360801d, section: "chain", gates: { value: { kind: "flags-bit", bit: 0x8 } } },
  {
    id: 0x6b694d6d,
    section: "chain",
    gates: {
      weakpoint: { kind: "gate-byte", byte: "weakPoint" },
      backattack: { kind: "gate-byte", byte: "backAttack" },
    },
  },
  // SKILL_015_00 (internal, no text) — ×(1.2 + t%) gated on +0x160, the
  // authored vulnerable-action window (INFERRED downed/system state).
  { id: 0x54401e12, section: "chain", gates: { value: { kind: "gate-byte", byte: "vulnAction" } } },
  { id: 0x8f502f0d, section: "chain", gates: { value: { kind: "conditional" } } },
  { id: 0x84078cb0, section: "chain", gates: { value: { kind: "conditional" } } },
  { id: 0xdc225c96, section: "chain", gates: { value: { kind: "conditional" } } },
  {
    id: 0x82ce278d,
    section: "chain",
    gates: {
      tier0: { kind: "conditional" },
      tier1: { kind: "conditional" },
      tier2: { kind: "conditional" },
      tier3: { kind: "conditional" },
    },
  },
  { id: 0x1568e0e4, section: "chain", gates: { value: { kind: "conditional" } } },
  { id: 0xaefeb1bc, section: "chain", gates: { atkLow: { kind: "conditional" }, atkHigh: { kind: "conditional" } } },
  { id: 0x2fc8fbff, section: "chain", gates: { value: { kind: "hp-curve" } } },
  { id: 0x3f488339, section: "chain", gates: { value: { kind: "hp-curve" } } },
  // Injury to Insult — byte+0x161: target debuffed.
  { id: 0x4f1a3683, section: "chain", gates: { value: { kind: "gate-byte", byte: "debuffed" } } },
  // Overdrive Assassin — byte+0x162: target in Overdrive.
  { id: 0xa9d17f55, section: "chain", gates: { value: { kind: "gate-byte", byte: "overdrive" } } },
  // Break Assassin — byte+0x163: target in Break.
  { id: 0xac9674c1, section: "chain", gates: { value: { kind: "gate-byte", byte: "breakMode" } } },
  { id: 0xa7726190, section: "chain", gates: { value: { kind: "hp-gate", cmp: "gte" } } },
  { id: 0x0de887a0, section: "chain", gates: { value: { kind: "hp-gate", cmp: "lte" } } },
  { id: 0xc0979a17, section: "crit", gates: { value: { kind: "conditional" } } },
  { id: 0xc35b111b, section: "crit", gates: { value: { kind: "class-flag", bit: 0x2 } } },
  // SKILL_099_00 (internal, no text) — crit rate on back attack, gated on
  // the SAME byte+0x15F as 0x6b694d6d's back-attack slot, not on the crit
  // byte itself.
  { id: 0x4b400b01, section: "crit", gates: { value: { kind: "gate-byte", byte: "backAttack" } } },
  {
    id: 0x333e5862,
    section: "chain",
    gates: {
      band4x: { kind: "conditional" },
      band3x: { kind: "conditional" },
      band2x: { kind: "conditional" },
      band1: { kind: "conditional" },
    },
  },
  { id: 0x73220725, section: "postcap", gates: { value: { kind: "conditional" } } },
  { id: 0xa898e283, section: "postcap", gates: { value: { kind: "conditional" } } },
  { id: 0x90f61dc3, section: "postcap", gates: { value: { kind: "conditional" } } },
];

/** Slots that are thresholds/context, not contributions. */
const CONTEXT_SLOTS = new Set(["hpGate", "rateMin", "rateMax"]);

const hex8 = (id: number) => id.toString(16).padStart(8, "0");

const count = (value: number): ExplainValue => ({ kind: "count", value });
const absent: ExplainValue = { kind: "absent" };

export type DamageExplainInput = {
  hit: ExplainHit;
  loadout?: CapLoadout;
  conditions?: CapConditions;
  /** Status ids this log has seen applied with an Amplify status class. */
  amplifyStatusIds?: ReadonlySet<number>;
};

/** min(base, cap) — what the post-cap chain starts from. Null when
 * `base_damage` itself is unrecorded; falls back to `base_damage` alone when
 * only `damage_cap` is missing, since an uncapped precap is its own bound. */
const clampedPrecap = (hit: ExplainHit): number | null => {
  if (hit.base_damage === null) return null;
  if (hit.damage_cap === null) return hit.base_damage;
  return Math.min(hit.base_damage, hit.damage_cap);
};

const hitSection = (hit: ExplainHit): ExplainSection => {
  const clamped = clampedPrecap(hit);
  const capped = hit.base_damage !== null && hit.damage_cap !== null ? hit.base_damage >= hit.damage_cap : null;
  return {
    key: "dmg-hit",
    titleKey: "ui.debug.dmg-sec-hit",
    formula: "final = postcap(min(precap@0x2D4, cap@0x2BC))",
    substituted: clamped === null ? null : `${hit.damage.toLocaleString()} = postcap(${clamped.toLocaleString()})`,
    unavailableKey: null,
    lines: [
      {
        key: "final",
        name: { kind: "literal", value: "damage" },
        value: count(hit.damage),
        source: { kind: "literal", value: "DamageEvent.damage" },
        emphasis: "total",
      },
      {
        key: "precap",
        name: { kind: "literal", value: "base_damage (precap)" },
        value: hit.base_damage === null ? absent : count(hit.base_damage),
        source: { kind: "literal", value: "inst+0x2D4" },
      },
      {
        key: "cap",
        name: { kind: "literal", value: "damage_cap" },
        value: hit.damage_cap === null ? absent : count(hit.damage_cap),
        source: { kind: "literal", value: "inst+0x2BC" },
      },
      {
        key: "capped",
        name: { kind: "key", value: "ui.debug.dmg-line-capped" },
        value: capped === null ? absent : { kind: "verdict", value: capped },
        source: { kind: "literal", value: "base_damage >= damage_cap" },
      },
      {
        key: "mv",
        name: { kind: "literal", value: "attack_rate (MV)" },
        value: hit.attack_rate === null ? absent : { kind: "rate", value: hit.attack_rate },
        source: { kind: "literal", value: "inst+0xE0" },
      },
      {
        key: "flags",
        name: { kind: "literal", value: "flags" },
        value: { kind: "hex", value: hit.flags },
        source: { kind: "literal", value: "inst+0xE8" },
      },
      {
        key: "class-flags",
        name: { kind: "literal", value: "class_flags" },
        value: hit.class_flags === null ? absent : { kind: "hex", value: hit.class_flags },
        source: { kind: "literal", value: "inst+0xF0" },
      },
    ],
  };
};

/** One trait slot as a line: value from the table at the combined level, gate
 * verdict from the hit. */
const traitLine = (
  spec: DamageTraitSpec,
  slot: string,
  gate: Gate,
  entry: DamageTraitEntry,
  level: number,
  hit: ExplainHit,
  conditions: CapConditions,
  snapshot: ParsedSnapshot | null
): ExplainLine => {
  const perLevel = entry.values[slot] ?? [];
  const value = perLevel[Math.min(level, perLevel.length) - 1];
  const line: ExplainLine = {
    key: `trait-${hex8(spec.id)}-${slot}`,
    name: { kind: "trait", id: spec.id },
    value: value === undefined ? absent : { kind: "percent", value },
    source: { kind: "literal", value: `${entry.key} L${level}${slot === "value" ? "" : ` [${slot}]`}` },
  };
  switch (gate.kind) {
    case "class-flag":
      if (hit.class_flags === null) line.excluded = "gate-unrecorded";
      else if ((hit.class_flags & gate.bit) === 0) line.excluded = "conditional";
      break;
    case "flags-bit":
      if ((hit.flags & gate.bit) === 0) line.excluded = "conditional";
      break;
    case "gate-byte": {
      const offsetHex = GATE_BYTE_OFFSET[gate.byte].toString(16).toUpperCase();
      if (snapshot !== null && snapshot.builderPopulated) {
        // A measured verdict: say so and name the byte it came from, styled
        // like the hp-gate case's threshold source below.
        line.source = {
          kind: "literal",
          value: `${entry.key} L${level}${slot === "value" ? "" : ` [${slot}]`}, inst+0x${offsetHex}`,
        };
        if (!snapshot.gates[gate.byte]) line.excluded = "conditional";
      } else {
        line.excluded = "gate-unrecorded";
      }
      break;
    }
    case "conditional":
      line.excluded = "conditional";
      break;
    case "hp-curve":
      // Value applies, scaled by the authored HP ramp we do not ship. Leave it
      // un-excluded but say what scales it.
      line.source = {
        kind: "literal",
        value: `${entry.key} L${level} x curve(hp ${
          conditions.hpRatio === undefined ? "?" : `${Math.round(conditions.hpRatio * 100)}%`
        })`,
      };
      break;
    case "hp-gate": {
      const gateRow = entry.values.hpGate ?? [];
      const threshold = gateRow[Math.min(level, gateRow.length) - 1];
      // The threshold is a fact about the TABLE, not about this hit — show it
      // whenever it exists, even if the hp ratio needed to evaluate the gate
      // was never captured. Only a genuinely missing table row falls back to
      // the generic `L<n>` source.
      if (threshold !== undefined) {
        line.source = { kind: "literal", value: `${entry.key} L${level}, hp ${gate.cmp} ${threshold}%` };
      }
      if (conditions.hpRatio === undefined || threshold === undefined) {
        line.excluded = "gate-unrecorded";
      } else {
        const pct = conditions.hpRatio * 100;
        const met = gate.cmp === "gte" ? pct >= threshold : pct <= threshold;
        if (!met) line.excluded = "conditional";
      }
      break;
    }
  }
  return line;
};

/** Every equipped trait's rows for one panel section, in registry order. */
const traitLines = (
  sectionKey: DamageTraitSpec["section"],
  hit: ExplainHit,
  loadout: CapLoadout | undefined,
  conditions: CapConditions,
  table: DamageTraitTable,
  snapshot: ParsedSnapshot | null
): ExplainLine[] => {
  if (loadout === undefined) return [];
  const combined = new Map(computeCombinedTraits(loadout).map((trait) => [trait.id, trait.level]));
  const lines: ExplainLine[] = [];
  for (const spec of DAMAGE_TRAITS) {
    if (spec.section !== sectionKey) continue;
    const level = combined.get(spec.id);
    if (level === undefined) continue;
    const entry = table.traits[hex8(spec.id)];
    if (entry === undefined) continue;
    for (const [slot, gate] of Object.entries(spec.gates)) {
      if (CONTEXT_SLOTS.has(slot)) continue;
      lines.push(traitLine(spec, slot, gate, entry, level, hit, conditions, snapshot));
    }
  }
  return lines;
};

const chainSection = (
  hit: ExplainHit,
  loadout: CapLoadout | undefined,
  conditions: CapConditions,
  table: DamageTraitTable,
  snapshot: ParsedSnapshot | null
): ExplainSection => ({
  key: "dmg-chain",
  titleKey: "ui.debug.dmg-sec-chain",
  formula: "chain = atk x pct x slice vfns x class-gated traits x addgrp",
  substituted: null,
  unavailableKey: loadout === undefined ? "ui.debug.cap-no-loadout" : null,
  noteKey: "ui.debug.dmg-note-chain",
  lines: [
    ...traitLines("chain", hit, loadout, conditions, table, snapshot),
    {
      key: "status-atk",
      name: { kind: "key", value: "ui.debug.dmg-line-status-atk" },
      value: conditions.buffs === undefined ? absent : { kind: "text", value: `${conditions.buffs.length} held` },
      source: { kind: "literal", value: "FUN_140bd3d90 walk" },
      excluded: "value-unrecorded",
    },
  ],
});

const critSection = (
  hit: ExplainHit,
  loadout: CapLoadout | undefined,
  conditions: CapConditions,
  table: DamageTraitTable,
  snapshot: ParsedSnapshot | null
): ExplainSection => {
  const measured = snapshot !== null && snapshot.builderPopulated;
  const critRollLine: ExplainLine = {
    key: "crit-roll",
    name: { kind: "key", value: "ui.debug.dmg-line-crit-roll" },
    value: measured ? { kind: "verdict", value: snapshot!.gates.crit } : absent,
    source: { kind: "literal", value: "inst+0x15D (roll vs FUN_141f42d40 rate)" },
    ...(measured ? {} : { excluded: "gate-unrecorded" as const }),
  };
  return {
    key: "dmg-crit",
    titleKey: "ui.debug.dmg-sec-crit",
    formula: "critMult = 1 + (crit dmg base + Critical Hit DMG + record + agg)",
    substituted: null,
    unavailableKey: loadout === undefined ? "ui.debug.cap-no-loadout" : null,
    lines: [...traitLines("crit", hit, loadout, conditions, table, snapshot), critRollLine],
  };
};

const classSection = (hit: ExplainHit): ExplainSection => {
  const cls = capClassOf(hit.class_flags);
  return {
    key: "dmg-class",
    titleKey: "ui.debug.dmg-sec-class",
    formula: "x (1 + record dmg% x 0.01) x difficulty",
    substituted: null,
    unavailableKey: null,
    lines: [
      {
        key: "attack-class",
        name: { kind: "key", value: "ui.debug.dmg-line-attack-class" },
        value: cls === null ? absent : { kind: "text", value: cls },
        source: { kind: "literal", value: "class_flags 0x10000/0x40000" },
      },
      {
        key: "record",
        name: { kind: "key", value: "ui.debug.dmg-line-record" },
        value: absent,
        source: { kind: "literal", value: "record+0x24 (Skill) / +0x1C (SBA)" },
        excluded: "value-unrecorded",
      },
      {
        key: "difficulty",
        name: { kind: "key", value: "ui.debug.dmg-line-difficulty" },
        value: absent,
        source: { kind: "literal", value: "DAT_147beb720 rows" },
        excluded: "value-unrecorded",
      },
    ],
  };
};

const takenSection = (hit: ExplainHit): ExplainSection => {
  const base = hit.base_damage;
  // d4 is f32-valued, so floor (not ceil) of the open lower bound is the
  // conservative display: it can only widen the shown band, never exclude
  // the true d4 that produced this base_damage.
  const band = base === null ? null : `${Math.floor(base / 1.05).toLocaleString()} .. ${base.toLocaleString()}`;
  return {
    key: "dmg-taken",
    titleKey: "ui.debug.dmg-sec-taken",
    formula: "precap = takenChain(d4); d4 <= precap < 1.05 x d4 (enemy targets)",
    substituted: band === null ? null : `d4 in (${band}]`,
    unavailableKey: null,
    noteKey: "ui.debug.dmg-note-variance",
    lines: [
      {
        key: "variance-band",
        name: { kind: "key", value: "ui.debug.dmg-line-variance-band" },
        value: band === null ? absent : { kind: "text", value: band },
        source: { kind: "literal", value: "FUN_140b283d0: d4 += d4 x 0.05 x rand01" },
      },
      {
        key: "taken-side",
        name: { kind: "key", value: "ui.debug.dmg-line-taken-side" },
        value: absent,
        source: { kind: "literal", value: "Em vfn+0x728/+0x730; Pl DEF chain" },
        excluded: "value-unrecorded",
      },
    ],
  };
};

type StatusClassTable = Record<string, { class: string; name: string }>;

/** Status ids this log applied with an IStatusAmplifyBuff-derived class.
 *
 * The post-cap chain sums BOTH signed variants of the family
 * (ΣIStatusAmplifyBuff ±, per the RE handoff) — both concrete classes,
 * StatusAmplifyDamageBuff and StatusAmplifyDamageDebuff, carry "Amplify" in
 * their RTTI name and participate in the signed vfn+0xA8 walk, so the debuff
 * side is not a spurious match, it is the negative term of the same sum. */
export const amplifyStatusIds = (
  events: LogEvent[],
  table: StatusClassTable = statusClasses as StatusClassTable
): Set<number> => {
  const out = new Set<number>();
  for (const [, payload] of events) {
    if (!("StatusApply" in payload)) continue;
    const apply = payload.StatusApply;
    if (apply.status_class === null) continue;
    const entry = table[String(apply.status_class)];
    if (entry !== undefined && entry.class.includes("Amplify")) out.add(apply.status_id);
  }
  return out;
};

const postcapSection = (
  hit: ExplainHit,
  loadout: CapLoadout | undefined,
  conditions: CapConditions,
  amplifyIds: ReadonlySet<number>,
  table: DamageTraitTable,
  snapshot: ParsedSnapshot | null
): ExplainSection => {
  const clamped = clampedPrecap(hit);
  const capped = hit.base_damage !== null && hit.damage_cap !== null && hit.base_damage >= hit.damage_cap;
  const ratio = clamped !== null && clamped > 0 ? hit.damage / clamped : null;
  const heldAmplify = (conditions.buffs ?? []).filter((id) => amplifyIds.has(id));
  const lines: ExplainLine[] = [
    {
      key: "ratio",
      name: { kind: "key", value: "ui.debug.dmg-line-postcap-ratio" },
      value: ratio === null ? absent : { kind: "multiplier", value: ratio },
      source: { kind: "literal", value: "damage / min(base_damage, damage_cap)" },
      emphasis: "total",
    },
    {
      key: "elemental",
      name: { kind: "key", value: "ui.debug.dmg-line-elemental" },
      value: absent,
      source: { kind: "literal", value: "vfn+0xA0: 1 + base + agg(0x1A) + record+0x5964%" },
      excluded: "value-unrecorded",
    },
    ...heldAmplify.map(
      (id): ExplainLine => ({
        key: `amplify-status-${id}`,
        name: { kind: "key", value: "ui.debug.dmg-held-amplify" },
        value: { kind: "text", value: `#${id} x${conditions.stacks?.[String(id)] ?? 1}` },
        source: { kind: "literal", value: "IStatusAmplifyBuff walk (vfn+0xA8)" },
        depth: 1,
      })
    ),
    ...traitLines("postcap", hit, loadout, conditions, table, snapshot),
  ];
  if (capped) {
    lines.push({
      key: "overflow",
      name: { kind: "key", value: "ui.debug.dmg-line-overflow" },
      value: absent,
      source: { kind: "literal", value: "vfn+0xB0: cap x k@+0x249C x (atkChain - 1), at-cap only" },
      excluded: "value-unrecorded",
    });
  }
  return {
    key: "dmg-postcap",
    titleKey: "ui.debug.dmg-sec-postcap",
    formula: "final = elemMult x amplify x clamped (+ overflow at cap) x syncClamp",
    substituted:
      ratio === null ? null : `${hit.damage.toLocaleString()} = x${ratio.toFixed(3)} x ${clamped!.toLocaleString()}`,
    unavailableKey: null,
    noteKey: "ui.debug.dmg-note-postcap",
    lines,
  };
};

export const explainDamageHit = (
  input: DamageExplainInput,
  table: DamageTraitTable = DEFAULT_TABLE
): ExplainSection[] => {
  const conditions = input.conditions ?? {};
  const amplifyIds = input.amplifyStatusIds ?? new Set<number>();
  // Parsed ONCE per hit — every gate-byte trait row and the crit-roll line
  // read the same parse rather than each re-decoding the blob.
  const snapshot = parseInstSnapshot(input.hit.instance_snapshot);
  return [
    hitSection(input.hit),
    chainSection(input.hit, input.loadout, conditions, table, snapshot),
    critSection(input.hit, input.loadout, conditions, table, snapshot),
    classSection(input.hit),
    takenSection(input.hit),
    postcapSection(input.hit, input.loadout, conditions, amplifyIds, table, snapshot),
  ];
};
