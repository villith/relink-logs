import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuraStrip } from "./AuraStrip";

// The usual key-echoing mock, plus the interpolated values appended: the
// uptime the card states only exists as a parameter, so a `t` that dropped
// params would make the figure untestable.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${Object.values(params).join(" ")}`,
  }),
}));

const CHIPS = [
  {
    aura: "src:status:10:500",
    label: "Attack Up (Signo Drive)",
    uptimePercent: 80,
    selected: false,
    iconUrl: "/status/1010.png",
  },
  { aura: "src:status:20:600", label: "Veil (Panacea)", uptimePercent: 12, selected: false },
];

const renderIt = (props: Partial<React.ComponentProps<typeof AuraStrip>> = {}) =>
  render(
    <MantineProvider>
      <AuraStrip titleKey="ui.logs.aura-source-title" chips={CHIPS} onSelect={() => {}} onClear={() => {}} {...props} />
    </MantineProvider>
  );

describe("AuraStrip", () => {
  it("renders nothing with no chips", () => {
    // Not `container.innerHTML === ""`, and not `firstElementChild`:
    // MantineProvider injects its own <style> tag, so the assertion is about
    // the strip's own markup — its title and its tiles.
    const { container } = renderIt({ chips: [] });
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryByText("ui.logs.aura-source-title")).toBeNull();
  });

  it("titles the strip but writes nothing on the chips themselves", () => {
    // A fight holds dozens of effects, and named in full they wrapped the
    // strip several rows deep between the chart and the table. The art is the
    // identity, exactly as Warcraft Logs' own Auras Filter draws it.
    renderIt();

    expect(screen.getByText("ui.logs.aura-source-title")).toBeTruthy();
    expect(screen.queryByText("Attack Up (Signo Drive)")).toBeNull();
    expect(screen.queryByText("80%")).toBeNull();
  });

  it("wears the effect's icon where one resolves", () => {
    // The same art the effects table shows beside the same name — a chip is
    // that row's filter form.
    const { container } = renderIt();
    const icon = container.querySelector("button img");

    expect(icon?.getAttribute("src")).toBe("/status/1010.png");
    expect(icon?.getAttribute("alt")).toBe("");
  });

  it("gives an art-less effect a placeholder tile of the same size", () => {
    // ~90 internal effects ship no art. Dropping them would drop the ability
    // to filter by them; letting them collapse would break the strip's rhythm.
    const { container } = renderIt();

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(container.querySelectorAll("button img")).toHaveLength(1);
    expect(container.querySelectorAll("[data-tile-blank]")).toHaveLength(1);
  });

  it("names each chip for assistive tech, since nothing is written on it", () => {
    renderIt();

    expect(screen.getByLabelText("Attack Up (Signo Drive)")).toBeTruthy();
    expect(screen.getByLabelText("Veil (Panacea)")).toBeTruthy();
  });

  it("names the effect and its uptime in a hover card", () => {
    renderIt();
    fireEvent.mouseEnter(screen.getByLabelText("Attack Up (Signo Drive)"));

    const card = document.querySelector('[data-testid="aura-hover-card"]');
    expect(card?.textContent).toContain("Attack Up (Signo Drive)");
    expect(card?.textContent).toContain("ui.logs.aura-uptime 80");
  });

  it("opens no card until a chip is hovered, and closes it again on leave", () => {
    renderIt();
    expect(document.querySelector('[data-testid="aura-hover-card"]')).toBeNull();

    const chip = screen.getByLabelText("Veil (Panacea)");
    fireEvent.mouseEnter(chip);
    expect(document.querySelector('[data-testid="aura-hover-card"]')).toBeTruthy();

    fireEvent.mouseLeave(chip);
    expect(document.querySelector('[data-testid="aura-hover-card"]')).toBeNull();
  });

  it("selects a chip on click", () => {
    const onSelect = vi.fn();
    renderIt({ onSelect });
    fireEvent.click(screen.getByLabelText("Attack Up (Signo Drive)"));

    expect(onSelect).toHaveBeenCalledWith("src:status:10:500");
  });

  it("clicking an already-selected chip clears it (toggle)", () => {
    // The chip IS the clear affordance now that it carries no ✕: a live
    // filter stays dismissible where it was set, without a second control
    // that would make the selected tile wider than its neighbours.
    const onClear = vi.fn();
    const onSelect = vi.fn();
    renderIt({ chips: [{ ...CHIPS[0], selected: true }], onClear, onSelect });
    fireEvent.click(screen.getByLabelText("Attack Up (Signo Drive)"));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the selected chip, and only it", () => {
    const { container } = renderIt({ chips: [{ ...CHIPS[0], selected: true }, CHIPS[1]] });

    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(screen.getByLabelText("Attack Up (Signo Drive)").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Veil (Panacea)").getAttribute("aria-pressed")).toBe("false");
  });
});
