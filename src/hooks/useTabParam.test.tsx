import { act, renderHook } from "@testing-library/react";
import { withNuqsTestingAdapter, type OnUrlUpdateFunction } from "nuqs/adapters/testing";
import { describe, expect, it, vi } from "vitest";

import { useTabParam } from "./useTabParam";

const TABS = ["overview", "sba", "equipment", "builds"] as const;
type Tab = (typeof TABS)[number];

const renderTabParam = (searchParams: string, tabs: readonly Tab[] = TABS, onUrlUpdate?: OnUrlUpdateFunction) =>
  renderHook(({ available }: { available: readonly Tab[] }) => useTabParam(available, "overview"), {
    initialProps: { available: tabs },
    wrapper: withNuqsTestingAdapter({ searchParams, onUrlUpdate }),
  });

describe("useTabParam", () => {
  it("defaults when the URL names no tab", () => {
    const { result } = renderTabParam("");
    expect(result.current[0]).toBe("overview");
  });

  it("reads the tab named in the URL", () => {
    const { result } = renderTabParam("?tab=builds");
    expect(result.current[0]).toBe("builds");
  });

  it("defaults on a tab name it does not recognise", () => {
    const { result } = renderTabParam("?tab=nonsense");
    expect(result.current[0]).toBe("overview");
  });

  it("defaults while the named tab is unavailable, then adopts it once it is", () => {
    // A quest detail restores `?tab=builds` before its player data has loaded,
    // when the builds tab is still disabled. Selecting it then would leave the
    // page with no panel at all.
    const { result, rerender } = renderTabParam("?tab=builds", ["overview", "sba"]);
    expect(result.current[0]).toBe("overview");

    rerender({ available: TABS });
    expect(result.current[0]).toBe("builds");
  });

  it("writes the selected tab to the URL without stacking history entries", async () => {
    const onUrlUpdate = vi.fn();
    const { result } = renderTabParam("", TABS, onUrlUpdate);

    await act(() => result.current[1]("sba"));

    expect(onUrlUpdate).toHaveBeenCalledOnce();
    expect(onUrlUpdate.mock.calls[0][0].searchParams.get("tab")).toBe("sba");
    // Push would make every tab click a Back-button stop.
    expect(onUrlUpdate.mock.calls[0][0].options.history).toBe("replace");
  });

  it("switches to the tab it just wrote", async () => {
    const { result } = renderHook(() => useTabParam(TABS, "overview"), {
      wrapper: withNuqsTestingAdapter({ searchParams: "", hasMemory: true }),
    });

    await act(() => result.current[1]("equipment"));

    expect(result.current[0]).toBe("equipment");
  });

  it("drops the parameter when the tab is cleared", async () => {
    const onUrlUpdate = vi.fn();
    const { result } = renderTabParam("?tab=sba", TABS, onUrlUpdate);

    await act(() => result.current[1](null));

    expect(onUrlUpdate.mock.calls[0][0].searchParams.get("tab")).toBeNull();
  });
});
