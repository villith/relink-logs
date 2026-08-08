import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DebugBar } from "./DebugBar";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const renderBar = (search: string, chart = "metric=damage") =>
  render(
    <MantineProvider>
      <DebugBar search={search} chart={chart} />
    </MantineProvider>
  );

describe("DebugBar", () => {
  it("prints the query string verbatim, leading ? and all", () => {
    // Verbatim is the point: a readout that pretty-printed the pins would be a
    // second decoding of the URL, and could agree with the chart while the URL
    // that produced it did not.
    renderBar("?src=2&tgt=3,4&abil=action%3A1601");
    expect(screen.getByText("?src=2&tgt=3,4&abil=action%3A1601")).toBeTruthy();
  });

  it("says so when nothing is pinned rather than showing a blank line", () => {
    renderBar("");
    expect(screen.getByText("ui.debug.analysis-query-empty")).toBeTruthy();
  });

  it("prints the chart summary beside it", () => {
    renderBar("?src=2", "metric=damage level=abilities chart=drill");
    expect(screen.getByText("metric=damage level=abilities chart=drill")).toBeTruthy();
  });

  describe("the copy buttons", () => {
    const stubClipboard = () => {
      const writeText = vi.fn(() => Promise.resolve());
      // jsdom ships no clipboard at all, so it is defined rather than spied on.
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      return writeText;
    };

    it("copies each line's own value", async () => {
      const writeText = stubClipboard();
      renderBar("?src=2", "metric=damage");

      const [query, chart] = screen.getAllByText("ui.debug.copy");
      fireEvent.click(query);
      expect(writeText).toHaveBeenCalledWith("?src=2");

      fireEvent.click(chart);
      expect(writeText).toHaveBeenCalledWith("metric=damage");
    });

    it("copies the empty query as empty, not as the word standing in for it", async () => {
      // The readout prints "(none)" so the line is not blank; a report pasting
      // that back would be pasting a word this component invented.
      const writeText = stubClipboard();
      renderBar("");
      fireEvent.click(screen.getAllByText("ui.debug.copy")[0]);
      expect(writeText).toHaveBeenCalledWith("");
    });

    it("confirms on the button itself", async () => {
      stubClipboard();
      renderBar("?src=2");
      fireEvent.click(screen.getAllByText("ui.debug.copy")[0]);
      await waitFor(() => expect(screen.getByText("ui.debug.copied")).toBeTruthy());
    });
  });
});
