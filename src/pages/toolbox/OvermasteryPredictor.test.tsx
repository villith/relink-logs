import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("./useOvermasteryPredictor", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: vi.fn(),
}));

import OvermasteryPredictor from "./OvermasteryPredictor";
import useOvermasteryPredictor, { emptySlots } from "./useOvermasteryPredictor";

const hookState = (overrides: Partial<ReturnType<typeof useOvermasteryPredictor>> = {}) =>
  ({
    form: { character: "2a26b1b2", tier: "2", wanted: emptySlots(), rolls: 50 },
    setForm: vi.fn(),
    selectCharacter: vi.fn(),
    status: null,
    prediction: null,
    error: null,
    predicting: false,
    stale: false,
    loading: false,
    characterOptions: [],
    categoryOptions: [],
    filters: [],
    predict: vi.fn(),
    ...overrides,
  }) as ReturnType<typeof useOvermasteryPredictor>;

const renderWith = (overrides: Partial<ReturnType<typeof useOvermasteryPredictor>>) => {
  vi.mocked(useOvermasteryPredictor).mockReturnValue(hookState(overrides));
  render(
    <MantineProvider>
      <OvermasteryPredictor />
    </MantineProvider>
  );
};

/** Every form control in the tool, as DOM elements. The wanted-slot label is
 * its raw i18n key here because the mocked `t` has no string fallback for it. */
const controls = (): (HTMLInputElement | HTMLButtonElement)[] => [
  screen.getByLabelText("Character", { selector: "input" }) as HTMLInputElement,
  screen.getByLabelText("Overmastery Level", { selector: "input" }) as HTMLInputElement,
  ...(screen.getAllByLabelText("ui.toolbox.om-wanted-slot", { selector: "input" }) as HTMLInputElement[]),
  ...(screen.getAllByLabelText("Min level", { selector: "input" }) as HTMLInputElement[]),
  screen.getByLabelText("Rolls to simulate", { selector: "input" }) as HTMLInputElement,
  screen.getByRole("button", { name: "Predict" }) as HTMLButtonElement,
];

describe("OvermasteryPredictor form availability", () => {
  it("disables every input while the game status is loading", () => {
    renderWith({ loading: true });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be disabled`).toBe(true);
  });

  it("disables every input while a prediction is reading the game", () => {
    renderWith({ predicting: true });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be disabled`).toBe(true);
  });

  it("enables the inputs once the status has arrived and nothing is in flight", () => {
    renderWith({ status: { gameRunning: true, roster: [] } });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be enabled`).toBe(false);
  });

  it("keeps the inputs usable when the game was not running at mount", () => {
    // The status is read once on mount and never refreshed, so disabling on
    // it would strand anyone who opens the tool before launching the game.
    // Predict re-reads live state and reports game-not-running itself.
    renderWith({ status: { gameRunning: false, roster: [] } });
    for (const el of controls()) expect(el.disabled, `${el.tagName} should be enabled`).toBe(false);
  });
});
