import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
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
});
