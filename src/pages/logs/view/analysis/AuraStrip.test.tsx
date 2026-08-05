import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuraStrip } from "./AuraStrip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CHIPS = [
  { aura: "src:status:10:500", label: "Attack Up (Signo Drive)", uptimePercent: 80, selected: false },
  { aura: "src:status:20:600", label: "Veil (Panacea)", uptimePercent: 12, selected: false },
];

const renderIt = (props: Partial<React.ComponentProps<typeof AuraStrip>> = {}) =>
  render(
    <MantineProvider>
      <AuraStrip titleKey="ui.logs.aura-source-title" chips={CHIPS} onSelect={() => {}} onClear={() => {}} {...props} />
    </MantineProvider>
  );

describe("AuraStrip", () => {
  it("renders nothing with no chips", () => {
    // Not `container.innerHTML === ""`: MantineProvider injects its own
    // <style> tag, so the assertion is about the strip's own markup.
    const { container } = renderIt({ chips: [] });
    expect(container.querySelector(".analysis-aura-strip")).toBeNull();
    expect(screen.queryByText("ui.logs.aura-source-title")).toBeNull();
  });

  it("titles the strip and names every chip with its uptime", () => {
    renderIt();
    expect(screen.getByText("ui.logs.aura-source-title")).toBeTruthy();
    expect(screen.getByText("Attack Up (Signo Drive)")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("12%")).toBeTruthy();
  });

  it("selects a chip on click", () => {
    const onSelect = vi.fn();
    renderIt({ onSelect });
    fireEvent.click(screen.getByText("Attack Up (Signo Drive)"));
    expect(onSelect).toHaveBeenCalledWith("src:status:10:500");
  });

  it("shows the ✕ only on the selected chip, and it clears", () => {
    const onClear = vi.fn();
    renderIt({ chips: [{ ...CHIPS[0], selected: true }, CHIPS[1]], onClear });
    const clear = screen.getByLabelText("ui.logs.aura-clear");
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getAllByLabelText("ui.logs.aura-clear")).toHaveLength(1);
  });

  it("clicking an already-selected chip clears it (toggle)", () => {
    const onClear = vi.fn();
    const onSelect = vi.fn();
    renderIt({ chips: [{ ...CHIPS[0], selected: true }], onClear, onSelect });
    fireEvent.click(screen.getByText("Attack Up (Signo Drive)"));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
