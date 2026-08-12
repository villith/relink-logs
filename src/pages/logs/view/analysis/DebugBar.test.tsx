import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DebugBar } from "./DebugBar";
import type { ActionEntry } from "./machine/actionLog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const READOUT = [
  { label: "state", value: '{"metric":"damage"}' },
  { label: "spec", value: "groupBy=source body=table settled=yes" },
];

const OPENED: ActionEntry = {
  kind: "opened",
  seq: 0,
  atMs: 0,
  summary: "tab=table metric=damage side=friendly",
  query: "",
};

const CHANGE: ActionEntry = {
  kind: "change",
  seq: 1,
  atMs: 1234,
  deltas: [
    { field: "side", from: "friendly", to: "enemy" },
    { field: "src", from: "2", to: "—" },
  ],
  query: "?side=enemy",
};

const renderBar = (search: string, { readout = READOUT, entries = [] as ActionEntry[], dropped = 0 } = {}) =>
  render(
    <MantineProvider>
      <DebugBar search={search} readout={readout} actions={{ entries, dropped }} />
    </MantineProvider>
  );

/** Opens the collapsed trail, which is where every action assertion lives. */
const openActions = () => fireEvent.click(screen.getByText(/ui\.debug\.analysis-actions$/));

describe("DebugBar", () => {
  it("prints the query string verbatim, leading ? and all", () => {
    // Verbatim is the point: a readout that pretty-printed the pins would be a
    // second decoding of the URL, and could agree with the state line while the
    // URL that produced it did not.
    renderBar("?src=2&tgt=3,4&abil=action%3A1601");
    expect(screen.getByText("?src=2&tgt=3,4&abil=action%3A1601")).toBeTruthy();
  });

  it("says so when nothing is pinned rather than showing a blank line", () => {
    renderBar("");
    expect(screen.getByText("ui.debug.analysis-query-empty")).toBeTruthy();
  });

  it("prints every readout line beneath it", () => {
    renderBar("?src=2");
    expect(screen.getByText('{"metric":"damage"}')).toBeTruthy();
    expect(screen.getByText("groupBy=source body=table settled=yes")).toBeTruthy();
  });

  describe("the action trail", () => {
    it("stays collapsed, showing only how many steps it holds", () => {
      // Expanded by default it would push the table down the page on every
      // dev run, which is how a debug panel gets switched off for good.
      renderBar("?src=2", { entries: [OPENED, CHANGE] });
      expect(screen.getByText("2")).toBeTruthy();
      expect(screen.queryByText("friendly → enemy")).toBeNull();
    });

    it("shows each step's deltas once opened", () => {
      renderBar("?src=2", { entries: [OPENED, CHANGE] });
      openActions();
      expect(screen.getByText("friendly → enemy")).toBeTruthy();
      expect(screen.getByText("2 → —")).toBeTruthy();
    });

    it("shows where the session started", () => {
      renderBar("", { entries: [OPENED] });
      openActions();
      expect(screen.getByText("tab=table metric=damage side=friendly")).toBeTruthy();
    });

    it("stamps each step against the mount", () => {
      renderBar("", { entries: [OPENED, CHANGE] });
      openActions();
      expect(screen.getByText("+1.2s")).toBeTruthy();
    });

    it("says the trail is empty rather than opening onto nothing", () => {
      renderBar("");
      openActions();
      expect(screen.getByText("ui.debug.analysis-actions-empty")).toBeTruthy();
    });

    it("admits what the cap dropped", () => {
      renderBar("", { entries: [CHANGE], dropped: 12 });
      openActions();
      expect(screen.getByText("ui.debug.analysis-actions-dropped")).toBeTruthy();
    });
  });

  describe("the copy buttons", () => {
    const stubClipboard = () => {
      // Typed through its parameter so `mock.calls[0][0]` is a string rather
      // than an empty tuple's missing element.
      const writeText = vi.fn<[string], Promise<void>>(() => Promise.resolve());
      // jsdom ships no clipboard at all, so it is defined rather than spied on.
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      return writeText;
    };

    /** Clicks a copy button and lets its clipboard promise settle. The button
     * confirms on itself when the write resolves, so a bare click leaves a
     * state update landing after the test. */
    const clickCopy = async (label: string) => {
      await act(async () => {
        fireEvent.click(screen.getByText(label));
      });
    };

    it("copies the query on its own, which is what goes back into an address bar", async () => {
      const writeText = stubClipboard();
      renderBar("?src=2");
      await clickCopy("ui.debug.copy");
      expect(writeText).toHaveBeenCalledWith("?src=2");
    });

    it("copies the empty query as empty, not as the word standing in for it", async () => {
      // The readout prints "(none)" so the line is not blank; a report pasting
      // that back would be pasting a word this component invented.
      const writeText = stubClipboard();
      renderBar("");
      await clickCopy("ui.debug.copy");
      expect(writeText).toHaveBeenCalledWith("");
    });

    it("confirms on the button itself", async () => {
      stubClipboard();
      renderBar("?src=2");
      fireEvent.click(screen.getByText("ui.debug.copy"));
      await waitFor(() => expect(screen.getByText("ui.debug.copied")).toBeTruthy());
    });

    it("copies the state and the whole trail as one report", async () => {
      const writeText = stubClipboard();
      renderBar("?side=enemy", { entries: [OPENED, CHANGE] });
      await clickCopy("ui.debug.copy-report");

      const report = writeText.mock.calls[0][0];
      expect(report).toContain("query   ?side=enemy");
      expect(report).toContain('state   {"metric":"damage"}');
      expect(report).toContain("ACTIONS (2)");
      expect(report).toContain("side    friendly → enemy");
      // The per-step query is in the REPORT even though the panel omits it —
      // it is what makes a step replayable.
      expect(report).toContain("query   ?side=enemy");
    });

    it("reports the trail even while it is collapsed", async () => {
      // The collapse is a display choice; a report taken without expanding must
      // not silently omit how the user got there.
      const writeText = stubClipboard();
      renderBar("", { entries: [CHANGE] });
      await clickCopy("ui.debug.copy-report");
      expect(writeText.mock.calls[0][0]).toContain("side    friendly → enemy");
    });
  });
});
