import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { useState } from "react";
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
  aura: ["src:status:4:1:unknown", "tgt:status:9:1:1"],
  win: ["break:2", "sba"],
};

/** The real state, the real adapter, the real jsdom URL — the point of this
 * test is the wiring between them, so nothing here is stubbed.
 *
 * `testId` suffixes the testids (`state-0`, `set-0`, ...) so two of these can
 * mount side by side without colliding; left undefined it falls back to the
 * bare `state`/`set`/`reset` the six pre-existing tests already query by, so
 * they keep passing unchanged. */
const Harness = ({ paneIndex = 0, testId }: { paneIndex?: number; testId?: string }) => {
  const [state, setState] = useAnalysisState(paneIndex);
  const suffix = testId === undefined ? "" : `-${testId}`;

  return (
    <>
      <output data-testid={`state${suffix}`}>{JSON.stringify(state)}</output>
      <button data-testid={`set${suffix}`} onClick={() => setState(FULL_STATE)}>
        set
      </button>
      <button data-testid={`reset${suffix}`} onClick={() => setState(DEFAULT_STATE)}>
        reset
      </button>
    </>
  );
};

// The react-router v6 adapter reads the initial search params from the REAL
// `location.search`, not from MemoryRouter's in-memory history — so a
// pre-seeded URL has to land on `window.location` too, or nuqs never sees it.
const renderHarness = (initialEntries?: string[], paneIndex?: number) => {
  if (initialEntries !== undefined) window.history.replaceState(null, "", initialEntries[0]);
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <NuqsAdapter>
        <Harness paneIndex={paneIndex} />
      </NuqsAdapter>
    </MemoryRouter>
  );
};

// Two panes in one adapter — what Task 10 actually renders. Testids carry the
// pane index so each pane's output/buttons are queryable on their own.
const renderTwoPanes = (initialEntries?: string[]) => {
  if (initialEntries !== undefined) window.history.replaceState(null, "", initialEntries[0]);
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <NuqsAdapter>
        <Harness paneIndex={0} testId="0" />
        <Harness paneIndex={1} testId="1" />
      </NuqsAdapter>
    </MemoryRouter>
  );
};

// Exact param reads rather than substring matches on the raw query string —
// `toContain("src=1")` would also pass a write that clobbered it into
// `src=13`.
const params = () => new URLSearchParams(window.location.search);

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
      aura: [],
      win: [],
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
    // Several filters ride ONE param, comma-separated; nuqs percent-encodes the
    // comma, which is why this reads the decoded form rather than the raw one.
    expect(decodeURIComponent(search)).toContain("aura=src:status:4:1:unknown,tgt:status:9:1:1");
    expect(decodeURIComponent(search)).toContain("win=break:2,sba");
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
        aura: [],
        win: [],
      })
    );
  });

  it("decodes a pre-seeded aura param on mount", async () => {
    renderHarness(["/?src=1&aura=src%3Astatus%3A4%3A1%3Aunknown"]);

    await waitFor(() => {
      const decoded = JSON.parse(screen.getByTestId("state").textContent ?? "");
      expect(decoded.source).toBe(1);
      expect(decoded.aura).toEqual(["src:status:4:1:unknown"]);
    });
  });

  it("decodes a pre-seeded MULTI-value filter param on mount", async () => {
    renderHarness(["/?src=1&tgt=0&aura=src%3Astatus%3A4%3A1%3Aunknown%2Ctgt%3Astatus%3A9%3A1%3A1&win=sba%2Cbreak%3A1"]);

    await waitFor(() => {
      const decoded = JSON.parse(screen.getByTestId("state").textContent ?? "");
      expect(decoded.aura).toEqual(["src:status:4:1:unknown", "tgt:status:9:1:1"]);
      expect(decoded.win).toEqual(["sba", "break:1"]);
    });
  });
});

describe("pane scoping", () => {
  it("reads pane 0 off the bare keys, so a link written before compare still opens", () => {
    renderHarness(["/?metric=taken&src=1"]);

    const state = JSON.parse(screen.getByTestId("state").textContent ?? "");
    expect(state.metric).toBe("taken");
    expect(state.source).toBe(1);
  });

  it("reads pane 1 off the suffixed keys while sharing the metric", () => {
    renderHarness(["/?metric=taken&src=1&src1=3"], 1);

    const state = JSON.parse(screen.getByTestId("state").textContent ?? "");
    expect(state.metric).toBe("taken");
    expect(state.source).toBe(3);
  });

  it("does not let one pane read another pane's pins", () => {
    renderHarness(["/?src=1"], 1);

    expect(JSON.parse(screen.getByTestId("state").textContent ?? "").source).toBeNull();
  });

  it("writes pane 1's pins to the suffixed keys, leaving pane 0's alone", async () => {
    renderHarness(["/?src=1"], 1);

    fireEvent.click(screen.getByText("set"));

    await waitFor(() => expect(params().get("src1")).toBe("3"));
    // Pane 0's own pin is untouched by a pane 1 write — the whole point of
    // suffixing. FULL_STATE sets source 3, so an unscoped write would have
    // clobbered `src=1`. An exact read, not a substring match: `toContain`
    // would also pass if the write had clobbered it into `src=13`.
    expect(params().get("src")).toBe("1");
  });

  it("keeps the shared fields unsuffixed whichever pane writes them", async () => {
    renderHarness(undefined, 1);

    fireEvent.click(screen.getByText("set"));

    await waitFor(() => expect(params().get("metric")).toBe("taken"));
    expect(params().get("metric1")).toBeNull();
    expect(params().get("side")).toBe("enemy");
    expect(params().get("side1")).toBeNull();
  });
});

describe("two panes mounted together", () => {
  it("keeps each pane's pins separate when both are mounted", () => {
    renderTwoPanes(["/?src=1&src1=9"]);

    expect(JSON.parse(screen.getByTestId("state-0").textContent ?? "").source).toBe(1);
    expect(JSON.parse(screen.getByTestId("state-1").textContent ?? "").source).toBe(9);
  });

  it("lets one pane's write change the shared metric without touching the other's pins", async () => {
    renderTwoPanes(["/?src=1&src1=9"]);

    fireEvent.click(screen.getByTestId("set-1"));

    await waitFor(() => expect(params().get("src1")).toBe("3"));
    expect(params().get("src")).toBe("1");
    expect(params().get("metric")).toBe("taken");

    await waitFor(() => expect(JSON.parse(screen.getByTestId("state-0").textContent ?? "").metric).toBe("taken"));
    expect(JSON.parse(screen.getByTestId("state-0").textContent ?? "").source).toBe(1);
  });
});

describe("a live pane's index changing", () => {
  // Reproduces the reviewer's finding directly, rather than only asserting
  // the defence: a mounted pane whose `paneIndex` prop changes (what a naive
  // reindex-on-removal would do, before Task 11 remounts instead) hits the
  // render where nuqs still has the OLD key's value cached and the NEW key
  // reads back `undefined`. Without the `?? null` coalescing in
  // `useAnalysisState`, `decodeState` throws inside that render and this test
  // fails with an uncaught TypeError instead of reaching the final assertion.
  it("does not throw when a mounted pane's index moves, and settles on the new pane's value", async () => {
    const ReindexHarness = () => {
      const [index, setIndex] = useState(2);
      return (
        <>
          <Harness paneIndex={index} testId="live" />
          <button data-testid="reindex" onClick={() => setIndex(1)}>
            reindex
          </button>
        </>
      );
    };

    // As in `renderHarness`: the react-router v6 adapter reads the initial
    // params off the REAL `window.location.search`, not off MemoryRouter's
    // in-memory history.
    window.history.replaceState(null, "", "/?src1=7&src2=42");
    render(
      <MemoryRouter initialEntries={["/?src1=7&src2=42"]}>
        <NuqsAdapter>
          <ReindexHarness />
        </NuqsAdapter>
      </MemoryRouter>
    );

    expect(JSON.parse(screen.getByTestId("state-live").textContent ?? "").source).toBe(42);

    // The crash, if `decodeState` isn't defended, happens inside this click —
    // React re-renders synchronously under `act()`, and the render that reads
    // the new key's stale-`undefined` value is part of that same flush.
    fireEvent.click(screen.getByTestId("reindex"));

    await waitFor(() => expect(JSON.parse(screen.getByTestId("state-live").textContent ?? "").source).toBe(7));
  });
});
