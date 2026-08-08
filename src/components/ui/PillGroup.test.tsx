import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PillGroup } from "./PillGroup";

const OPTIONS = [
  { value: "off", label: "Off" },
  { value: "5", label: "5s" },
  { value: "10", label: "10s" },
];

const renderIt = (props: Partial<React.ComponentProps<typeof PillGroup<string>>> = {}) =>
  render(
    <MantineProvider>
      <PillGroup options={OPTIONS} value="off" onChange={() => {}} ariaLabel="Smoothing" {...props} />
    </MantineProvider>
  );

describe("PillGroup", () => {
  it("offers every option and marks the chosen one", () => {
    renderIt({ value: "5" });
    expect(screen.getByRole("radio", { name: "5s" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Off" }).getAttribute("aria-checked")).toBe("false");
  });

  it("reports a click", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.click(screen.getByRole("radio", { name: "10s" }));
    expect(onChange).toHaveBeenCalledWith("10");
  });

  it("only tabs to the chosen option — the roving tabindex", () => {
    renderIt({ value: "5" });
    expect(screen.getByRole("radio", { name: "5s" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Off" }).getAttribute("tabindex")).toBe("-1");
  });

  it("steps the selection with the arrow keys, and wraps", () => {
    const onChange = vi.fn();
    renderIt({ onChange, value: "10" });
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("off");

    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("5");
  });

  it("names itself in the UI as well as to a screen reader when captioned", () => {
    // The whole point of the caption: "Off 5s 10s" names three durations and no
    // question, so without it the control cannot be identified by looking at it.
    renderIt({ caption: "Smoothing" });
    expect(screen.getByText("Smoothing")).toBeTruthy();
    expect(screen.getByRole("radiogroup").getAttribute("aria-label")).toBe("Smoothing");
  });

  describe("disabled", () => {
    it("still shows the options and which is chosen", () => {
      renderIt({ disabled: true, value: "5" });
      expect(screen.getByRole("radiogroup").getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("radio", { name: "5s" }).getAttribute("aria-checked")).toBe("true");
    });

    it("ignores a click and the arrow keys", () => {
      const onChange = vi.fn();
      renderIt({ onChange, disabled: true });
      fireEvent.click(screen.getByRole("radio", { name: "10s" }));
      fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
      expect(onChange).not.toHaveBeenCalled();
    });

    it("leaves the tab order entirely", () => {
      renderIt({ disabled: true });
      for (const name of ["Off", "5s", "10s"]) {
        expect(screen.getByRole("radio", { name }).getAttribute("tabindex")).toBe("-1");
      }
    });
  });
});
