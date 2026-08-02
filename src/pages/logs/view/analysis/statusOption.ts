import { isStatusPin } from "../statusUptime";

export type LabelledOption = { value: string; label: string };

/** The ability options, plus the pinned status effect when it is not already
 * one of them.
 *
 * `deriveSelectorOptions` builds the ability list from DAMAGE facts, and no
 * damage fact's key can ever equal a `status:` key — so a pinned buff matched
 * nothing and Mantine's Select, which renders the option's label rather than
 * the raw value, drew its placeholder over a live pin. The user could not see
 * what the table was narrowed by, and the only way to clear it was the ✕.
 *
 * Prepended rather than appended: it is the one option that is definitely
 * selected, so it belongs where the list is read from first.
 *
 * `label` is injected for the same reason `abilityLabelFor` injects `skillName`
 * — naming an effect needs i18n and the generated status bundle, and this stays
 * a pure function. */
export const withStatusOption = (
  options: LabelledOption[],
  pin: string | null,
  label: (key: string) => string
): LabelledOption[] => {
  if (!isStatusPin(pin)) return options;
  if (options.some((option) => option.value === pin)) return options;
  return [{ value: pin, label: label(pin) }, ...options];
};

