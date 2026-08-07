import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PinBar } from "./PinBar";

// `window-within` interpolates the full-fight duration, so the stub has to
// render options rather than only the key — otherwise the assertion below would
// pass against markup that drops the duration entirely.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.total === undefined ? key : `${key} ${options.total}`,
  }),
}));

const OPTIONS = {
  targets: [{ value: "1", label: "Vulkan Bolla Nihilla" }],
  abilities: [{ value: "Normal:100", label: "Dawnfly Stance" }],
};

const NO_PINS = { source: null, targets: [], ability: null };

const renderIt = (props: Partial<React.ComponentProps<typeof PinBar>> = {}) =>
  render(
    <MantineProvider>
      <PinBar
        options={OPTIONS}
        pins={NO_PINS}
        onChange={() => {}}
        windowLabel={null}
        fullLabel="04:12"
        onClearWindow={() => {}}
        {...props}
      />
    </MantineProvider>
  );

describe("PinBar", () => {
  it("shows each dimension's placeholder when nothing is pinned", () => {
    renderIt();
    expect(screen.getByPlaceholderText("ui.logs.selector-all-enemies")).toBeTruthy();
    expect(screen.getByPlaceholderText("ui.logs.selector-all-abilities")).toBeTruthy();
  });

  // It moved to the topmost row, with the view switch — see ActorBar. Asserted
  // here so the two bars cannot both grow one.
  it("does not carry the actor pin", () => {
    renderIt();
    expect(screen.queryByPlaceholderText("ui.logs.selector-all-friendlies")).toBeNull();
  });

  it("does not label the selectors — the placeholder already names them", () => {
    renderIt();
    expect(screen.queryByText("ui.logs.selector-target")).toBeNull();
    expect(screen.queryByText("ui.logs.selector-ability")).toBeNull();
  });

  it("hides the window chip for the full fight", () => {
    renderIt();
    expect(screen.queryByLabelText("ui.logs.window-reset")).toBeNull();
  });

  it("locates a scoped window within the whole fight", () => {
    renderIt({ windowLabel: "01:12 – 01:48" });
    expect(screen.getByText("01:12 – 01:48")).toBeTruthy();
    expect(screen.getByText("ui.logs.window-within 04:12")).toBeTruthy();
  });

  it("clears the window", () => {
    const onClearWindow = vi.fn();
    renderIt({ windowLabel: "01:12 – 01:48", onClearWindow });
    fireEvent.click(screen.getByLabelText("ui.logs.window-reset"));
    expect(onClearWindow).toHaveBeenCalled();
  });

  it("pins ONE target — the machine's target axis is single, like WCL's", () => {
    const onChange = vi.fn();
    renderIt({ onChange });

    const target = screen.getByPlaceholderText("ui.logs.selector-all-enemies");
    fireEvent.click(target);
    fireEvent.click(screen.getByText("Vulkan Bolla Nihilla"));

    expect(onChange).toHaveBeenCalledWith({ source: null, targets: [1], ability: null });
  });
});
