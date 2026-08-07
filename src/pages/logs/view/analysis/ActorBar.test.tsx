import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActorBar } from "./ActorBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const OPTIONS = [
  { value: "0", label: "Narmaya", iconUrl: "/pl1300.png" },
  { value: "1", label: "Id" },
];

const renderIt = (props: Partial<React.ComponentProps<typeof ActorBar>> = {}) =>
  render(
    <MantineProvider>
      <ActorBar options={OPTIONS} value={null} onChange={() => {}} {...props} />
    </MantineProvider>
  );

describe("ActorBar", () => {
  it("offers the whole party when nothing is pinned", () => {
    renderIt();
    expect(screen.getByPlaceholderText("ui.logs.selector-all-friendlies")).toBeTruthy();
  });

  // The pin travels as an actor INDEX, not the string the Select works in — a
  // pin bar that reported "0" would filter against a dimension nothing matches.
  it("reports the pinned actor as a number", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.click(screen.getByPlaceholderText("ui.logs.selector-all-friendlies"));
    fireEvent.click(screen.getByText("Narmaya"));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it("clears to the whole party", () => {
    const onChange = vi.fn();
    renderIt({ value: 0, onChange });
    fireEvent.click(screen.getByLabelText("ui.logs.selector-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("renders the trailing slot — the view switch lives there", () => {
    renderIt({ trailing: <button type="button">Events</button> });
    expect(screen.getByText("Events")).toBeTruthy();
  });
});
