import type { MetricRow } from "../metrics/types";

/** One label candidate: what the row (or card entry) would say, and what could
 * tell two identical sayings apart — the owner's character name. */
export type QualifiableLabel = { label: string; qualifier: string };

/** Final labels for a set of candidates, qualified ONLY on collision.
 *
 * The same rule the chart legend applies to duplicate player names
 * (`legendLabelFor`): the character name is the disambiguator because it is
 * what actually differs, it is appended only where two entries would otherwise
 * read identically, and a label that already states it is left alone. An empty
 * qualifier leaves the label bare — an honest tie beats a fabricated suffix.
 *
 * Shared by the analysis table's parent ability rows and the hover card's
 * ability entries (Package A), so a row and the card explaining it can never
 * disagree about when a name needs an owner. */
export const qualifyDuplicateLabels = (items: QualifiableLabel[]): string[] => {
  const counts = new Map<string, number>();
  for (const { label } of items) counts.set(label, (counts.get(label) ?? 0) + 1);
  return items.map(({ label, qualifier }) =>
    (counts.get(label) ?? 0) > 1 && qualifier !== "" && !label.includes(qualifier) ? `${label} (${qualifier})` : label
  );
};

/** Display labels for a row set's top-level ABILITY rows, duplicate labels
 * qualified with their owner's character — keyed by row key so the renderer
 * can consult it without re-deriving.
 *
 * Only rows declaring `kind: "ability"` (the groups path always declares) and
 * naming a real key (`labelKey` rows name themselves) participate: collisions
 * are between VISIBLE parent rows, and a player or attack row can never
 * collide with an ability's translated name in a way this rule should paper
 * over. Child rows are not in `rows` and are deliberately untouched — an
 * expanded parent's children are already scoped by their parent. */
export const qualifiedAbilityLabels = (
  rows: MetricRow[],
  labelFor: (key: string) => string,
  qualifierFor: (key: string) => string
): Map<string, string> => {
  const abilityRows = rows.filter((row) => row.kind === "ability" && !row.labelKey);
  const labels = qualifyDuplicateLabels(
    abilityRows.map((row) => ({ label: labelFor(row.label), qualifier: qualifierFor(row.label) }))
  );
  return new Map(abilityRows.map((row, position) => [row.key, labels[position]]));
};
