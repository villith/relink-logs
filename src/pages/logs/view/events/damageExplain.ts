import damageTraitValues from "@/assets/damage-trait-values.json";
import { computeCombinedTraits } from "@/utils";

import type { ExplainHit, ExplainLine, ExplainSection, ExplainValue } from "./capExplain";
import type { CapConditions } from "./capFactors";
import type { CapLoadout } from "./capSources";

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
  | { kind: "gate-byte" } // exists in the game, not captured per hit
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
    gates: { weakpoint: { kind: "gate-byte" }, backattack: { kind: "gate-byte" } },
  },
  { id: 0x54401e12, section: "chain", gates: { value: { kind: "gate-byte" } } },
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
  { id: 0x4f1a3683, section: "chain", gates: { value: { kind: "gate-byte" } } },
  { id: 0xa9d17f55, section: "chain", gates: { value: { kind: "gate-byte" } } },
  { id: 0xac9674c1, section: "chain", gates: { value: { kind: "gate-byte" } } },
  { id: 0xa7726190, section: "chain", gates: { value: { kind: "hp-gate", cmp: "gte" } } },
  { id: 0x0de887a0, section: "chain", gates: { value: { kind: "hp-gate", cmp: "lte" } } },
  { id: 0xc0979a17, section: "crit", gates: { value: { kind: "conditional" } } },
  { id: 0xc35b111b, section: "crit", gates: { value: { kind: "class-flag", bit: 0x2 } } },
  { id: 0x4b400b01, section: "crit", gates: { value: { kind: "gate-byte" } } },
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
  conditions: CapConditions
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
    case "gate-byte":
      line.excluded = "gate-unrecorded";
      break;
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
      if (conditions.hpRatio === undefined || threshold === undefined) line.excluded = "gate-unrecorded";
      else {
        const pct = conditions.hpRatio * 100;
        const met = gate.cmp === "gte" ? pct >= threshold : pct <= threshold;
        if (!met) line.excluded = "conditional";
        line.source = { kind: "literal", value: `${entry.key} L${level}, hp ${gate.cmp} ${threshold}%` };
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
  table: DamageTraitTable
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
      lines.push(traitLine(spec, slot, gate, entry, level, hit, conditions));
    }
  }
  return lines;
};

const chainSection = (
  hit: ExplainHit,
  loadout: CapLoadout | undefined,
  conditions: CapConditions,
  table: DamageTraitTable
): ExplainSection => ({
  key: "dmg-chain",
  titleKey: "ui.debug.dmg-sec-chain",
  formula: "chain = atk x pct x slice vfns x class-gated traits x addgrp",
  substituted: null,
  unavailableKey: loadout === undefined ? "ui.debug.cap-no-loadout" : null,
  noteKey: "ui.debug.dmg-note-chain",
  lines: [
    ...traitLines("chain", hit, loadout, conditions, table),
    {
      key: "status-atk",
      name: { kind: "key", value: "ui.debug.dmg-line-status-atk" },
      value: conditions.buffs === undefined ? absent : { kind: "text", value: `${conditions.buffs.length} held` },
      source: { kind: "literal", value: "FUN_140bd3d90 walk" },
      excluded: "value-unrecorded",
    },
  ],
});

export const explainDamageHit = (
  input: DamageExplainInput,
  table: DamageTraitTable = DEFAULT_TABLE
): ExplainSection[] => {
  const conditions = input.conditions ?? {};
  return [
    hitSection(input.hit),
    chainSection(input.hit, input.loadout, conditions, table),
    // Later tasks append: crit, class, taken, postcap.
  ];
};
