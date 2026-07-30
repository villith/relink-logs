import { describe, expect, it, vi } from "vitest";

/**
 * i18next is mocked rather than initialized so these assertions describe the
 * LABEL's shape, not the state of a translation bundle. Kept in its own file:
 * utils.test.ts runs against real lang JSON, and a file-wide i18next mock there
 * would change what unrelated tests are testing.
 */
vi.mock("i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("i18next")>();
  return {
    ...actual,
    default: actual.default,
    t: (key: string | string[]) => {
      const first = Array.isArray(key) ? key[0] : key;
      if (first === "ui:characters.ai") return "AI";
      // "characters:Cagliostro" / "ui:characters.Cagliostro" -> "Cagliostro"
      return first.split(/[:.]/).pop() as string;
    },
  };
});

const { translatedPlayerName } = await import("./utils");

type PlayerLike = Parameters<typeof translatedPlayerName>[2];
type SlotLike = Parameters<typeof translatedPlayerName>[1];

const player = { characterType: "Cagliostro" } as unknown as PlayerLike;
const slot = { displayName: "Scott" } as unknown as SlotLike;

/**
 * Characterization tests: these describe how the player label reads TODAY,
 * before it is rendered from a user-editable template. They are the gate on
 * that refactor — if any of them needs editing afterwards, the default
 * template is wrong, not the test.
 */
describe("translatedPlayerName", () => {
  it("renders name and character for a resolved slot", () => {
    expect(translatedPlayerName(0, slot, player, true)).toBe("[1] Scott (Cagliostro)");
  });

  it("hides the name and its parentheses when display names are off", () => {
    expect(translatedPlayerName(0, slot, player, false)).toBe("[1] Cagliostro");
  });

  it("marks an AI companion regardless of the display-names toggle", () => {
    const ai = { displayName: "" } as unknown as SlotLike;
    expect(translatedPlayerName(1, ai, player, true)).toBe("[2] AI (Cagliostro)");
    expect(translatedPlayerName(1, ai, player, false)).toBe("[2] AI (Cagliostro)");
  });

  it("labels an unresolved slot as a guest", () => {
    expect(translatedPlayerName(-1, null, player, true)).toBe("[Guest] Cagliostro");
  });

  it("returns a bare Guest when there is no player at all", () => {
    expect(translatedPlayerName(0, slot, undefined, true)).toBe("Guest");
  });
});
