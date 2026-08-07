import { MantineProvider } from "@mantine/core";
import { render, screen, within } from "@testing-library/react";
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
vi.mock("@/hooks/useTabParam", () => ({ useTabParam: vi.fn() }));

import { useTabParam } from "@/hooks/useTabParam";
import { OvermasteryCharacterPrediction, OvermasteryMastery } from "@/types";

import OvermasteryPredictor from "./OvermasteryPredictor";
import useOvermasteryPredictor, { emptySlots } from "./useOvermasteryPredictor";

const KATALINA = "18e2f9f9";
const RACKAM = "079df0cc";

const hookState = (overrides: Partial<ReturnType<typeof useOvermasteryPredictor>> = {}) =>
  ({
    form: { characters: ["2a26b1b2"], tier: "2", wanted: emptySlots(), rolls: 50 },
    setForm: vi.fn(),
    selectCharacters: vi.fn(),
    characters: ["2a26b1b2"],
    status: null,
    results: [],
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

/** The tab the component asks for, defaulting to the first available one —
 * the real `useTabParam` narrows the URL value against exactly that list. */
const renderWith = (overrides: Partial<ReturnType<typeof useOvermasteryPredictor>>, openTab?: string) => {
  vi.mocked(useTabParam).mockImplementation(
    (available, fallback) => [openTab && available.includes(openTab) ? openTab : fallback, vi.fn()] as never
  );
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
  screen.getByLabelText("Characters", { selector: "input" }) as HTMLInputElement,
  screen.getByLabelText("Overmastery Level", { selector: "input" }) as HTMLInputElement,
  ...(screen.getAllByLabelText("ui.toolbox.om-wanted-slot", { selector: "input" }) as HTMLInputElement[]),
  ...(screen.getAllByLabelText("Min level", { selector: "input" }) as HTMLInputElement[]),
  screen.getByLabelText("Rolls to simulate", { selector: "input" }) as HTMLInputElement,
  screen.getByRole("button", { name: "Predict" }) as HTMLButtonElement,
];

const mastery = (kind: number, level: number): OvermasteryMastery => ({
  category: 0x1000 + kind,
  level,
  kind,
  value: level * 10,
});

/** One character's entry in a batch result, with the rolls it predicted. */
const entry = (charHex: string, rolls: OvermasteryMastery[][]): OvermasteryCharacterPrediction => ({
  charId: parseInt(charHex, 16),
  prediction: { rolls, slot: 4, slotState: 100, unpredictable: false, mspCost: 220000 },
  error: null,
});

describe("OvermasteryPredictor rolled magnitudes", () => {
  it("shows each effect at the magnitude the game displays", () => {
    renderWith({
      results: [
        // kind 3 (Stun Power Up) is stored at a tenth of what the game shows:
        // its Lv7 row is 1.0 and the game reads "Stun Power Up +10".
        entry(KATALINA, [
          [
            { category: 0x6cb38ef3, level: 7, kind: 3, value: 1 },
            { category: 0xc4925bd7, level: 10, kind: 0, value: 1000 },
            { category: 0x45c65767, level: 10, kind: 2, value: 20 },
            { category: 0x9c555433, level: 9, kind: 104, value: 16 },
          ],
        ]),
      ],
      characterOptions: [{ value: KATALINA, label: "Katalina" }],
    });

    expect(screen.getByText("+10")).toBeTruthy();
    expect(screen.getByText("+1000")).toBeTruthy();
    expect(screen.getByText("+20%")).toBeTruthy();
    expect(screen.getByText("+16%")).toBeTruthy();
    expect(screen.queryByText("+1%")).toBeNull();
  });
});

describe("OvermasteryPredictor character tabs", () => {
  const characterOptions = [
    { value: KATALINA, label: "Katalina" },
    { value: RACKAM, label: "Rackam" },
  ];
  // Katalina rolls ATK 9; Rackam only ever gets it to 3.
  const results = [entry(KATALINA, [[mastery(0, 9), mastery(1, 2)]]), entry(RACKAM, [[mastery(0, 3), mastery(1, 2)]])];
  const filters = [{ kind: 0, minLevel: 8 }];

  it("opens one tab per predicted character, named for them", () => {
    renderWith({ results, characterOptions, characters: [KATALINA, RACKAM], filters });

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Katalina"), expect.stringContaining("Rackam")])
    );
  });

  it("marks the tab of a character whose rolls match, and the one whose rolls don't", () => {
    renderWith({ results, characterOptions, characters: [KATALINA, RACKAM], filters });

    const katalina = screen.getByRole("tab", { name: /Katalina/ });
    const rackam = screen.getByRole("tab", { name: /Rackam/ });
    expect(within(katalina).getByLabelText("ui.toolbox.om-tab-matches")).toBeTruthy();
    expect(within(rackam).getByLabelText("ui.toolbox.om-tab-no-match")).toBeTruthy();
  });

  it("shows only the open tab's rolls", () => {
    // Rackam's ATK 3 is a trait-only match, so it shows under the
    // below-minimum-level table — but only while his tab is the open one.
    renderWith({ results, characterOptions, characters: [KATALINA, RACKAM], filters }, KATALINA);
    expect(screen.queryByText("Matches below minimum level")).toBeNull();

    renderWith({ results, characterOptions, characters: [KATALINA, RACKAM], filters }, RACKAM);
    expect(screen.getByText("Matches below minimum level")).toBeTruthy();
  });

  it("reports a character the roster no longer holds inside their own tab", () => {
    // One character failing must not cost the rest of the batch its results,
    // so their reason belongs in their tab, not in the whole-tool banner.
    renderWith({
      results: [
        entry(RACKAM, [[mastery(0, 9)]]),
        { charId: parseInt(KATALINA, 16), prediction: null, error: "character-not-found" },
      ],
      characterOptions,
      characters: [RACKAM, KATALINA],
      filters,
    });
    expect(screen.getByRole("tab", { name: /Rackam/ })).toBeTruthy();
    expect(screen.queryByText("ui.toolbox.om-character-not-found")).toBeNull();

    renderWith(
      {
        results: [
          entry(RACKAM, [[mastery(0, 9)]]),
          { charId: parseInt(KATALINA, 16), prediction: null, error: "character-not-found" },
        ],
        characterOptions,
        characters: [RACKAM, KATALINA],
        filters,
      },
      KATALINA
    );
    expect(screen.getAllByText("ui.toolbox.om-character-not-found").length).toBeGreaterThan(0);
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

  it("cannot predict with nothing picked", () => {
    renderWith({
      status: { gameRunning: true, roster: [] },
      form: { ...hookState().form, characters: [] },
      characters: [],
    });
    expect((screen.getByRole("button", { name: "Predict" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
