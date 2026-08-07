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
  it("reports the flipped value when clicked", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("stays on screen but inert when disabled", () => {
    // The same rule `HostilityToggle` follows: the control keeps its place on a
    // tab that cannot use it, so every way in has to be closed.
    const onChange = vi.fn();
    renderIt({ onChange, disabled: true });
    const control = screen.getByRole("switch") as HTMLInputElement;
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
