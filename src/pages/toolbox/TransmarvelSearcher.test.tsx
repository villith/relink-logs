import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import pool from "@/assets/transmarvel-pool.json";
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
import "@/i18n";

// A minimal interpolation-aware `t`: string second args are the JSX fallback
// (matches the rest of the toolbox test suite's convention), object second
// args are `{{key}}` template substitutions for the handful of interpolated
// strings this page renders — needed so "first hit at roll #2" is actually
// assertable rather than just the raw key.
const TEMPLATES: Record<string, string> = {
  "ui.toolbox.tm-first-hit": "First wishlist hit at roll #{{n}}",
  "ui.toolbox.tm-no-hits": "No wishlist hits in the next {{rolls}} rolls.",
  "ui.toolbox.tm-stone-trait-slot": "Trait {{n}}",
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

import { useTransmarvelWishlistStore } from "@/stores/useTransmarvelWishlistStore";

import TransmarvelSearcher from "./TransmarvelSearcher";

const renderPage = () =>
  render(
    <MantineProvider>
      <TransmarvelSearcher />
    </MantineProvider>
  );

// Real pool entries so `sanitizeWishlists` (which validates against the pool)
// keeps the seeded wishlist entry instead of silently dropping it.
const WISHLISTED = pool.sigils[0]; // { trait: "05f2ecdc", sigilId: "6cba6b0d" }
const OTHER = pool.sigils[1]; // { trait: "05fa4599", sigilId: "bcedf060" }

const status: TransmarvelStatus = { gameRunning: true, rngUnpredictable: false };

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
  });

  it("shows the title and the game-not-running alert when the game isn't running", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve({ gameRunning: false, rngUnpredictable: false });
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    renderPage();

    expect(await screen.findByText("Transmarvel Searcher")).toBeTruthy();
    expect(await screen.findByText("ui.toolbox.tm-game-not-running")).toBeTruthy();
  });

  it("predicts, renders both rolls, and reports the first wishlist hit", async () => {
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      // Staleness watch: keep it matching so results never flip stale mid-test.
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command} ${JSON.stringify(args)}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: WISHLISTED.trait }], stones: [] });

    renderPage();

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    await waitFor(() => expect(predictButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(predictButton);
    });

    expect(await screen.findByText("#1")).toBeTruthy();
    expect(await screen.findByText("#2")).toBeTruthy();
    expect(await screen.findByText("First wishlist hit at roll #2")).toBeTruthy();
  });

  it("hides the non-matching row when 'Show matches only' is toggled on", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_transmarvel_status") return Promise.resolve(status);
      if (command === "predict_transmarvel") return Promise.resolve(prediction);
      if (command === "fetch_overmastery_seed") return Promise.resolve(prediction.slotState);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    useTransmarvelWishlistStore.setState({ sigils: [{ trait: WISHLISTED.trait }], stones: [] });

    renderPage();

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    await waitFor(() => expect(predictButton.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(predictButton);
    });

    expect(await screen.findByText("#1")).toBeTruthy();
    expect(await screen.findByText("#2")).toBeTruthy();

    const matchesOnly = await screen.findByLabelText("Show matches only");
    await act(async () => {
      fireEvent.click(matchesOnly);
    });

    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.getByText("#2")).toBeTruthy();
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

    const predictButton = (await screen.findByRole("button", { name: "Predict" })) as HTMLButtonElement;
    await waitFor(() => expect(predictButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(predictButton);
    });

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
    await waitFor(() => expect(predictButton.disabled).toBe(false));
    const rollsInput = screen.getByLabelText("Rolls to simulate", { selector: "input" }) as HTMLInputElement;
    expect(rollsInput.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(predictButton);
    });

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

      // Flush the mount-time fetch_transmarvel_status microtask chain;
      // fake timers only replace timer functions, not promise resolution,
      // so this doesn't need any timer advance.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const predictButton = screen.getByRole("button", { name: "Predict" }) as HTMLButtonElement;
      expect(predictButton.disabled).toBe(false);

      await act(async () => {
        fireEvent.click(predictButton);
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
});
