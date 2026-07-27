/** Shared trait-picker ordering for the Toolbox tools (synthesis picker
 * look): popular picks first, everything else alphabetized behind a bare
 * divider group. */

/** The traits people search for most, leading every picker in this order:
 * Stun Power, HP, Supplementary DMG, DMG Cap, Nimble Onslaught, Uplift. */
export const POPULAR_TRAITS = ["ceb700ee", "f372f096", "57ab5b10", "dc584f60", "d2c8e10a", "b5ff9fd3"];

export type TraitOption = { value: string; label: string };
export type TraitOptions = (TraitOption | { group: string; items: TraitOption[] })[];

/** Candidate trait hexes -> select options: the popular picks present among
 * the candidates first (fixed order), then everything else alphabetically by
 * label inside a whitespace-labelled group — Mantine renders that label as a
 * bare divider line, which is all we want between the two blocks. */
export const orderedTraitOptions = (hexes: string[], label: (hex: string) => string): TraitOptions => {
  const option = (hex: string) => ({ value: hex, label: label(hex) });
  const popular = POPULAR_TRAITS.filter((hex) => hexes.includes(hex)).map(option);
  const rest = hexes
    .filter((hex) => !POPULAR_TRAITS.includes(hex))
    .map(option)
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...popular, { group: " ", items: rest }];
};
