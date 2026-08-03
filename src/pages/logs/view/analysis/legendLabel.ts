import type { SelectorOption } from "../selectorOptions";

/** A label for one player where nothing else separates two of them.
 *
 * The table can rely on rank and position to tell two same-named players apart;
 * the chart legend and the source pin have neither, so two entries both reading
 * "AI" are separable by colour alone — and the pin does not even have that. The
 * closest palette pair collapses from CIE76 dE 43.5 to 6.7 under simulated
 * deuteranopia, so colour cannot be the only channel.
 *
 * The character name is the disambiguator because it is what actually differs
 * (Siegfried vs Eugen) and it is what Classic's default template already shows.
 * A template that names the character is left alone rather than repeating it. */
export const legendLabelFor = (label: string, character: string, template: string): string => {
  if (!character) return label;
  if (!label) return character;
  // Already stated — either through the {character} token or literally.
  if (template.includes("{character}") || label.includes(character)) return label;
  return `${label} (${character})`;
};

/** Source-pin options, labelled by the same rule as the legend.
 *
 * Applied to every source rather than only to colliding ones: a list where one
 * entry alone gained a character would read as if that player were the odd one
 * out. `value` is an actor index; a value that is not one keeps its plain label,
 * since `Number("nonsense")` is NaN and would look up an arbitrary character. */
export const labelSourceOptions = (
  options: SelectorOption[],
  labelFor: (index: number) => string,
  characterFor: (index: number) => string,
  template: string
): (SelectorOption & { label: string })[] =>
  options.map((option) => {
    const index = Number(option.value);
    const label = labelFor(index);
    return { ...option, label: Number.isInteger(index) ? legendLabelFor(label, characterFor(index), template) : label };
  });
