import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { useSelectorParams } from "../useSelectorParams";

import { useUrlQueryString } from "./useUrlQueryString";

/** The real pins, the real adapter, the real jsdom URL — the point of this test
 * is the wiring between them, so nothing here is stubbed. */
const Harness = () => {
  const [, setPins] = useSelectorParams();
  const query = useUrlQueryString();

  return (
    <>
      <output data-testid="query">{query}</output>
      <button onClick={() => setPins({ source: 2, targets: [3, 4], ability: null })}>pin</button>
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

describe("useUrlQueryString", () => {
  it("is empty before anything is pinned", () => {
    renderHarness();
    expect(screen.getByTestId("query").textContent).toBe("");
  });

  it("reports the pins nuqs just wrote to the URL", async () => {
    // nuqs updates the URL with `history.replaceState` unless `shallow: false`,
    // and react-router's own `useLocation()` never observes a shallow write —
    // it answers with its mount-time search forever. Reading the pins back is
    // the whole job of this hook, so this is the case it exists for.
    renderHarness();

    fireEvent.click(screen.getByText("pin"));

    // Throttled: the state is optimistic, the URL write lands a tick later.
    await waitFor(() => expect(screen.getByTestId("query").textContent).toContain("src=2"));
    expect(screen.getByTestId("query").textContent).toContain("tgt=3");
    expect(screen.getByTestId("query").textContent?.startsWith("?")).toBe(true);
  });
});
