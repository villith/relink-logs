import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChecklistSection } from "./Settings";
import type useChecklistSettings from "./useChecklistSettings";

// Explicit even though vitest's `globals: true` config restores
// testing-library's auto-cleanup — keeps this file safe on its own.
afterEach(cleanup);

// jsdom is missing these browser APIs; Mantine's components probe them.
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);

  window.ResizeObserver =
    window.ResizeObserver ||
    class implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

type Entry = { ids: number[]; level: number; enabled: boolean };

const FIXED_OPTIONS = [
  { value: "00000001", label: "Alpha Trait" },
  { value: "00000002", label: "Beta Trait" },
];

/** Stateful harness whose `checklist` stub mimics useChecklistSettings()'s shape/behavior. */
const Harness = ({ group }: { group: ChecklistGroup }) => {
  const [entries, setEntries] = useState<Entry[]>([]);

  const checklist = {
    build: entries,
    ai: entries,
    toggle: () => {},
    remove: () => {},
    reset: () => {},
    traitOptions: () => FIXED_OPTIONS.filter((option) => !entries.some((entry) => entry.ids[0] === parseInt(option.value, 16))),
    addTrait: (_group: ChecklistGroup, hex: string | null) => {
      if (!hex) return;
      setEntries((prev) => [...prev, { ids: [parseInt(hex, 16)], level: 15, enabled: true }]);
    },
    setEntryLevel: () => {},
  } as unknown as ReturnType<typeof useChecklistSettings>;

  return (
    <MantineProvider>
      <ChecklistSection group={group} legend="Sigils checklist" addPlaceholder="Add trait..." checklist={checklist} />
    </MantineProvider>
  );
};

describe("ChecklistSection add-trait search", () => {
  it("clears the search input after picking a trait", () => {
    render(<Harness group="build" />);

    const input = screen.getByPlaceholderText("Add trait...") as HTMLInputElement;
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "Alpha" } });

    const option = screen.getByText("Alpha Trait");
    fireEvent.click(option);

    // Picking an entry changes `entries.length`, which remounts the Select
    // (fresh DOM node) — re-query rather than reuse the stale `input` ref.
    const inputAfterPick = screen.getByPlaceholderText("Add trait...") as HTMLInputElement;

    // The regression assertion: the search text must not retain the picked label.
    expect(inputAfterPick.value).toBe("");

    // Reopen: the remaining list should offer Beta Trait but not the now-present Alpha Trait.
    fireEvent.click(inputAfterPick);
    expect(screen.getByText("Beta Trait")).toBeTruthy();
    expect(screen.queryByText("Alpha Trait")).toBeNull();
  });
});
