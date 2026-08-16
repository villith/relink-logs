import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PaneSources } from "@/stores/useAnalysisPanesStore";

import { ActorBar } from "./ActorBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const OPTIONS = [
  { value: "0", label: "Narmaya", iconUrl: "/pl1300.png" },
  { value: "1", label: "Id" },
];

const pane = (over: Partial<PaneSources> = {}): PaneSources => ({
  options: OPTIONS,
  value: null,
  onChange: () => {},
  ...over,
});

const renderIt = (props: Partial<React.ComponentProps<typeof ActorBar>> = {}) =>
  render(
    <MantineProvider>
      <ActorBar panes={[pane()]} {...props} />
    </MantineProvider>
  );

const selectors = () => screen.getAllByPlaceholderText("ui.logs.selector-all-friendlies");

describe("ActorBar", () => {
  it("offers the whole party when nothing is pinned", () => {
    renderIt();
    expect(selectors()).toHaveLength(1);
  });

  // The pin travels as an actor INDEX, not the string the Select works in — a
  // pin bar that reported "0" would filter against a dimension nothing matches.
  it("reports the pinned actor as a number", () => {
    const onChange = vi.fn();
    renderIt({ panes: [pane({ onChange })] });
    fireEvent.click(selectors()[0]);
    fireEvent.click(screen.getByText("Narmaya"));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it("clears to the whole party", () => {
    const onChange = vi.fn();
    renderIt({ panes: [pane({ value: 0, onChange })] });
    fireEvent.click(screen.getByLabelText("ui.logs.selector-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("renders the trailing slot — the compare control lives there", () => {
    renderIt({ trailing: <button type="button">Compare</button> });
    expect(screen.getByText("Compare")).toBeTruthy();
  });

  // One selector per LOG: a comparison picks one source from each fight, and
  // two logs rarely share a party, so neither selector can stand in for the
  // other.
  it("draws one selector per pane", () => {
    renderIt({ panes: [pane(), pane(), pane()] });
    expect(selectors()).toHaveLength(3);
  });

  // Each selector carries its OWN pane's universe and its own handler. Two logs
  // rarely share a party, so a bar that merged the option lists — or routed
  // every change through one callback — would move both logs' pins together and
  // offer each of them the other's players.
  //
  // The two panes are given DISJOINT option labels, which is what makes this a
  // real test: "Ferry" exists only in pane 1's list, so reaching it through
  // pane 1's selector proves both the routing and the universes at once.
  it("gives each selector its own pane's options and handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderIt({
      panes: [
        pane({ options: [{ value: "0", label: "Narmaya" }], onChange: first }),
        pane({ options: [{ value: "3", label: "Ferry" }], onChange: second }),
      ],
    });

    fireEvent.click(selectors()[1]);
    fireEvent.click(screen.getByText("Ferry"));

    expect(second).toHaveBeenCalledWith(3);
    expect(first).not.toHaveBeenCalled();
  });
});
