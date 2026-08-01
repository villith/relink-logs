import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SelectorBar } from "./SelectorBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const OPTIONS = {
  sources: [{ value: "1", label: "Narmaya" }],
  targets: [{ value: "9", label: "Lucilius" }],
  abilities: [{ value: "Normal:100", label: "Genji Just Attack" }],
};

const NO_PINS = { source: null, targetIds: [], ability: null };

const renderBar = (props: Partial<React.ComponentProps<typeof SelectorBar>> = {}) =>
  render(
    <MantineProvider>
      <SelectorBar
        options={OPTIONS}
        pins={NO_PINS}
        onChange={() => {}}
        windowLabel={null}
        onClearWindow={() => {}}
        {...props}
      />
    </MantineProvider>
  );

describe("SelectorBar", () => {
  it("labels all three selectors", () => {
    renderBar();
    expect(screen.getByText("ui.logs.selector-source")).toBeTruthy();
    expect(screen.getByText("ui.logs.selector-target")).toBeTruthy();
    expect(screen.getByText("ui.logs.selector-ability")).toBeTruthy();
  });

  it("hides the window readout when the full fight is shown", () => {
    renderBar({ windowLabel: null });
    expect(screen.queryByText("ui.logs.window-reset")).toBeNull();
  });

  it("shows the window readout and a clear action when scrubbed", () => {
    // The window is a readout with a clear, never a dropdown.
    renderBar({ windowLabel: "0:32 – 0:47" });
    expect(screen.getByText("0:32 – 0:47")).toBeTruthy();
    expect(screen.getByLabelText("ui.logs.window-reset")).toBeTruthy();
  });

  it("clears the window when the clear action is used", () => {
    const onClearWindow = vi.fn();
    renderBar({ windowLabel: "0:32 – 0:47", onClearWindow });
    screen.getByLabelText("ui.logs.window-reset").click();
    expect(onClearWindow).toHaveBeenCalledOnce();
  });
});
