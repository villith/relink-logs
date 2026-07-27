import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import type { TransmarvelPrediction, TransmarvelStatus } from "@/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
// `translateTraitId`/`translateSigilId` (used for Select option labels) call
// the real i18next singleton directly, not the mocked useTranslation hook —
// uninitialized i18next returns `undefined` for those calls, which crashes
// Mantine's Select filter (it calls `.toLowerCase()` on every label). Loading
// "@/i18n" runs its module-level `init()` so `t()` echoes keys back instead.
vi.mock("@tauri-apps/api/fs", () => ({ readTextFile: vi.fn().mockResolvedValue("{}") }));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: vi.fn().mockResolvedValue("lang/en/ui.json") }));

// A minimal interpolation-aware `t`: string second args are the JSX fallback
// (matches the rest of the toolbox test suite's convention), object second
// args are `{{key}}` template substitutions for the handful of interpolated
// strings this page renders — needed so "first hit at roll #2" is actually
// assertable rather than just the raw key.
const TEMPLATES: Record<string, string> = {
  "ui.toolbox.tm-no-hits": "No wishlist hits in the next {{rolls}} rolls.",
  "ui.toolbox.tm-truncated": "Showing the first {{shown}} of {{total}} rolls.",
  "ui.toolbox.tm-entry-hit": "#{{n}}",
  "ui.level-short": "Lv{{level}}",
};
vi.mock("react-i18next", async (importOriginal) => ({
  // Keep the real `initReactI18next` plugin — "@/i18n"'s module-level `.use(initReactI18next)` needs it.
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => {
      if (typeof opts === "string") return opts;
      if (opts && typeof opts === "object") {
        let out = TEMPLATES[key] ?? key;
        for (const [k, v] of Object.entries(opts as Record<string, unknown>)) out = out.replace(`{{${k}}}`, String(v));
        return out;
      }
      return key;
    },
    i18n: { language: "en" },
  }),
}));

// Deterministic name translations, so label bugs are actually catchable:
// with only the echo-everything i18n above, translateSigilId(WRONG_ID) and
// translateSigilId(RIGHT_ID) both render "ui.unknown-id", and a swapped
// argument can never fail an assertion.
vi.mock("@/utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  translateSigilId: (id: number | null) => `sigil:${(id ?? 0).toString(16).padStart(8, "0")}`,
  translateTraitId: (id: number | null) => `trait:${(id ?? 0).toString(16).padStart(8, "0")}`,
  translateWrightstoneId: (id: number | null) => `stone:${(id ?? 0).toString(16).padStart(8, "0")}`,
}));

import { useTransmarvelWishlistStore } from "@/stores/useTransmarvelWishlistStore";

import { POPULAR_TRAITS } from "./traitOptions";
import TransmarvelSearcher, { MAX_ROLLS, MAX_SHOWN_ROWS } from "./TransmarvelSearcher";
import { familyCombos, POOL, sigilTrait2Options, slotTraitOptions } from "./useTransmarvelSearcher";

const renderPage = () =>
  render(
    <MantineProvider>
      <TransmarvelSearcher />
    </MantineProvider>
  );

/** Option values of the dropdown belonging to one Select input. Every
 * Mantine combobox on the page keeps its (hidden) dropdown mounted, so a
 * global [role="option"] query would see every picker's options at once —
 * scope through the input's aria-controls instead. */
const optionsOf = (input: HTMLInputElement): (string | null)[] => {
  const listbox = document.getElementById(input.getAttribute("aria-controls")!)!;
  return [...listbox.querySelectorAll('[role="option"]')].map((el) => el.getAttribute("value"));
};

// Real pool entries so `sanitizeWishlists` (which validates against the pool)
// keeps the seeded wishlist entry instead of silently dropping it.
const WISHLISTED = POOL.sigils[0];
const OTHER = POOL.sigils[1];
// A sigil whose fixed-pair extra widens its 2nd-trait options beyond the lot.
const EXTRA_SIGIL = POOL.sigils.find((s) => s.extraTrait2.length > 0)!;

// One stone family with its three tiers, found off the real pool rather than
// hardcoded so a regeneration can't silently invalidate the picks.
const FAMILY = POOL.wrightstones.combos.find((c) => c.tier === 0)!.family;
const TIERS = familyCombos(FAMILY, POOL);
// The top (0.1%) tier's fixed slot-2 trait.
const TOP_SLOT2 = TIERS[2].slots[1].traits[0];

const status: TransmarvelStatus = { gameRunning: true, rngUnpredictable: false };
// For tests exercising only the pickers/inputs: no auto-predict, no busy hold.
const statusOff: TransmarvelStatus = { gameRunning: false, rngUnpredictable: false };

const prediction: TransmarvelPrediction = {
  rolls: [
    {
      outcome: {
        type: "sigil",
        sigilId: parseInt(OTHER.sigilId, 16),
        traitLevel: 10,
        trait1: parseInt(OTHER.trait, 16),
        trait2: null,
      },
      draws: 5,
    },
    {
      outcome: {
        type: "sigil",
        sigilId: parseInt(WISHLISTED.sigilId, 16),
        traitLevel: 10,
        trait1: parseInt(WISHLISTED.trait, 16),
        trait2: null,
      },
      draws: 5,
    },
  ],
  slot: 4,
  slotState: 12345,
  unpredictable: false,
};

describe("TransmarvelSearcher", () => {
  beforeEach(() => {
    invoke.mockReset();
    useTransmarvelWishlistStore.setState({ sigils: [], stones: [] });
    // Mantine's useLocalStorage would otherwise leak the persisted roll
    // count between tests.
    window.localStorage.clear();
  });

  it("shows the title and the game-not-running alert when the game isn't running", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status")
        return Promise.resolve({ gameRunning: false, rngUnpredictable: false });
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    expect(await screen.findByText("Transmarvel Searcher")).toBeTruthy();
    expect(await screen.findByText("ui.toolbox.tm-game-not-running")).toBeTruthy();
  });

  it("auto-predicts on open, renders both rolls, and reports the first wishlist hit", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      // Staleness watch: keep it matching so results never flip stale mid-test.
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command} ${JSON.stringify(args)}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: WISHLISTED.trait, trait2: null }], stones: [] });

    renderPage();

    // No click: the mount-time auto-predict fetches the rolls itself.
    expect(await screen.findByText("#1")).toBeTruthy();
    // "#2" appears twice: the table's roll column and the entry's hit badge.
    expect(await screen.findAllByText("#2")).toHaveLength(2);
    // No Match column any more — the matched row is bolded instead. Scoped
    // to the table because the sigil picker's mounted dropdown carries the
    // same names as option labels.
    expect(screen.queryByText("✓")).toBeNull();
    const table = screen.getByRole("table");
    const matchedName = within(table).getByText(`sigil:${WISHLISTED.sigilId}`);
    expect(matchedName.style.fontWeight).toBe("700");
    const unmatchedName = within(table).getByText(`sigil:${OTHER.sigilId}`);
    expect(unmatchedName.style.fontWeight).not.toBe("700");
  });

  it("hides the non-matching row when 'Show matches only' is toggled on", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: WISHLISTED.trait, trait2: null }], stones: [] });

    renderPage();

    expect(await screen.findByText("#1")).toBeTruthy();
    expect((await screen.findAllByText("#2")).length).toBeGreaterThanOrEqual(1);

    const matchesOnly = await screen.findByLabelText("Show matches only");
    await act(async () => {
      fireEvent.click(matchesOnly);
    });

    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.getAllByText("#2").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the translated error banner and no results table when predict rejects", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      // Real Tauri commands returning `Err(String)` reject the JS promise with
      // that string directly — matches TOOL_ERRORS' "transmarvel" domain key.
      if (command === "predict_transmarvel") return Promise.reject("hook-unreachable");
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    // The failing prediction is the mount-time auto-run — no click needed.
    // Mocked t() with no fallback/interpolation arg just echoes the key back,
    // so the mapped copy key IS the expected banner text here.
    expect(await screen.findByText("ui.toolbox.hook-unreachable")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("#1")).toBeNull();
  });

  it("disables the Predict button and rolls input while a prediction is in flight", async () => {
    let resolvePredict!: (value: TransmarvelPrediction) => void;
    const deferred = new Promise<TransmarvelPrediction>((resolve) => {
      resolvePredict = resolve;
    });

    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return deferred;
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    const rollsInput = screen.getByLabelText("Rolls to simulate", { selector: "input" }) as HTMLInputElement;
    // The mount-time auto-predict is holding the deferred open: everything
    // stays disabled from the initial status load straight through the run.
    expect(predictButton.disabled).toBe(true);
    expect(rollsInput.disabled).toBe(true);

    await act(async () => {
      resolvePredict(prediction);
      await deferred;
    });

    await waitFor(() => expect(predictButton.disabled).toBe(false));
    expect(rollsInput.disabled).toBe(false);
  });

  it("shows the stale-results alert once the watched RNG slot moves off the predicted state", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      // Deliberately different from prediction.slotState so the staleness
      // watch's poll reports "moved" instead of matching (see the passing
      // "predicts, renders both rolls" test above for the matching case).
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState + 1);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    // Fake timers must be active BEFORE the staleness watch's effect runs
    // and calls setInterval — switching to fake timers after the fact
    // doesn't retroactively hijack an interval already scheduled against
    // the real clock.
    vi.useFakeTimers();
    try {
      renderPage();

      // Flush the mount-time microtask chains: fetch_transmarvel_status,
      // then the auto-predict effect's predict_transmarvel; fake timers only
      // replace timer functions, not promise resolution, so this doesn't
      // need any timer advance.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText("#1")).toBeTruthy();
      expect(screen.queryByText("ui.toolbox.stale-results")).toBeNull();

      // useStalenessWatch polls every 5s via setInterval; advance fake time
      // and let the in-flight fetch_overmastery_seed promise settle in between.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(screen.getByText("ui.toolbox.stale-results")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers only valid 2nd-trait combinations, popular first then alphabetical", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: EXTRA_SIGIL.trait, trait2: null }], stones: [] });

    renderPage();

    const trait2Input = (await screen.findByLabelText("2nd trait", { selector: "input" })) as HTMLInputElement;
    await waitFor(() => expect(trait2Input.getAttribute("disabled")).toBeNull());
    fireEvent.click(trait2Input);

    // Synthesis-picker ordering: Any, then the popular traits present among
    // the valid candidates (fixed order), then the rest sorted by label —
    // the deterministic mock labels ("trait:<hex>") make that hex order.
    const candidates = sigilTrait2Options(EXTRA_SIGIL.trait);
    const popular = POPULAR_TRAITS.filter((p) => candidates.includes(p));
    expect(popular.length).toBeGreaterThan(0);
    const rest = candidates.filter((c) => !popular.includes(c)).sort();
    expect(optionsOf(trait2Input)).toEqual(["any", ...popular, ...rest]);
  });

  it("clamps a stored 0.1% min rarity into the 20/15/10 option and widens the slot pickers", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({
      sigils: [],
      stones: [{ family: FAMILY, minTier: 2, slot2: null, slot3: null }],
    });

    renderPage();

    // The sanitized entry reads back as minTier 1, whose label the closed
    // rarity select displays.
    const rarityInput = (await screen.findByLabelText("Min rarity", { selector: "input" })) as HTMLInputElement;
    expect(rarityInput.value).toBe("20/15/10");

    // Slot options span every tier >= 1, so the top tier's fixed trait is
    // offered alongside the rolled ones.
    const slot2Input = screen.getByLabelText("Slot 2", { selector: "input" }) as HTMLInputElement;
    fireEvent.click(slot2Input);
    const values = optionsOf(slot2Input);
    expect(new Set(values)).toEqual(new Set(["any", ...slotTraitOptions(FAMILY, 1, 1)]));
    expect(values).toContain(TOP_SLOT2);
  });

  it("resets a slot pick to Any when changing the type makes it unavailable", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    // A slot-2 trait of FAMILY that some other family never rolls there —
    // switching the entry's type to that family must clear the pick. (Some
    // traits are universal, so the pair is found dynamically.)
    const families = [...new Set(POOL.wrightstones.combos.map((c) => c.family))];
    let pick: { trait: string; other: string } | undefined;
    for (const trait of TIERS[0].slots[1].traits) {
      const other = families.find((f) => f !== FAMILY && !slotTraitOptions(f, 0, 1).includes(trait));
      if (other) {
        pick = { trait, other };
        break;
      }
    }
    expect(pick).toBeTruthy();
    useTransmarvelWishlistStore.setState({
      sigils: [],
      stones: [{ family: FAMILY, minTier: 0, slot2: pick!.trait, slot3: null }],
    });

    renderPage();

    const typeInput = (await screen.findByLabelText("Type", { selector: "input" })) as HTMLInputElement;
    await waitFor(() => expect(typeInput.getAttribute("disabled")).toBeNull());
    fireEvent.click(typeInput);

    const listbox = document.getElementById(typeInput.getAttribute("aria-controls")!)!;
    const option = listbox.querySelector(`[role="option"][value="${pick!.other}"]`) as HTMLElement;
    expect(option).toBeTruthy();
    fireEvent.click(option);

    // The entry survives with the stale slot pick cleared, not dropped.
    expect(useTransmarvelWishlistStore.getState().stones).toEqual([
      { family: pick!.other, minTier: 0, slot2: null, slot3: null },
    ]);
  });

  it("caps the rolls input at 50,000", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    const rollsInput = (await screen.findByLabelText("Rolls to simulate", { selector: "input" })) as HTMLInputElement;
    fireEvent.change(rollsInput, { target: { value: "60000" } });
    expect(rollsInput.value).toBe(String(MAX_ROLLS));
    expect(MAX_ROLLS).toBe(50000);
  });

  it("renders at most the row cap and reports the truncation", async () => {
    const total = MAX_SHOWN_ROWS + 5;
    const manyRolls: TransmarvelPrediction = {
      rolls: Array.from({ length: total }, () => prediction.rolls[0]),
      slot: 4,
      slotState: 12345,
      unpredictable: false,
    };
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(manyRolls);
      if (command === "fetch_overmastery_seed") return Promise.resolve(manyRolls.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    await waitFor(() => expect(predictButton.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(predictButton);
    });

    expect(await screen.findByText(`#${MAX_SHOWN_ROWS}`)).toBeTruthy();
    expect(screen.queryByText(`#${MAX_SHOWN_ROWS + 1}`)).toBeNull();
    expect(screen.getByText(`Showing the first ${MAX_SHOWN_ROWS} of ${total} rolls.`)).toBeTruthy();
  });

  it("renders results synthesis-style: name line plus dimmed trait/level line", async () => {
    const sigilPrediction: TransmarvelPrediction = {
      rolls: [
        {
          outcome: {
            type: "sigil",
            sigilId: parseInt(OTHER.sigilId, 16),
            traitLevel: 15,
            trait1: parseInt(OTHER.trait, 16),
            trait2: parseInt(WISHLISTED.trait, 16),
          },
          draws: 5,
        },
      ],
      slot: 4,
      slotState: 12345,
      unpredictable: false,
    };
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(sigilPrediction);
      if (command === "fetch_overmastery_seed") return Promise.resolve(sigilPrediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    await waitFor(() => expect(predictButton.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(predictButton);
    });

    // Name line = the rolled sigil's item name; dimmed line = trait1 with its
    // level, then the 2nd trait.
    expect(await screen.findByText(`sigil:${OTHER.sigilId}`)).toBeTruthy();
    expect(screen.getByText(`trait:${OTHER.trait} Lv15 / trait:${WISHLISTED.trait}`)).toBeTruthy();
  });

  it("labels sigil picker entries by their item name, not their trait id", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: WISHLISTED.trait, trait2: null }], stones: [] });

    renderPage();

    const sigilInput = (await screen.findByLabelText("Sigil", { selector: "input" })) as HTMLInputElement;
    // The selected option's label is what the closed Select displays.
    expect(sigilInput.value).toBe(`sigil:${WISHLISTED.sigilId}`);

    // Options are alphabetized by that displayed name — under the mock
    // labels ("sigil:<item hex>"), that's item-hash order.
    fireEvent.click(sigilInput);
    const expected = [...POOL.sigils].sort((a, b) => a.sigilId.localeCompare(b.sigilId)).map((s) => s.trait);
    expect(optionsOf(sigilInput)).toEqual(expected);
  });

  it("labels rarities by max level per slot, folding the 0.1% tier away", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({
      sigils: [],
      stones: [{ family: FAMILY, minTier: 0, slot2: null, slot3: null }],
    });

    renderPage();

    const rarityInput = (await screen.findByLabelText("Min rarity", { selector: "input" })) as HTMLInputElement;
    await waitFor(() => expect(rarityInput.getAttribute("disabled")).toBeNull());
    fireEvent.click(rarityInput);

    // Hardcoded level layouts pin the live game data (v2.0.2); a regeneration
    // that changes them should fail here loudly.
    const listbox = document.getElementById(rarityInput.getAttribute("aria-controls")!)!;
    const labels = [...listbox.querySelectorAll('[role="option"]')].map((el) => el.textContent);
    expect(labels).toEqual(["15/10/7", "20/15/10"]);
  });

  it("shows a first-hit badge on hitting entries and a dash on entries that never hit", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    // The sigil entry hits roll #2; the prediction contains no stone rolls,
    // so the stone entry can never hit.
    useTransmarvelWishlistStore.setState({
      sigils: [{ trait: WISHLISTED.trait, trait2: null }],
      stones: [{ family: FAMILY, minTier: 0, slot2: null, slot3: null }],
    });

    renderPage();

    // "#2" appears twice: the table's roll column and the sigil entry's badge.
    expect(await screen.findAllByText("#2")).toHaveLength(2);
    // The stone entry renders the dimmed no-hit dash.
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("shows no hit badges or dashes before any prediction", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({
      sigils: [{ trait: WISHLISTED.trait, trait2: null }],
      stones: [{ family: FAMILY, minTier: 0, slot2: null, slot3: null }],
    });

    renderPage();

    await screen.findByLabelText("Sigil", { selector: "input" });
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByText(/^#\d+$/)).toBeNull();
  });

  it("does not auto-predict when the game is not running", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    expect(await screen.findByText("ui.toolbox.tm-game-not-running")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("predict_transmarvel", expect.anything());
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("restores the persisted roll count and auto-predicts with it", async () => {
    window.localStorage.setItem("transmarvel-rolls", "123");
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    const rollsInput = (await screen.findByLabelText("Rolls to simulate", { selector: "input" })) as HTMLInputElement;
    expect(rollsInput.value).toBe("123");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("predict_transmarvel", { query: { rolls: 123 } }));
  });

  it("shows empty-wishlist hints when both lists are empty", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    expect(await screen.findByText("Add sigils you want to roll for.")).toBeTruthy();
    expect(screen.getByText("Add wrightstones you want to roll for.")).toBeTruthy();
  });
});
