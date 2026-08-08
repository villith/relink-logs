import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ToggleSwitch } from "./ToggleSwitch";

const renderIt = (props: Partial<React.ComponentProps<typeof ToggleSwitch>> = {}) =>
  render(
    <MantineProvider>
      <ToggleSwitch checked={false} onChange={() => {}} label="Collapse supplementary" {...props} />
    </MantineProvider>
  );

describe("ToggleSwitch", () => {
  it("reports the flipped value when clicked", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("flips back off", () => {
    const onChange = vi.fn();
    renderIt({ onChange, checked: true });
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("announces its state", () => {
    renderIt({ checked: true });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  /** The border must not move with the state.
   *
   * An accent border on the checked switch read as an outline — the same thing
   * a focus ring and a selected `PillGroup` pill are drawn with — so a switch
   * that was merely ON looked like the control the keyboard was sitting on, or
   * like a selected item in the strip beside it. The knob's travel, the track's
   * colour and the pill's fill already say ON three times over; the frame stays
   * out of it. */
  it("keeps the same border in both states", () => {
    const { container: off } = renderIt({ checked: false });
    const { container: on } = renderIt({ checked: true });

    const borderOf = (root: HTMLElement) =>
      [...root.querySelector<HTMLElement>('[role="switch"]')!.classList].filter((name) => name.startsWith("border-"));

    expect(borderOf(on)).toEqual(borderOf(off));
  });

  it("stays on screen but inert when disabled", () => {
    // `aria-disabled` and not the native attribute: a truly disabled control
    // receives no pointer events, hover included, which would silence the
    // tooltip explaining the disabling — so the guard lives in the handler.
    const onChange = vi.fn();
    renderIt({ onChange, disabled: true });
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
