import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_STATE, type AnalysisState } from "./state";
import { useAnalysisState } from "./useAnalysisState";

const FULL_STATE: AnalysisState = {
  metric: "taken",
  hostility: "enemy",
  source: 3,
  target: 0,
  ability: "skill:42",
  window: [10, 95],
  by: "target",
  aura: "src:status:4:1:unknown",
  win: null,
};

/** The real state, the real adapter, the real jsdom URL — the point of this
 * test is the wiring between them, so nothing here is stubbed. */
const Harness = () => {
  const [state, setState] = useAnalysisState();

  return (
    <>
      <output data-testid="state">{JSON.stringify(state)}</output>
      <button onClick={() => setState(FULL_STATE)}>set</button>
      <button onClick={() => setState(DEFAULT_STATE)}>reset</button>
    </>
  );
};

// The react-router v6 adapter reads the initial search params from the REAL
// `location.search`, not from MemoryRouter's in-memory history — so a
// pre-seeded URL has to land on `window.location` too, or nuqs never sees it.
const renderHarness = (initialEntries?: string[]) => {
  if (initialEntries !== undefined) window.history.replaceState(null, "", initialEntries[0]);
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <NuqsAdapter>
        <Harness />
      </NuqsAdapter>
    </MemoryRouter>
  );
};

// nuqs writes the REAL window URL, which outlives a render.
afterEach(() => window.history.replaceState(null, "", "/"));

describe("useAnalysisState", () => {
  it("returns DEFAULT_STATE when no params are set", () => {
    renderHarness();

    expect(JSON.parse(screen.getByTestId("state").textContent ?? "")).toEqual({
      metric: "damage",
      hostility: "friendly",
      source: null,
      target: null,
      ability: null,
      window: null,
      by: null,
      aura: null,
      win: null,
    });
  });

  it("round-trips a fully-populated state through the URL", async () => {
    renderHarness();

    fireEvent.click(screen.getByText("set"));

    // Throttled: the state is optimistic, the URL write lands a tick later.
    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain('"metric":"taken"'));
    expect(JSON.parse(screen.getByTestId("state").textContent ?? "")).toEqual(FULL_STATE);

    const search = window.location.search;
    expect(search).toContain("metric=taken");
    expect(search).toContain("side=enemy");
    expect(search).toContain("by=target");
    expect(search).toContain("from=10");
    expect(search).toContain("to=95");
    // `:` is legal in a query value, so nuqs leaves it bare — same as `abil`.
    expect(search).toContain("aura=src:status:4:1:unknown");
  });

  it("clears the URL when reset to DEFAULT_STATE", async () => {
    renderHarness();

    fireEvent.click(screen.getByText("set"));
    await waitFor(() => expect(window.location.search).toContain("metric=taken"));

    fireEvent.click(screen.getByText("reset"));

    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("decodes a pre-seeded URL on mount", async () => {
    renderHarness(["/?metric=taken&side=enemy&from=10&to=95"]);

    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("state").textContent ?? "")).toEqual({
        metric: "taken",
        hostility: "enemy",
        source: null,
        target: null,
        ability: null,
        window: [10, 95],
        by: null,
        aura: null,
        win: null,
      })
    );
  });

  it("decodes a pre-seeded aura param on mount", async () => {
    renderHarness(["/?src=1&aura=src%3Astatus%3A4%3A1%3Aunknown"]);

    await waitFor(() => {
      const decoded = JSON.parse(screen.getByTestId("state").textContent ?? "");
      expect(decoded.source).toBe(1);
      expect(decoded.aura).toBe("src:status:4:1:unknown");
    });
  });
});
