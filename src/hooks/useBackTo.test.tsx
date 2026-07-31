import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { useBackTo } from "./useBackTo";

/**
 * Renders the hook at `/logs/42`, arriving with whatever route state the link
 * that opened it carried, and reports where `goBack` lands.
 *
 * No `<Routes>`: the hook has to stay mounted across the navigation for
 * `result.current` to report the destination rather than a stale reading, and
 * `useLocation` needs no route match to work.
 */
const renderBackTo = (state: unknown, fallback?: string) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[{ pathname: "/logs/42", state }]}>{children}</MemoryRouter>
  );
  const { result } = renderHook(() => ({ goBack: useBackTo(fallback), here: useLocation() }), { wrapper });
  return {
    goBack: () => act(() => result.current.goBack()),
    landedOn: () => `${result.current.here.pathname}${result.current.here.search}`,
  };
};

describe("useBackTo", () => {
  it("falls back to the quest list when the link carried no destination", () => {
    // The header's per-tab memory restores a quest detail by URL alone, so a
    // log reached that way has no route state — and Back must not walk history
    // into whichever tab the reader was in a moment ago.
    const view = renderBackTo(undefined);

    view.goBack();

    expect(view.landedOn()).toBe("/logs");
  });

  it("goes where the link that opened the screen said to", () => {
    const view = renderBackTo({ backTo: "/logs/toolbox/audit" });

    view.goBack();

    expect(view.landedOn()).toBe("/logs/toolbox/audit");
  });

  it("keeps the search string of the named destination", () => {
    const view = renderBackTo({ backTo: "/logs/conflux?tab=rooms" });

    view.goBack();

    expect(view.landedOn()).toBe("/logs/conflux?tab=rooms");
  });

  it("honours a caller-supplied fallback over the default", () => {
    const view = renderBackTo(undefined, "/logs/conflux");

    view.goBack();

    expect(view.landedOn()).toBe("/logs/conflux");
  });

  it("prefers the link's destination over the fallback", () => {
    const view = renderBackTo({ backTo: "/logs/toolbox/audit" }, "/logs/conflux");

    view.goBack();

    expect(view.landedOn()).toBe("/logs/toolbox/audit");
  });

  it.each([
    ["a non-string destination", { backTo: 42 }],
    ["an empty destination", { backTo: "" }],
    ["a relative destination", { backTo: "logs/conflux" }],
    ["state that is not an object", "/logs/conflux"],
  ])("falls back on %s", (_label, state) => {
    // Route state is ours, but it outlives the code that wrote it. A value that
    // is not an absolute in-app path should land the reader somewhere real
    // rather than navigate somewhere strange.
    const view = renderBackTo(state);

    view.goBack();

    expect(view.landedOn()).toBe("/logs");
  });
});
