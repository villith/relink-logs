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
      <AuraStrip
        titleKey="ui.logs.aura-source-title"
        chips={CHIPS}
        onToggle={() => {}}
        stacked={false}
        stackPercent={null}
        {...props}
      />
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
    const onToggle = vi.fn();
    renderIt({ onToggle });
    fireEvent.click(screen.getByLabelText("Attack Up (Signo Drive)"));

    expect(onToggle).toHaveBeenCalledWith("src:status:10:500");
  });

  it("clicking an already-selected chip reports ITSELF, not a clear-all", () => {
    // The chip IS the clear affordance for its own effect: with several
    // selected, deselecting one has to leave the rest standing, so the strip
    // reports the tile and the state machine decides it was a deselect.
    const onToggle = vi.fn();
    renderIt({ chips: [{ ...CHIPS[0], selected: true }, CHIPS[1]], onToggle });
    fireEvent.click(screen.getByLabelText("Attack Up (Signo Drive)"));

    expect(onToggle).toHaveBeenCalledWith("src:status:10:500");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("marks every selected chip", () => {
    const { container } = renderIt({
      chips: [
        { ...CHIPS[0], selected: true },
        { ...CHIPS[1], selected: true },
      ],
    });

    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
  });

  it("marks only the selected ones", () => {
    renderIt({ chips: [{ ...CHIPS[0], selected: true }, CHIPS[1]] });

    expect(screen.getByLabelText("Attack Up (Signo Drive)").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Veil (Panacea)").getAttribute("aria-pressed")).toBe("false");
  });

  it("says '(all)' in the title once a stack is selected", () => {
    // A row of ticked tiles otherwise reads as "any of these", which is the
    // opposite of what the intersection shows.
    renderIt({ stacked: true, stackPercent: 34 });
    expect(screen.getByText("ui.logs.aura-title-all ui.logs.aura-source-title")).toBeTruthy();
  });

  it("states the stack's own uptime on a SELECTED chip's card", () => {
    // The tile's own uptime is no longer what the view is showing once several
    // are picked — the intersection is, and it appears nowhere else.
    renderIt({ chips: [{ ...CHIPS[0], selected: true }], stacked: true, stackPercent: 34 });
    fireEvent.mouseEnter(screen.getByLabelText("Attack Up (Signo Drive)"));

    const card = document.querySelector('[data-testid="aura-hover-card"]');
    expect(card?.textContent).toContain("ui.logs.aura-uptime 80");
    expect(card?.textContent).toContain("ui.logs.aura-stack-uptime 34");
  });

  it("states no stack uptime on an UNSELECTED chip, or with no stack at all", () => {
    renderIt({ chips: [CHIPS[0]], stacked: true, stackPercent: 34 });
    fireEvent.mouseEnter(screen.getByLabelText("Attack Up (Signo Drive)"));
    expect(document.querySelector("[data-aura-stack]")).toBeNull();

    renderIt({ chips: [{ ...CHIPS[1], selected: true }], stacked: false, stackPercent: null });
    fireEvent.mouseEnter(screen.getByLabelText("Veil (Panacea)"));
    expect(document.querySelector("[data-aura-stack]")).toBeNull();
  });
});
