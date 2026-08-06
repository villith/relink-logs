import type { MetricRow } from "../metrics/types";

import { statusKeyParts } from "./statusLabel";

/** Provenance of one status effect — what KIND of thing applied it.
 *
 * The classes are exactly what the existing cause classification can
 * distinguish (`causeLabel`'s unattributed sentinels, the `causes.default`
 * id bands, and the per-character skill tables). WCL's ten aura sections need
 * game data this pipeline does not have, so no further classes are invented:
 *
 * * `skill` — the cause resolved to a NAME through the four-rung chain in
 *   `causeNameFor`: a caster's own skill table (cause ids are the applying
 *   character's action ids), one of the named action bands in `causes.default`
 *   (800 Chain Burst, 80000 Summon Attack/Primal Burst, 99993 Darkflame End,
 *   99996/99997 Perfect Guard), the action the caster was performing at the
 *   apply, or the applying status object's own RTTI class. The last two are
 *   what let a passive land here rather than in Unknown — it has no action id
 *   of its own, which is precisely what a sentinel cause means.
 * * `sigilTrait` — the passive-gear bands: 9999 (Sigil/Trait Effect) and
 *   10000–10002 (Equipment Effect).
 * * `field` — 1048575 (0xFFFFF), the environment cause. Distinct from
 *   0xFFFFFFFF, which is the game's own "no value".
 * * `unknown` — no cause at all (null / 0 / 0xffffffff — `causeLabel`'s own
 *   unattributed test), or a numeric cause no table names: fabricating
 *   provenance from a bare number is the forbidden move, same as fabricating
 *   its name.
 */
export type CauseClass = "skill" | "sigilTrait" | "field" | "unknown";

/** Section order on the effects table: Skill → Sigil/Trait → Field → Unknown. */
export const CAUSE_CLASS_ORDER: CauseClass[] = ["skill", "sigilTrait", "field", "unknown"];

export const CAUSE_CLASS_LABEL_KEY: Record<CauseClass, string> = {
  skill: "ui.logs.cause-class-skill",
  sigilTrait: "ui.logs.cause-class-sigil-trait",
  field: "ui.logs.cause-class-field",
  unknown: "ui.logs.cause-class-unknown",
};

const FIELD_CAUSE = 1048575;
const SIGIL_TRAIT_CAUSES = new Set([9999, 10000, 10001, 10002]);

/** `hasName` is whether the cause resolution produced a display name — the
 * same `causeNameFor` pipeline the row labels use, injected as a RESULT so
 * this stays a pure classification with no reach into i18n. */
export const causeClassOf = (causeId: number | null, hasName: boolean): CauseClass => {
  if (causeId === null || causeId === 0 || causeId === 0xffffffff) return "unknown";
  if (causeId === FIELD_CAUSE) return "field";
  if (SIGIL_TRAIT_CAUSES.has(causeId)) return "sigilTrait";
  return hasName ? "skill" : "unknown";
};

/** One effect ROW's class, off its `status:<effect>:<cause>:<class>` key. A key that
 * is not a status key files as unknown — the same tolerance the labels show a
 * stale pin. */
export const causeClassOfKey = (key: string, hasName: (causeId: number) => boolean): CauseClass => {
  const parts = statusKeyParts(key);
  if (parts === null) return "unknown";
  return causeClassOf(parts.causeId, parts.causeId !== null && hasName(parts.causeId));
};

/** The effects table's provenance decoration: each row gains a SOURCE cell
 * (prepended to its columns), and the rows are stable-sorted into class
 * sections — each section keeps the uptime order the rows arrived in. Visual
 * grouping only: no state, nothing collapses, every row keeps its identity. */
export const withProvenance = (
  rows: MetricRow[],
  classOfRow: (row: MetricRow) => CauseClass,
  labelOf: (cls: CauseClass) => string
): MetricRow[] =>
  rows
    .map((row) => ({ row, cls: classOfRow(row) }))
    .sort((a, b) => CAUSE_CLASS_ORDER.indexOf(a.cls) - CAUSE_CLASS_ORDER.indexOf(b.cls))
    .map(({ row, cls }) => ({ ...row, columns: [labelOf(cls), ...row.columns] }));
