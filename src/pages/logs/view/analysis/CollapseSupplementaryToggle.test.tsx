import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CollapseSupplementaryToggle } from "./CollapseSupplementaryToggle";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const renderIt = (props: Partial<React.ComponentProps<typeof CollapseSupplementaryToggle>> = {}) =>
  render(
    <MantineProvider>
      <CollapseSupplementaryToggle value={false} onChange={() => {}} {...props} />
    </MantineProvider>
  );

describe("CollapseSupplementaryToggle", () => {
  /** The control sits in the chart's header row beside the smoothing window,
   * where the space is a strip rather than a line of prose — so the label is
   * the short form and the tooltip carries the sentence. */
  it("labels itself in the chart header's short form", () => {
    renderIt();
    expect(screen.getByText("ui.logs.merge-supplementary")).toBeTruthy();
  });

  it("reports the flipped value when clicked", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("stays on screen but inert when disabled", () => {
    // The same rule `HostilityToggle` follows: the control keeps its place on a
    // tab that cannot use it, so every way in has to be closed.
    //
    // `aria-disabled` and not the native attribute, deliberately: a truly
    // disabled control receives no pointer events, which would silence the
    // tooltip explaining why it is disabled — the only reason it is still on
    // screen. So the guard has to be in the handler, and this asserts it is.
    const onChange = vi.fn();
    renderIt({ onChange, disabled: true });
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
