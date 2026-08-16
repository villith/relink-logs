import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./Button";

const renderIt = (props: Partial<React.ComponentProps<typeof Button>> = {}) =>
  render(
    <MantineProvider>
      <Button onClick={() => {}} {...props}>
        Compare
      </Button>
    </MantineProvider>
  );

const button = () => screen.getByRole("button", { name: "Compare" });

describe("Button", () => {
  it("reports a click", () => {
    const onClick = vi.fn();
    renderIt({ onClick });
    fireEvent.click(button());
    expect(onClick).toHaveBeenCalled();
  });

  // Inside a form a bare <button> submits it.
  it("never submits a form", () => {
    renderIt();
    expect(button().getAttribute("type")).toBe("button");
  });

  // Dimming is a look, not a lock: a disabled control that still reports a
  // click is the same defect as an undimmed one.
  it("does not report a click while disabled", () => {
    const onClick = vi.fn();
    renderIt({ onClick, disabled: true });
    fireEvent.click(button());
    expect(onClick).not.toHaveBeenCalled();
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().getAttribute("tabindex")).toBe("-1");
  });

  // The native attribute would drop pointer events, and with them the hover
  // that shows the tooltip explaining the disabling.
  it("stays hoverable while disabled", () => {
    renderIt({ disabled: true, title: "Only on Damage Done" });
    expect(button().hasAttribute("disabled")).toBe(false);
    expect(button().getAttribute("title")).toBe("Only on Damage Done");
  });

  it("marks the live button with the accent", () => {
    renderIt({ active: true });
    expect(button().className).toContain("border-accent");
  });

  it("names an icon button, which draws no text of its own", () => {
    render(
      <MantineProvider>
        <Button variant="icon" aria-label="Clear window" onClick={() => {}}>
          <svg />
        </Button>
      </MantineProvider>
    );
    expect(screen.getByRole("button", { name: "Clear window" })).toBeTruthy();
  });

  // `cn` is tailwind-merge, so a caller's utility replaces the variant's rather
  // than racing it in the cascade.
  it("lets a caller override a variant utility", () => {
    renderIt({ variant: "subtle", className: "text-xs" });
    expect(button().className).toContain("text-xs");
    expect(button().className).not.toContain("text-sm");
  });
});
