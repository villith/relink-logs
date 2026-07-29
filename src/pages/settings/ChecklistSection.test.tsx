import type useChecklistSettings from "@/pages/useChecklistSettings";
import type { ChecklistGroup } from "@/stores/useChecklistStore";
import { DragDropContext } from "@hello-pangea/dnd";
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ChecklistSection } from "./ChecklistSection";

type Entry = { ids: number[]; level: number; enabled: boolean };

const FIXED_OPTIONS = [
  { value: "00000001", label: "Alpha Trait" },
  { value: "00000002", label: "Beta Trait" },
];

/** Stateful harness whose `checklist` stub mimics useChecklistSettings()'s shape/behavior. */
const Harness = ({ kind = "custom" as ChecklistGroup["kind"] }) => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const group: ChecklistGroup = {
    id: "build",
    name: "Sigils",
    kind,
    enabled: true,
    manualOrder: true,
    entries,
  };

  const checklist = {
    groups: [group],
    traitOptions: () =>
      FIXED_OPTIONS.filter((option) => !entries.some((entry) => entry.ids[0] === parseInt(option.value, 16))),
    addTrait: (_groupId: string, hex: string | null) => {
      if (!hex) return;
      setEntries((prev) => [...prev, { ids: [parseInt(hex, 16)], level: 15, enabled: true }]);
    },
    toggle: () => {},
    remove: () => {},
    setEntryLevel: () => {},
  } as unknown as ReturnType<typeof useChecklistSettings>;

  return (
    <MantineProvider>
      <DragDropContext onDragEnd={() => {}}>
        <ChecklistSection group={group} addPlaceholder="Add trait..." checklist={checklist} />
      </DragDropContext>
    </MantineProvider>
  );
};

describe("ChecklistSection add-trait search", () => {
  it("clears the search input after picking a trait", () => {
    render(<Harness />);

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

describe("ChecklistSection computed variant", () => {
  it("renders the three derived rows and no trait picker", () => {
    render(<Harness kind="computed" />);
    expect(screen.queryByPlaceholderText("Add trait...")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
