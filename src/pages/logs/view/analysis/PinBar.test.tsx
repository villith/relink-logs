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
  sources: [{ value: "0", label: "Narmaya" }],
  targets: [{ value: "1", label: "Vulkan Bolla Nihilla" }],
  abilities: [{ value: "Normal:100", label: "Dawnfly Stance" }],
};

const NO_PINS = { source: null, targetIds: [], ability: null };

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
    expect(screen.getByPlaceholderText("ui.logs.selector-all-friendlies")).toBeTruthy();
    expect(screen.getByPlaceholderText("ui.logs.selector-all-enemies")).toBeTruthy();
    expect(screen.getByPlaceholderText("ui.logs.selector-all-abilities")).toBeTruthy();
  });

  it("does not label the selectors — the placeholder already names them", () => {
    renderIt();
    expect(screen.queryByText("ui.logs.selector-source")).toBeNull();
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
});
