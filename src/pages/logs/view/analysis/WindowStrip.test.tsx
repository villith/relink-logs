import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WindowStrip } from "./WindowStrip";
import type { WindowChipGroup } from "./windowChips";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${Object.values(params).join(" ")}`,
  }),
}));

const group = (over: Partial<WindowChipGroup> = {}): WindowChipGroup => ({
  kind: "sba",
  kindLabel: "SBA windows",
  allValue: "sba",
  allSelected: false,
  items: [
    { value: "sba:0", label: "0:12-0:34", durationLabel: "22s", selected: false },
    { value: "sba:1", label: "1:05-1:27", durationLabel: "22s", selected: false },
  ],
  selectedCount: 0,
  active: false,
  figure: "×2",
  ...over,
});

const renderIt = (props: Partial<React.ComponentProps<typeof WindowStrip>> = {}) =>
  render(
    <MantineProvider>
      <WindowStrip groups={[group()]} onToggleWindow={() => {}} onToggleKind={() => {}} onClear={() => {}} {...props} />
    </MantineProvider>
  );

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /window-chip-menu-label/ }));

describe("WindowStrip", () => {
  it("renders nothing with no groups", () => {
    const { container } = renderIt({ groups: [] });
    expect(container.querySelector("button")).toBeNull();
  });

  it("draws ONE chip per kind rather than a chip per window", () => {
    // The flat strip wrapped several rows deep between the chart and the table
    // on a long fight; the kinds are the level a reader chooses at.
    renderIt({ groups: [group(), group({ kind: "break", kindLabel: "Break", allValue: "break", figure: "×1" })] });

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("SBA windows")).toBeTruthy();
    expect(screen.getByText("Break")).toBeTruthy();
    // The individual windows are behind the chip, not beside it.
    expect(screen.queryByText("0:12-0:34")).toBeNull();
  });

  it("opens a menu listing the kind's windows, the 'all' row first", () => {
    renderIt();
    openMenu();

    expect(screen.getByText("ui.logs.window-menu-all SBA windows")).toBeTruthy();
    expect(screen.getByText("0:12-0:34")).toBeTruthy();
    expect(screen.getByText("1:05-1:27")).toBeTruthy();
  });

  it("reports the window a menu row names", () => {
    const onToggleWindow = vi.fn();
    renderIt({ onToggleWindow });
    openMenu();
    fireEvent.click(screen.getByText("1:05-1:27"));

    expect(onToggleWindow).toHaveBeenCalledWith("sba:1");
  });

  it("reports the KIND from the 'all' row", () => {
    const onToggleKind = vi.fn();
    renderIt({ onToggleKind });
    openMenu();
    fireEvent.click(screen.getByText("ui.logs.window-menu-all SBA windows"));

    expect(onToggleKind).toHaveBeenCalledWith("sba");
  });

  it("stays open across clicks — every row is a checkbox", () => {
    // A menu that shut on the first tick would make picking three windows
    // three trips through the chip.
    const onToggleWindow = vi.fn();
    renderIt({ onToggleWindow });
    openMenu();
    fireEvent.click(screen.getByText("0:12-0:34"));
    fireEvent.click(screen.getByText("1:05-1:27"));

    expect(onToggleWindow).toHaveBeenCalledTimes(2);
  });

  it("carries ONE clear for the whole strip, only while something is selected", () => {
    expect(screen.queryByLabelText("ui.logs.window-clear")).toBeNull();

    const onClear = vi.fn();
    renderIt({ groups: [group({ active: true, selectedCount: 1, figure: "1/2" }), group({ kind: "break" })], onClear });
    const clear = screen.getAllByLabelText("ui.logs.window-clear");
    expect(clear).toHaveLength(1);

    fireEvent.click(clear[0]);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows the chip's figure — the total at rest, the count while partial", () => {
    renderIt({ groups: [group({ figure: "1/2", active: true, selectedCount: 1 })] });
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
