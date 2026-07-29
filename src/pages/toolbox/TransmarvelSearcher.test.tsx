import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
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
  "ui.toolbox.tm-entry-more": "+{{count}} more in Full Results",
  "ui.toolbox.tm-tab-sigils": "Sigils ({{hit}}/{{total}})",
  "ui.toolbox.tm-tab-stones": "Wrightstones ({{hit}}/{{total}})",
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

/** The page's tab selection lives in the URL, so it needs a nuqs adapter —
 * the testing one stands in for the router-backed adapter the app installs. */
const renderPage = () =>
  render(
    <MantineProvider>
      <NuqsTestingAdapter>
        <TransmarvelSearcher />
      </NuqsTestingAdapter>
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
// A sigil whose fixed pair widens its 2nd-trait options beyond the lot.
const EXTRA_SIGIL = POOL.sigils.find((s) => s.fixedPairs.length > 0)!;
const EXTRA_PAIR = EXTRA_SIGIL.fixedPairs[0];

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

// Two tier-0 rolls of FAMILY differing in their 2nd-slot trait — the case a
// wildcard ("Any") entry is meant to disambiguate.
const SLOT2_A = TIERS[0].slots[1].traits[0];
const SLOT2_B = TIERS[0].slots[1].traits.find((t) => t !== SLOT2_A)!;
const SLOT3 = TIERS[0].slots[2].traits[0];
const stoneRoll = (slot2: string) => ({
  outcome: {
    type: "wrightstone" as const,
    item: parseInt(TIERS[0].item, 16),
    traits: [
      [parseInt(FAMILY, 16), 10],
      [parseInt(slot2, 16), 7],
      [parseInt(SLOT3, 16), 5],
    ] as [number, number][],
  },
  draws: 12,
});
const stonePrediction: TransmarvelPrediction = {
  rolls: [stoneRoll(SLOT2_A), stoneRoll(SLOT2_B)],
  slot: 4,
  slotState: 12345,
  unpredictable: false,
};
/** The dimmed outcome line the page builds for one of those rolls. */
const stoneLine = (slot2: string) => `trait:${FAMILY} Lv10 / trait:${slot2} Lv7 / trait:${SLOT3} Lv5`;

describe("TransmarvelSearcher", () => {
  beforeEach(() => {
    invoke.mockReset();
    // The store is a module-level singleton, so its persisted state (roll
    // count included) would otherwise leak between tests.
    useTransmarvelWishlistStore.setState({ sigils: [], stones: [], rolls: 50 });
    window.localStorage.clear();
  });

  it("shows the title and the game-not-running alert when the game isn't running", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status")
        return Promise.resolve({ gameRunning: false, rngUnpredictable: false });
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    expect(await screen.findByText("Transmarvel Wishlist")).toBeTruthy();
    expect(await screen.findByText("ui.toolbox.tm-game-not-running")).toBeTruthy();
  });

  it("auto-predicts on open, renders both rolls, and reports the first wishlist hit", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      // Staleness watch: keep it matching so results never flip stale mid-test.
      if (command === "fetch_rng_slot") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command} ${JSON.stringify(args)}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: WISHLISTED.trait, trait2: null }], stones: [] });

    renderPage();

    // No Predict click: the mount-time auto-predict fetches the rolls itself.
    // The roll table lives in the Full Results tab; activate it so role
    // queries can see it (the hidden panel is out of the accessibility tree).
    await screen.findByText("#1");
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Full Results" }));
    });
    // No Match column any more — the matched row is bolded instead. Scoped
    // to the table because the sigil picker's mounted dropdown and the
    // wishlist's own hit list repeat these strings.
    expect(screen.queryByText("✓")).toBeNull();
    const table = screen.getByRole("table");
    expect(within(table).getByText("#1")).toBeTruthy();
    expect(within(table).getByText("#2")).toBeTruthy();
    const matchedName = within(table).getByText(`sigil:${WISHLISTED.sigilId}`);
    expect(matchedName.style.fontWeight).toBe("700");
    const unmatchedName = within(table).getByText(`sigil:${OTHER.sigilId}`);
    expect(unmatchedName.style.fontWeight).not.toBe("700");
  });

  it("hides the non-matching row when 'Show matches only' is toggled on", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_rng_slot") return Promise.resolve(prediction.slotState);
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
      if (command === "fetch_rng_slot") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    const rollsInput = screen.getByLabelText("Rolls to simulate", { selector: "input" }) as HTMLInputElement;
    // The mount-time auto-predict holds the deferred open, so once the
    // controls latch disabled they stay disabled until we resolve it below.
    // Wait for that state instead of sampling it: the auto-predict is kicked
    // off by an effect, and React flushes passive effects after the commit
    // that clears `loading`, so which render the assertion lands on is
    // scheduler-dependent — sampling read disabled on Windows and enabled on
    // Linux CI. Waiting for the prediction to be in flight first keeps this
    // asserting the in-flight hold rather than the initial status load.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("predict_transmarvel", { query: { rolls: 50 } }));
    await waitFor(() => expect(predictButton.disabled).toBe(true));
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
      if (command === "fetch_rng_slot") return Promise.resolve(prediction.slotState + 1);
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
      // and let the in-flight fetch_rng_slot promise settle in between.
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

    const trait2Input = (await screen.findByLabelText("2nd Trait", { selector: "input" })) as HTMLInputElement;
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

  it("clamps a stored 0.1% Lvls into the 20/15/10 option and widens the slot pickers", async () => {
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
    const rarityInput = (await screen.findByLabelText("Lvls", { selector: "input" })) as HTMLInputElement;
    expect(rarityInput.value).toBe("20/15/10");

    // Slot options span every tier >= 1, so the top tier's fixed trait is
    // offered alongside the rolled ones.
    const slot2Input = screen.getByLabelText("Trait 2", { selector: "input" }) as HTMLInputElement;
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
      if (command === "fetch_rng_slot") return Promise.resolve(manyRolls.slotState);
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
      if (command === "fetch_rng_slot") return Promise.resolve(sigilPrediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    await waitFor(() => expect(predictButton.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(predictButton);
    });

    // Name line = the rolled sigil's item name; dimmed line = both traits,
    // no levels (sigil traits share one level, so showing it is noise).
    expect(await screen.findByText(`sigil:${OTHER.sigilId}`)).toBeTruthy();
    expect(screen.getByText(`trait:${OTHER.trait} / trait:${WISHLISTED.trait}`)).toBeTruthy();
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

    // Every plain sigil plus every fixed-pair sigil gets an option (the mock
    // gives each item hash its own label, so none collapse as duplicates).
    fireEvent.click(sigilInput);
    const values = optionsOf(sigilInput);
    expect(values).toHaveLength(POOL.sigils.length + POOL.sigils.flatMap((s) => s.fixedPairs).length);
    expect(values).toContain(WISHLISTED.trait);

    // Options are alphabetized by that displayed name — under the mock
    // labels ("sigil:<item hex>"), that's item-hash order.
    const listbox = document.getElementById(sigilInput.getAttribute("aria-controls")!)!;
    const labels = [...listbox.querySelectorAll('[role="option"]')].map((el) => el.textContent!);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("offers fixed-pair sigils by their own name and pins both traits when picked", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: WISHLISTED.trait, trait2: null }], stones: [] });

    renderPage();

    const sigilInput = (await screen.findByLabelText("Sigil", { selector: "input" })) as HTMLInputElement;
    fireEvent.click(sigilInput);

    // The pair sigil is its own option, keyed by both traits.
    const pairValue = `${EXTRA_SIGIL.trait}:${EXTRA_PAIR.trait2}`;
    expect(optionsOf(sigilInput)).toContain(pairValue);
    const listbox = document.getElementById(sigilInput.getAttribute("aria-controls")!)!;
    const option = listbox.querySelector(`[role="option"][value="${pairValue}"]`) as HTMLElement;
    // Labeled by the pair item's own name, not its trait-1 sigil's.
    expect(option.textContent).toBe(`sigil:${EXTRA_PAIR.sigilId}`);

    fireEvent.click(option);

    // Picking it writes both traits...
    expect(useTransmarvelWishlistStore.getState().sigils).toEqual([
      { trait: EXTRA_SIGIL.trait, trait2: EXTRA_PAIR.trait2 },
    ]);
    // ...and the 2nd trait is locked to the pair's trait.
    const trait2Input = screen.getByLabelText("2nd Trait", { selector: "input" }) as HTMLInputElement;
    expect(trait2Input.value).toBe(`trait:${EXTRA_PAIR.trait2}`);
    expect(trait2Input.getAttribute("disabled")).not.toBeNull();
  });

  it("releases the pinned 2nd trait when the plain sigil is picked again", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({
      sigils: [{ trait: EXTRA_SIGIL.trait, trait2: EXTRA_PAIR.trait2 }],
      stones: [],
    });

    renderPage();

    const sigilInput = (await screen.findByLabelText("Sigil", { selector: "input" })) as HTMLInputElement;
    // The pair sigil's own name is what a pinned entry displays.
    expect(sigilInput.value).toBe(`sigil:${EXTRA_PAIR.sigilId}`);
    fireEvent.click(sigilInput);

    const listbox = document.getElementById(sigilInput.getAttribute("aria-controls")!)!;
    fireEvent.click(listbox.querySelector(`[role="option"][value="${EXTRA_SIGIL.trait}"]`) as HTMLElement);

    // Choosing the plain sigil drops the pair's fixed 2nd trait rather than
    // silently keeping it (which would leave the row locked and unchanged).
    expect(useTransmarvelWishlistStore.getState().sigils).toEqual([{ trait: EXTRA_SIGIL.trait, trait2: null }]);
    const trait2Input = screen.getByLabelText("2nd Trait", { selector: "input" }) as HTMLInputElement;
    expect(trait2Input.getAttribute("disabled")).toBeNull();
  });

  it("starts a new wrightstone at Fortification 20/15/10 with Supplementary DMG", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    // The Add button lives in the Wrightstones tab's panel.
    fireEvent.click(await screen.findByRole("tab", { name: /^Wrightstones/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add wrightstone" }));

    // Live v2.0.2 hashes: the Fortification family (trait 1 = HP) and the
    // Supplementary DMG trait. A pool regeneration that retires either should
    // fail here rather than silently seed an entry sanitize would drop.
    expect(useTransmarvelWishlistStore.getState().stones).toEqual([
      { family: "f372f096", minTier: 1, slot2: "57ab5b10", slot3: null },
    ]);
  });

  it("counts matched entries per list in its tab title", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_rng_slot") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    // Two sigils, one of which hits; one stone, which can't (no stone rolls).
    useTransmarvelWishlistStore.setState({
      sigils: [
        { trait: WISHLISTED.trait, trait2: null },
        { trait: OTHER.trait, trait2: TOP_SLOT2 },
      ],
      stones: [{ family: FAMILY, minTier: 0, slot2: null, slot3: null }],
    });

    renderPage();

    expect(await screen.findByRole("tab", { name: "Sigils (1/2)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Wrightstones (0/1)" })).toBeTruthy();
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

    const rarityInput = (await screen.findByLabelText("Lvls", { selector: "input" })) as HTMLInputElement;
    await waitFor(() => expect(rarityInput.getAttribute("disabled")).toBeNull());
    fireEvent.click(rarityInput);

    // Hardcoded level layouts pin the live game data (v2.0.2); a regeneration
    // that changes them should fail here loudly.
    const listbox = document.getElementById(rarityInput.getAttribute("aria-controls")!)!;
    const labels = [...listbox.querySelectorAll('[role="option"]')].map((el) => el.textContent);
    expect(labels).toEqual(["15/10/7", "20/15/10"]);
  });

  it("lists and highlights an entry that hits, leaving one that never hits plain", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_rng_slot") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    // The sigil entry hits roll #2; the prediction contains no stone rolls,
    // so the stone entry can never hit.
    useTransmarvelWishlistStore.setState({
      sigils: [{ trait: WISHLISTED.trait, trait2: null }],
      stones: [{ family: FAMILY, minTier: 0, slot2: null, slot3: null }],
    });

    renderPage();

    // The Sigils tab opens first, so its panel is the visible one.
    const sigilsPanel = await screen.findByRole("tabpanel");
    await waitFor(() => expect(within(sigilsPanel).getAllByText("#2")).toHaveLength(1));
    expect(sigilsPanel.querySelectorAll("[data-hits]")).toHaveLength(1);

    // The stone entry can't hit: its card goes unmarked, and nothing renders
    // under its row rather than a "no hits" line.
    fireEvent.click(screen.getByRole("tab", { name: /^Wrightstones/ }));
    const stonesPanel = screen.getByRole("tabpanel");
    expect(stonesPanel.querySelectorAll("[data-hits]")).toHaveLength(0);
    expect(within(stonesPanel).queryByText(/^#\d+$/)).toBeNull();
  });

  it("expands a hitting entry by default, listing each matching roll's outcome", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(stonePrediction);
      if (command === "fetch_rng_slot") return Promise.resolve(stonePrediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    // A wildcard entry: both rolls match, and only the expanded list reveals
    // which 2nd-slot trait each one actually carries.
    useTransmarvelWishlistStore.setState({
      sigils: [],
      stones: [{ family: FAMILY, minTier: 0, slot2: null, slot3: null }],
    });

    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /^Wrightstones/ }));
    const stonesPanel = screen.getByRole("tabpanel");
    // Both hits are listed with their own roll # and resolved traits — the
    // 2nd-slot trait each one carries is the whole point of the wildcard.
    expect(await within(stonesPanel).findByText(stoneLine(SLOT2_A))).toBeTruthy();
    expect(within(stonesPanel).getByText(stoneLine(SLOT2_B))).toBeTruthy();
    expect(within(stonesPanel).getByText("#1")).toBeTruthy();
    expect(within(stonesPanel).getByText("#2")).toBeTruthy();
  });

  it("shows no per-entry results before any prediction", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(statusOff);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({
      sigils: [{ trait: WISHLISTED.trait, trait2: null }],
      stones: [{ family: FAMILY, minTier: 0, slot2: null, slot3: null }],
    });

    renderPage();

    const wishlist = await screen.findByRole("tabpanel");
    expect(wishlist.querySelectorAll("[data-hits]")).toHaveLength(0);
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
    useTransmarvelWishlistStore.setState({ rolls: 123 });
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_rng_slot") return Promise.resolve(prediction.slotState);
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
