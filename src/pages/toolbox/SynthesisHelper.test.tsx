import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("./useSynthesisHelper", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: vi.fn(),
}));

import SynthesisHelper from "./SynthesisHelper";
import useSynthesisHelper from "./useSynthesisHelper";

// Explicit even though vitest's `globals: true` config restores
// testing-library's auto-cleanup — keeps this file safe on its own.
afterEach(cleanup);

// jsdom is missing these browser APIs; Mantine's components probe them.
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);

  window.ResizeObserver =
    window.ResizeObserver ||
    class implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

const hookState = (overrides: Partial<ReturnType<typeof useSynthesisHelper>> = {}) =>
  ({
    form: { trait1: "ceb700ee", trait2: null, anyOrder: false, requireLucky: true },
    setForm: vi.fn(),
    status: null,
    response: null,
    error: null,
    searching: false,
    stale: false,
    loading: false,
    traitOptions: [],
    search: vi.fn(),
    ...overrides,
  }) as ReturnType<typeof useSynthesisHelper>;

const renderWith = (overrides: Partial<ReturnType<typeof useSynthesisHelper>>) => {
  vi.mocked(useSynthesisHelper).mockReturnValue(hookState(overrides));
  render(
    <MantineProvider>
      <SynthesisHelper />
    </MantineProvider>
  );
};

/** Every form control in the tool, as DOM elements. */
const controls = (): (HTMLInputElement | HTMLButtonElement)[] => [
  screen.getByLabelText("Trait 1 (first slot)", { selector: "input" }) as HTMLInputElement,
  screen.getByLabelText("Trait 2 (second slot)", { selector: "input" }) as HTMLInputElement,
  screen.getByLabelText("Lvl 15 only", { selector: "input" }) as HTMLInputElement,
  screen.getByLabelText("Match either slot order", { selector: "input" }) as HTMLInputElement,
  screen.getByRole("button", { name: "Search" }) as HTMLButtonElement,
];

describe("SynthesisHelper form availability", () => {
  it("disables every input while the game status is loading", () => {
    renderWith({ loading: true });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be disabled`).toBe(true);
  });

  it("disables every input while a search is reading the game", () => {
    renderWith({ searching: true });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be disabled`).toBe(true);
  });

  it("enables the inputs once the status has arrived and nothing is in flight", () => {
    renderWith({ status: { gameRunning: true, sigilCount: 3, rngUnpredictable: false } });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be enabled`).toBe(false);
  });
});
