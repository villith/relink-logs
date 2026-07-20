import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SynthesisStatus } from "@/types";

vi.mock("@tauri-apps/api", () => ({ invoke: vi.fn() }));
// The real bundle needs an initialized i18next (the app does this at startup;
// this test env does not).
vi.mock("@/utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTraitsBundle: () => ({}),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
    i18n: { language: "en" },
  }),
}));

import { invoke } from "@tauri-apps/api";

import useSynthesisHelper, {
  buildQuery,
  buildTraitOptions,
  initialForm,
  sanitizeSynthesisForm,
} from "./useSynthesisHelper";

const invokeMock = vi.mocked(invoke);

describe("useSynthesisHelper loading", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("is loading until the game status fetch resolves", async () => {
    let resolveStatus!: (s: SynthesisStatus) => void;
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    const { result } = renderHook(() => useSynthesisHelper());
    expect(result.current.loading).toBe(true);
    await act(async () => resolveStatus({ gameRunning: true, sigilCount: 3, rngUnpredictable: false }));
    expect(result.current.loading).toBe(false);
    expect(result.current.status?.gameRunning).toBe(true);
  });

  it("stops loading when the status fetch fails", async () => {
    invokeMock.mockRejectedValue("game-not-running");
    const { result } = renderHook(() => useSynthesisHelper());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("game-not-running");
  });
});

describe("sanitizeSynthesisForm", () => {
  it("passes a valid saved form through unchanged", () => {
    const saved = { trait1: "ceb700ee", trait2: "dc584f60", anyOrder: true, requireLucky: false };
    expect(sanitizeSynthesisForm(saved)).toEqual(saved);
  });

  it("falls back to the initial form for garbage", () => {
    expect(sanitizeSynthesisForm(null)).toEqual(initialForm);
    expect(sanitizeSynthesisForm("x")).toEqual(initialForm);
    expect(sanitizeSynthesisForm(undefined)).toEqual(initialForm);
  });

  it("nulls traits that are not synthesizable and defaults broken flags", () => {
    expect(
      sanitizeSynthesisForm({ trait1: "not-a-trait", trait2: "ceb700ee", anyOrder: "yes", requireLucky: 0 })
    ).toEqual({
      trait1: null,
      trait2: "ceb700ee",
      anyOrder: initialForm.anyOrder,
      requireLucky: initialForm.requireLucky,
    });
  });
});

describe("initialForm", () => {
  it("defaults to lvl-15-only results in exact slot order", () => {
    expect(initialForm.requireLucky).toBe(true);
    expect(initialForm.anyOrder).toBe(false);
  });
});

describe("buildQuery", () => {
  it("parses hex trait values and maps the form to the backend query", () => {
    expect(buildQuery({ trait1: "0114dd91", trait2: "01b49f0d", anyOrder: true, requireLucky: false })).toEqual({
      trait1: 0x0114dd91,
      trait2: 0x01b49f0d,
      anyOrder: true,
      requireLucky: false,
    });
  });

  it("returns null without a first trait, and null trait2 when unset", () => {
    expect(buildQuery({ trait1: null, trait2: null, anyOrder: false, requireLucky: false })).toBeNull();
    expect(buildQuery({ trait1: "0114dd91", trait2: null, anyOrder: false, requireLucky: true })).toEqual({
      trait1: 0x0114dd91,
      trait2: null,
      anyOrder: false,
      requireLucky: true,
    });
  });
});

describe("buildTraitOptions", () => {
  it("sorts by label and drops entries without text", () => {
    // e0abfdfe = Aegis, 50079a1c = ATK — both on synthesizable sigils.
    expect(
      buildTraitOptions({
        "50079a1c": { text: "ATK" },
        e0abfdfe: { text: "Aegis" },
        deadbeef: {},
      })
    ).toEqual([
      {
        group: " ",
        items: [
          { value: "e0abfdfe", label: "Aegis" },
          { value: "50079a1c", label: "ATK" },
        ],
      },
    ]);
  });

  it("keeps only traits that appear on synthesizable sigils", () => {
    // dbe1d775 = Alpha and 4c588c27 = War Elemental exist only on special
    // sigils; bbd77c33 = Unbound Strike is a weapon trait on no sigil at all;
    // d461ecfb = Crabvestment Returns is only carried by a special sigil (via
    // a different internal id, so it is on no synthesizable gem row either).
    // Only ATK is in synthesis-traits.json.
    expect(
      buildTraitOptions({
        dbe1d775: { text: "Alpha" },
        "4c588c27": { text: "War Elemental" },
        bbd77c33: { text: "Unbound Strike" },
        d461ecfb: { text: "Crabvestment Returns" },
        "50079a1c": { text: "ATK" },
      })
    ).toEqual([{ group: " ", items: [{ value: "50079a1c", label: "ATK" }] }]);
  });

  it("puts the popular traits at the top, divided from the rest", () => {
    // Popular: Stun Power, HP, Supplementary DMG, DMG Cap, Nimble Onslaught,
    // Uplift — flat leading options in that order; the alphabetical rest sits
    // in a whitespace-labelled group, which Mantine renders as a bare divider.
    expect(
      buildTraitOptions({
        "50079a1c": { text: "ATK" },
        b5ff9fd3: { text: "Uplift" },
        ceb700ee: { text: "Stun Power" },
        dc584f60: { text: "DMG Cap" },
        e0abfdfe: { text: "Aegis" },
        f372f096: { text: "HP" },
      })
    ).toEqual([
      { value: "ceb700ee", label: "Stun Power" },
      { value: "f372f096", label: "HP" },
      { value: "dc584f60", label: "DMG Cap" },
      { value: "b5ff9fd3", label: "Uplift" },
      {
        group: " ",
        items: [
          { value: "e0abfdfe", label: "Aegis" },
          { value: "50079a1c", label: "ATK" },
        ],
      },
    ]);
  });
});
