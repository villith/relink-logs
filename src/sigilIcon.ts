/**
 * Resolves a sigil's gem medallion icon by its visual recipe.
 *
 * The atlas draws sigils as five shape series × five tiers, with optional
 * `plus` (+ overlay), `ex01` (recolour) and `chr` (character-sigil) variants
 * — that is the whole vocabulary, and the file names spell it as
 * `NN_MM[_chr][_ex01][_plus]`. The recipe is the honest API: `gem.tbl`
 * carries no icon column (the shape choice comes from `skill.tbl`, which the
 * table tooling cannot parse at game version 2.0.3), so there is deliberately
 * no `sigilId →` icon map to fabricate here. Callers pick shape and tier from
 * what they know about the sigil. See `src/assets/game-icons/README.md`.
 */
const ICONS = import.meta.glob<string>("./assets/game-icons/sigil/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const BY_NAME = new Map(
  Object.entries(ICONS).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".png".length), url])
);

export type SigilIconVariant = {
  /** `+`-sigil sparkle overlay baked into the art. */
  plus?: boolean;
  /** The `ex01` recolour (the supplementary/awakened palette). */
  ex?: boolean;
  /** The character-sigil framing; the atlas only draws it at shape 5 tier 4. */
  chr?: boolean;
};

/**
 * The icon URL for a sigil drawn as `shape` (1–5) at `tier` (0–4), or
 * `undefined` for a combination the atlas does not draw — variants exist only
 * at the tiers the game sells them at, so absence is data, not an error.
 */
export const sigilIconUrl = (shape: number, tier: number, variant: SigilIconVariant = {}): string | undefined => {
  const name =
    `${String(shape).padStart(2, "0")}_${String(tier).padStart(2, "0")}` +
    (variant.chr ? "_chr" : "") +
    (variant.ex ? "_ex01" : "") +
    (variant.plus ? "_plus" : "");
  return BY_NAME.get(name);
};
