import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

import { SynthesisSearchResponse, SynthesisStatus } from "@/types";

import SynthesisHelper from "./SynthesisHelper";
import useSynthesisHelper from "./useSynthesisHelper";

const hookState = (overrides: Partial<ReturnType<typeof useSynthesisHelper>> = {}) =>
  ({
    form: { trait1: "ceb700ee", trait2: null, anyOrder: false, requireLucky: true },
    setForm: vi.fn(),
    status: null,
    response: null,
    error: null,
    searching: false,
    stale: false,
    seedLatched: null,
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

/** A live status, latched unless told otherwise. */
const status = (overrides: Partial<SynthesisStatus> = {}): SynthesisStatus => ({
  gameRunning: true,
  sigilCount: 3,
  rngUnpredictable: false,
  seedLatched: true,
  ...overrides,
});

/** A search response, latched unless told otherwise. */
const response = (overrides: Partial<SynthesisSearchResponse> = {}): SynthesisSearchResponse => ({
  matches: [],
  pairsTested: 0,
  sigilCount: 3,
  rngUnpredictable: false,
  rngState: 1,
  savedSeed: 1,
  synthCount: 0,
  seedLatched: true,
  ...overrides,
});

const latchNotice = () => screen.queryByText(/Sigil Synthesis screen/);

const searchButton = () => screen.getByRole("button", { name: "Search" }) as HTMLButtonElement;

/**
 * The game latches its prediction seed when the synthesis screen opens, so a
 * list computed before that is guaranteed to miss on the first synthesis —
 * the tool has to say so rather than hand over results that look fine.
 */
describe("SynthesisHelper seed latch notice", () => {
  it("tells the player to open the synthesis screen when the seed is not latched", () => {
    renderWith({ status: status(), seedLatched: false });
    expect(latchNotice()).toBeTruthy();
  });

  it("says nothing once the game has latched its seed", () => {
    renderWith({ status: status(), seedLatched: true });
    expect(latchNotice()).toBeNull();
  });

  it("keeps flagging a list that was computed while unlatched", () => {
    // The game can latch a moment later; what matters is the state the shown
    // results were actually computed from.
    renderWith({ status: status(), seedLatched: true, response: response({ seedLatched: false }) });
    expect(latchNotice()).toBeTruthy();
  });

  it("says nothing while there is no game to read the latch from", () => {
    // seedLatched is null without a game; the game-not-running banner is the
    // actionable one.
    renderWith({ status: status({ gameRunning: false }), seedLatched: null });
    expect(latchNotice()).toBeNull();
  });

  it("blocks the search itself — any list found now would only need finding again", () => {
    renderWith({ status: status(), seedLatched: false });
    expect(searchButton().disabled).toBe(true);
  });

  it("does not block the search when there is no game to read the latch from", () => {
    renderWith({ status: status({ gameRunning: false }), seedLatched: null });
    expect(searchButton().disabled).toBe(false);
  });

  it("does not block a fresh search just because the shown list is unlatched", () => {
    // The game has latched since; searching again is exactly the fix.
    renderWith({ status: status(), seedLatched: true, response: response({ seedLatched: false }) });
    expect(searchButton().disabled).toBe(false);
  });
});

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
    renderWith({ status: status() });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be enabled`).toBe(false);
  });

  it("keeps the inputs usable when the game was not running at mount", () => {
    // The status is read once on mount and never refreshed, so disabling on
    // it would strand anyone who opens the tool before launching the game.
    // Search re-reads live state and reports game-not-running itself.
    renderWith({ status: status({ gameRunning: false, sigilCount: 0 }) });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be enabled`).toBe(false);
  });
});
