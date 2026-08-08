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
