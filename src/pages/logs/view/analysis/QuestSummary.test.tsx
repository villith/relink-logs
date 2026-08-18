import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QuestSummary } from "./QuestSummary";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const renderIt = (props: Partial<React.ComponentProps<typeof QuestSummary>> = {}) =>
  render(
    <MantineProvider>
      <QuestSummary
        title={<button type="button">picker</button>}
        roomIndex={null}
        imported={false}
        questCompleted={null}
        {...props}
      />
    </MantineProvider>
  );

describe("QuestSummary", () => {
  // The pane's title IS its log picker: the thing that names the log is the
  // thing that changes it.
  it("draws the title it is given", () => {
    renderIt();
    expect(screen.getByText("picker")).toBeTruthy();
  });

  // The picker already states the quest, the party, the date, the in-game time
  // and the id. Restating any of them here is how the two come to disagree.
  it("leaves the date and the id to the title", () => {
    renderIt();
    expect(screen.queryByText(/#\d+/)).toBeNull();
  });

  // The picker states how long the run took, on the row's second line. Two
  // durations side by side in one strip is one figure too many, and the moment
  // either is reformatted they read as disagreeing.
  it("leaves the duration to the title", () => {
    renderIt();
    expect(screen.queryByText("04:12")).toBeNull();
  });

  // The total is the first figure of the table below, and the plot above is
  // made of it — a headline repeating it earned none of the room it took.
  it("does not state the total", () => {
    renderIt();
    expect(screen.queryByText("48.2m")).toBeNull();
    expect(screen.queryByText("ui.logs.total-damage")).toBeNull();
  });

  // null is the caller's way of saying there is nothing to report — no quest,
  // a Conflux room, or the log has not loaded yet — and covers the default
  // above as well as the loading case explicitly.
  it("says nothing when there is no quest status to report", () => {
    renderIt({ questCompleted: null });
    expect(screen.queryByText("ui.logs.quest-cleared")).toBeNull();
    expect(screen.queryByText("ui.logs.quest-failed")).toBeNull();
  });

  it("shows the quest as cleared", () => {
    renderIt({ questCompleted: true });
    expect(screen.getByText("ui.logs.quest-cleared")).toBeTruthy();
    expect(screen.queryByText("ui.logs.quest-failed")).toBeNull();
  });

  it("shows the quest as not cleared", () => {
    renderIt({ questCompleted: false });
    expect(screen.getByText("ui.logs.quest-failed")).toBeTruthy();
    expect(screen.queryByText("ui.logs.quest-cleared")).toBeNull();
  });

  // A Conflux run carries no quest id the picker can name, so the room is the
  // one piece of naming this row still owns.
  it("names a Conflux room, which the picker cannot", () => {
    renderIt({ roomIndex: 2 });
    expect(screen.getByText(/ui\.logs\.conflux-room\s*#3/)).toBeTruthy();
  });

  it("names no room on an ordinary quest", () => {
    renderIt();
    expect(screen.queryByText(/ui\.logs\.conflux-room/)).toBeNull();
  });

  it("shows the imported warning only for an imported log", () => {
    renderIt();
    expect(screen.queryByLabelText("ui.imported-badge")).toBeNull();

    renderIt({ imported: true });
    expect(screen.getByLabelText("ui.imported-badge")).toBeTruthy();
  });

  // Closing a comparison happens where opening one did — the actor bar's right
  // edge, where + Compare stands (see `AnalysisView`) — rather than once per
  // pane down here.
  it("carries no close control", () => {
    renderIt();
    expect(screen.queryByLabelText("ui.logs.compare-remove")).toBeNull();
  });

  /** The beta caveat is NOT here. It belongs to the view rather than to the
   * log, so it is spoken outright in `AnalysisTopBar` — beside the switch that
   * answers it — and a second yellow glyph in this strip would only compete
   * with the imported badge, which does report something about the log. */
  it("leaves the view's own caveat to the top bar", () => {
    renderIt();
    expect(screen.queryByLabelText("ui.logs.view-mode.beta-warning")).toBeNull();
  });
});
