import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisState } from "./state";
import { useAnalysisState } from "./useAnalysisState";

const FULL_STATE: AnalysisState = {
  metric: "taken",
  hostility: "enemy",
  source: 3,
  target: 0,
  ability: "skill:42",
  window: [10, 95],
  by: "target",
};

/** The real state, the real adapter, the real jsdom URL — the point of this
 * test is the wiring between them, so nothing here is stubbed. */
const Harness = () => {
  const [state, setState] = useAnalysisState();

  return (
    <>
      <output data-testid="state">{JSON.stringify(state)}</output>
      <button onClick={() => setState(FULL_STATE)}>set</button>
    </>
  );
};

const renderHarness = () =>
  render(
    <MemoryRouter>
      <NuqsAdapter>
        <Harness />
      </NuqsAdapter>
    </MemoryRouter>
  );

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
  });
});
