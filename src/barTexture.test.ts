import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { BAR_TEXTURES } from "./stores/useMeterSettingsStore";

// Resolved off the vitest root (the repo root) rather than `import.meta.url`,
// which vitest hands back as a malformed `file:\C:\…` on Windows.
const APP_CSS = readFileSync(resolve("src/App.css"), "utf8");

/** The `--bar-texture` value each `.bar-texture-*` rule declares, keyed by texture id.
 *
 * Read out of the stylesheet rather than restated here: the point of these tests
 * is to catch a value that ships, so the shipped file has to be the input. */
const barTextures = (): Record<string, string> => {
  const rule = /\.bar-texture-([a-z-]+)\s*\{\s*--bar-texture:\s*([\s\S]*?);\s*\}/g;
  return Object.fromEntries(
    Array.from(APP_CSS.matchAll(rule), ([, id, value]) => [id, value.replace(/\s+/g, " ").trim()])
  );
};

describe("bar textures", () => {
  // Guards the regex above. If it stopped matching, the `none` test below would
  // pass over an empty set and quietly stop protecting anything.
  it("declares one texture per selectable option", () => {
    expect(Object.keys(barTextures()).sort()).toEqual([...BAR_TEXTURES].sort());
  });

  /** The damage bar is the row's own background, and the texture is the FIRST
   * of its background-image layers (`.player-row` / `.skill-row` in App.css).
   *
   * html2canvas — what "Copy Screenshot" runs — discards the WHOLE layer list
   * when layer 0 is the `none` keyword, not just that one layer:
   *
   *     if (first.type === IDENT_TOKEN && first.value === 'none') return [];
   *
   * So a texture of `none` costs the screenshot its bars entirely: rows render
   * with their text and nothing behind it. A fully transparent gradient is the
   * same thing on screen and survives the parser, so that is what "no texture"
   * has to be spelled as. */
  it("never spells a texture as the `none` keyword, which erases the bars from Copy Screenshot", () => {
    for (const [id, value] of Object.entries(barTextures())) {
      expect(value, `.bar-texture-${id}`).not.toBe("none");
    }
  });
});
