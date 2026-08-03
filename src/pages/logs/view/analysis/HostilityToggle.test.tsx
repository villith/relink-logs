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
});
