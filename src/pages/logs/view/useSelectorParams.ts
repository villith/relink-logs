import { useQueryState } from "nuqs";
import { useCallback, useMemo } from "react";

import { parseAbilityKey } from "./abilityKey";
import type { SelectorPins } from "./selectorOptions";
import { isStatusPin } from "./statusUptime";

export type RawPins = { src: string | null; tgt: string | null; abil: string | null };

export const encodePins = (pins: SelectorPins): RawPins => ({
  src: pins.source === null ? null : String(pins.source),
  tgt: pins.targets.length === 0 ? null : pins.targets.join(","),
  abil: pins.ability,
});

/** Every field degrades to "All" on its own — one bad value must not discard
 * the others. */
export const decodePins = (raw: RawPins): SelectorPins => {
  const source = Number(raw.src);
  // The empty-segment filter is load-bearing: "".split(",") is [""], and
  // Number("") is 0, so without it an absent tgt decodes to a pin on target 0.
  const targets = (raw.tgt ?? "")
    .split(",")
    .filter((part) => part !== "")
    .map(Number)
    // Segment indices, so a negative one names nothing. A URL written before
    // the pin was a segment carries an actor id here, which is far past the end
    // of `targetEntries` and drops out when the spans are resolved.
    .filter((segment) => Number.isInteger(segment) && segment >= 0);

  return {
    source: raw.src !== null && Number.isInteger(source) ? source : null,
    targets,
    // Two grammars share this pin: an `abilityKey` and a status effect's
    // `status:<effect>:<cause>`. Validating only the first silently dropped
    // every buff pin on the way back out of the URL — the pin is written, read
    // back as null, and the Buffs table never descends to its holders.
    ability: raw.abil !== null && (isStatusPin(raw.abil) || parseAbilityKey(raw.abil) !== null) ? raw.abil : null,
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

