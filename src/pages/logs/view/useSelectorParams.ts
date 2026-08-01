import { useQueryState } from "nuqs";
import { useCallback, useMemo } from "react";

import { parseAbilityKey } from "./abilityKey";
import type { SelectorPins } from "./selectorOptions";

export type RawPins = { src: string | null; tgt: string | null; abil: string | null };

export const encodePins = (pins: SelectorPins): RawPins => ({
  src: pins.source === null ? null : String(pins.source),
  tgt: pins.targetIds.length === 0 ? null : pins.targetIds.join(","),
  abil: pins.ability,
});

/** Every field degrades to "All" on its own — one bad value must not discard
 * the others. */
export const decodePins = (raw: RawPins): SelectorPins => {
  const source = Number(raw.src);
  // The empty-segment filter is load-bearing: "".split(",") is [""], and
  // Number("") is 0, so without it an absent tgt decodes to a pin on target 0.
  const targetIds = (raw.tgt ?? "")
    .split(",")
    .filter((part) => part !== "")
    .map(Number)
    .filter((id) => Number.isInteger(id));

  return {
    source: raw.src !== null && Number.isInteger(source) ? source : null,
    targetIds,
    ability: raw.abil !== null && parseAbilityKey(raw.abil) !== null ? raw.abil : null,
  };
};

/** Selector pins held in the URL, so a drilled-in view survives reload and
 * navigation. Mirrors `useTabParam`'s replace-history behaviour. */
export const useSelectorParams = () => {
  const [src, setSrc] = useQueryState("src", { history: "replace" });
  const [tgt, setTgt] = useQueryState("tgt", { history: "replace" });
  const [abil, setAbil] = useQueryState("abil", { history: "replace" });

  const pins = useMemo(() => decodePins({ src, tgt, abil }), [src, tgt, abil]);

  const setPins = useCallback(
    (next: SelectorPins) => {
      const encoded = encodePins(next);
      setSrc(encoded.src);
      setTgt(encoded.tgt);
      setAbil(encoded.abil);
    },
    [setSrc, setTgt, setAbil]
  );

  return [pins, setPins] as const;
};
