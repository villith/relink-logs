import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChipStrip, type StripChip } from "./ChipStrip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The parts the two strips do NOT share are what this covers — the figure and
// the accessible name. The shared select/clear interaction is pinned here and
// again through AuraStrip's own suite, which exercises it via the adapter.
const CHIPS: StripChip[] = [
  { value: "sba", label: "SBA windows (2)", selected: false, figure: null },
  { value: "sba:0", label: "10-20", selected: false, figure: "22s", ariaLabel: "SBA windows 10-20" },
];

const renderIt = (props: Partial<React.ComponentProps<typeof ChipStrip>> = {}) =>
  render(
    <MantineProvider>
      <ChipStrip
        titleKey="ui.logs.window-strip-title"
        chips={CHIPS}
        onSelect={() => {}}
        onClear={() => {}}
        {...props}
      />
    </MantineProvider>
  );

describe("ChipStrip", () => {
  it("renders nothing with no chips", () => {
    // MantineProvider injects its own <style> tag into the container, so the
    // assertion is about the strip's own markup — its title and its chips.
    const { container } = renderIt({ chips: [] });
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryByText("ui.logs.window-strip-title")).toBeNull();
  });

  it("draws a figure only where the chip has one", () => {
    // A kind chip's count already lives in its label, so a null figure must
    // draw no element at all rather than an empty one.
    const { container } = renderIt();
    const figures = container.querySelectorAll("[data-chip-figure]");
    expect(figures).toHaveLength(1);
    expect(figures[0].textContent).toBe("22s");
  });

  it("draws a zero figure rather than treating it as absent", () => {
    // "0%" is a real reading — an effect the pin never had up inside the
    // window. Only null means "this chip has no figure".
    const { container } = renderIt({ chips: [{ ...CHIPS[0], figure: "0%" }] });
    expect(container.querySelector("[data-chip-figure]")?.textContent).toBe("0%");
  });

  it("overrides the accessible name only where the chip asks", () => {
    renderIt();
    expect(screen.getByLabelText("SBA windows 10-20")).toBeTruthy();
    // The kind chip supplies none, so its accessible name stays its label.
    expect(screen.getByRole("button", { name: "SBA windows (2)" })).toBeTruthy();
  });

  it("renders the leading node ahead of the label", () => {
    const { container } = renderIt({
      chips: [{ ...CHIPS[0], leading: <span className="swatch" /> }],
    });
    expect(container.querySelector("button > .swatch")).toBeTruthy();
  });

  it("selects an unselected chip and clears a selected one", () => {
    const onSelect = vi.fn();
    const onClear = vi.fn();
    renderIt({ chips: [{ ...CHIPS[0], selected: true }, CHIPS[1]], onSelect, onClear });

    // Clicking the SELECTED chip clears rather than reselecting — a filter must
    // never need a trip elsewhere to undo.
    fireEvent.click(screen.getByText("SBA windows (2)"));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("10-20"));
    expect(onSelect).toHaveBeenCalledWith("sba:0");
  });

  it("shows the ✕ only on the selected chip", () => {
    renderIt({ chips: [{ ...CHIPS[0], selected: true }, CHIPS[1]] });
    expect(screen.getAllByLabelText("ui.logs.aura-clear")).toHaveLength(1);
  });

  it("marks the selected chip pressed for assistive tech", () => {
    renderIt({ chips: [{ ...CHIPS[0], selected: true }, CHIPS[1]] });
    expect(screen.getByRole("button", { name: "SBA windows (2)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("SBA windows 10-20").getAttribute("aria-pressed")).toBe("false");
  });
});
