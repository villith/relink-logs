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

describe("OvermasteryPredictor rolled magnitudes", () => {
  it("shows each effect at the magnitude the game displays", () => {
    renderWith({
      prediction: {
        // kind 3 (Stun Power Up) is stored at a tenth of what the game shows:
        // its Lv7 row is 1.0 and the game reads "Stun Power Up +10".
        rolls: [
          [
            { category: 0x6cb38ef3, level: 7, kind: 3, value: 1 },
            { category: 0xc4925bd7, level: 10, kind: 0, value: 1000 },
            { category: 0x45c65767, level: 10, kind: 2, value: 20 },
            { category: 0x9c555433, level: 9, kind: 104, value: 16 },
          ],
        ],
        slot: 0,
        slotState: 0,
        unpredictable: false,
        mspCost: 220000,
      },
    });

    expect(screen.getByText("+10")).toBeTruthy();
    expect(screen.getByText("+1000")).toBeTruthy();
    expect(screen.getByText("+20%")).toBeTruthy();
    expect(screen.getByText("+16%")).toBeTruthy();
    expect(screen.queryByText("+1%")).toBeNull();
  });
});

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
