import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RegroupTab } from "./machine/resolve";
import { RegroupStrip } from "./RegroupStrip";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const TABS: RegroupTab[] = [
  { dim: "source", labelKey: "ui.logs.groupby-damage-source", active: true },
  { dim: "ability", labelKey: "ui.logs.groupby-damage-ability", active: false },
  {
    dim: "target",
    labelKey: "ui.logs.groupby-generic-target",
    active: false,
    disabledReason: "ui.logs.stun-no-target-dimension",
  },
];

const renderIt = (props: Partial<React.ComponentProps<typeof RegroupStrip>> = {}) =>
  render(
    <MantineProvider>
      <RegroupStrip tabs={TABS} onRegroup={() => {}} {...props} />
    </MantineProvider>
  );

describe("RegroupStrip", () => {
  it("renders one control per tabs entry, every one of them labelled", () => {
    renderIt();
    expect(screen.getByRole("tab", { name: "ui.logs.groupby-damage-source" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "ui.logs.groupby-damage-ability" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "ui.logs.groupby-generic-target" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("marks the active tab as selected", () => {
    renderIt();
    expect(screen.getByRole("tab", { name: "ui.logs.groupby-damage-source" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(screen.getByRole("tab", { name: "ui.logs.groupby-damage-ability" }).getAttribute("aria-selected")).toBe(
      "false"
    );
  });

  it("regroups on an enabled inactive tab, and no-ops on the active one", () => {
    const onRegroup = vi.fn();
    renderIt({ onRegroup });

    fireEvent.click(screen.getByRole("tab", { name: "ui.logs.groupby-damage-ability" }));
    expect(onRegroup).toHaveBeenCalledTimes(1);
    expect(onRegroup).toHaveBeenCalledWith("ability");

    fireEvent.click(screen.getByRole("tab", { name: "ui.logs.groupby-damage-source" }));
    expect(onRegroup).toHaveBeenCalledTimes(1);
  });

  it("disables an unsupported dimension with its reason in a tooltip, and no-ops on click", async () => {
    const onRegroup = vi.fn();
    renderIt({ onRegroup });

    const disabledTab = screen.getByRole("tab", { name: "ui.logs.groupby-generic-target" });
    expect(disabledTab.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(disabledTab);
    expect(onRegroup).not.toHaveBeenCalled();

    // aria-disabled, not the native `disabled` attribute — a truly disabled
    // control drops pointer events in real browsers, which would silence the
    // hover that is supposed to explain the disabling.
    expect(disabledTab.hasAttribute("disabled")).toBe(false);

    fireEvent.mouseEnter(disabledTab);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("ui.logs.stun-no-target-dimension");
  });

  it("roves focus with the arrow keys, skipping a disabled tab, and wraps", () => {
    const tabs: RegroupTab[] = [
      { dim: "source", labelKey: "ui.logs.groupby-damage-source", active: true },
      {
        dim: "ability",
        labelKey: "ui.logs.groupby-generic-ability",
        active: false,
        disabledReason: "ui.logs.sba-no-breakdown",
      },
      { dim: "target", labelKey: "ui.logs.groupby-damage-target", active: false },
    ];
    const onRegroup = vi.fn();
    renderIt({ tabs, onRegroup });

    const [first, , third] = screen.getAllByRole("tab");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(third);
    expect(onRegroup).toHaveBeenCalledTimes(1);
    expect(onRegroup).toHaveBeenCalledWith("target");

    // Wraps past the disabled ability tab back onto the already-active
    // source tab — focus follows, but the active no-op guard still holds.
    fireEvent.keyDown(third, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    expect(onRegroup).toHaveBeenCalledTimes(1);
  });
});
