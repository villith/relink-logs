import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PinSelect } from "./PinSelect";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const DATA = [
  { value: "1", label: "Vulkan Bolla Nihilla", iconUrl: "/em1000.png", color: "#F06595" },
  // No portrait — trash mobs have none anywhere in the game's UI.
  { value: "2", label: "Goblin" },
];

const renderIt = (props: Partial<React.ComponentProps<typeof PinSelect>> = {}) =>
  render(
    <MantineProvider>
      <PinSelect
        minWidth={200}
        data={DATA}
        value={null}
        placeholder="All enemies"
        ariaLabel="Target"
        onChange={() => {}}
        {...props}
      />
    </MantineProvider>
  );

const openIt = () => fireEvent.click(screen.getByPlaceholderText("All enemies"));

describe("PinSelect", () => {
  it("names the control for a screen reader, with no visible label", () => {
    renderIt();
    expect(screen.getByLabelText("Target")).toBeTruthy();
    expect(screen.queryByText("Target")).toBeNull();
  });

  it("shows an option's art beside its name", () => {
    renderIt();
    openIt();
    const option = screen.getByText("Vulkan Bolla Nihilla").closest(".analysis-select-option-row");
    expect(option?.querySelector("img")?.getAttribute("src")).toBe("/em1000.png");
  });

  // `undefined` art is the common case, not a failure — an option that has none
  // must still render its name rather than a broken image.
  it("renders an artless option as its name alone", () => {
    renderIt();
    openIt();
    const option = screen.getByText("Goblin").closest(".analysis-select-option-row");
    expect(option).toBeTruthy();
    expect(option?.querySelector("img")).toBeNull();
  });

  it("puts the selected option's art in the control itself", () => {
    const { container } = renderIt({ value: "1" });
    // The dropdown is closed, so the only icon on screen is the input's.
    expect(container.querySelector("img.analysis-select-icon")?.getAttribute("src")).toBe("/em1000.png");
  });

  // An empty left section still reserves its width, which would indent the
  // placeholder of every selector whose list happens to be artless.
  it("reserves no left section for a selection with no art", () => {
    const { container } = renderIt({ value: "2" });
    expect(container.querySelector("img.analysis-select-icon")).toBeNull();
  });

  // An option wears its ACTOR colour — the same one its chart band and its
  // table row take, so the dropdown you pick an enemy from already agrees with
  // what you are about to look at.
  it("wears the actor's colour in the option and in the control", () => {
    const { container } = renderIt({ value: "1" });
    expect(container.querySelector<HTMLElement>("input")?.style.color).toBe("rgb(240, 101, 149)");

    openIt();
    const option = screen.getByText("Vulkan Bolla Nihilla");
    expect(option.style.color).toBe("rgb(240, 101, 149)");
  });

  // An ability names no actor, so it has no colour to take and must not
  // inherit one from whichever option happened to be resolved before it.
  it("leaves a colourless option plain", () => {
    renderIt();
    openIt();
    expect(screen.getByText("Goblin").style.color).toBe("");
  });

  it("reports the chosen value", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    openIt();
    fireEvent.click(screen.getByText("Goblin"));
    expect(onChange).toHaveBeenCalledWith("2");
  });
});
