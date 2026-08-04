import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HostilityToggle } from "./HostilityToggle";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const renderIt = (props: Partial<React.ComponentProps<typeof HostilityToggle>> = {}) =>
  render(
    <MantineProvider>
      <HostilityToggle value="friendly" onChange={() => {}} {...props} />
    </MantineProvider>
  );

describe("HostilityToggle", () => {
  it("offers both sides and marks the active one", () => {
    renderIt();
    const active = screen.getByRole("radio", { name: "ui.logs.hostility-friendlies" });
    expect(active.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "ui.logs.hostility-enemies" }).getAttribute("aria-checked")).toBe("false");
  });

  it("reports a side click", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.click(screen.getByRole("radio", { name: "ui.logs.hostility-enemies" }));
    expect(onChange).toHaveBeenCalledWith("enemy");
  });

  it("only tabs to the checked option — the roving tabindex", () => {
    renderIt();
    expect(screen.getByRole("radio", { name: "ui.logs.hostility-friendlies" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "ui.logs.hostility-enemies" }).getAttribute("tabindex")).toBe("-1");
  });

  it("moves the selection with the arrow keys", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("enemy");
  });

  describe("disabled", () => {
    // The switch keeps its place on the tabs that cannot use it, so every one
    // of its ways in has to be closed — a dimmed control that still reports a
    // change is the same defect as an undimmed one.
    it("still shows both sides and which is active", () => {
      renderIt({ disabled: true });
      expect(screen.getByRole("radio", { name: "ui.logs.hostility-friendlies" }).getAttribute("aria-checked")).toBe(
        "true"
      );
      expect(screen.getByRole("radiogroup").getAttribute("aria-disabled")).toBe("true");
    });

    it("ignores a click", () => {
      const onChange = vi.fn();
      renderIt({ onChange, disabled: true });
      fireEvent.click(screen.getByRole("radio", { name: "ui.logs.hostility-enemies" }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it("ignores the arrow keys", () => {
      const onChange = vi.fn();
      renderIt({ onChange, disabled: true });
      fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
      expect(onChange).not.toHaveBeenCalled();
    });

    it("leaves the tab order", () => {
      renderIt({ disabled: true });
      for (const name of ["ui.logs.hostility-friendlies", "ui.logs.hostility-enemies"]) {
        expect(screen.getByRole("radio", { name }).getAttribute("tabindex")).toBe("-1");
      }
    });
  });
});
