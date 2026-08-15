import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LogSummary } from "@/types";

import { LogPicker } from "./LogPicker";

// `t` is called both ways here — with a fallback string and with interpolation
// values — so the mock has to tell the two apart. Returning the options object
// would hand React an object to render, which throws rather than failing an
// assertion.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
  }),
}));

const log = (over: Partial<LogSummary> & { id: number }): LogSummary => ({
  time: 1_700_000_000,
  duration: 120_000,
  questId: 2657,
  questElapsedTime: 180,
  p1Type: "Pl1400",
  p2Type: null,
  p3Type: null,
  p4Type: null,
  repeatGroup: null,
  ...over,
});

const renderPicker = (props: Partial<React.ComponentProps<typeof LogPicker>> = {}) =>
  render(
    <MantineProvider>
      <LogPicker logs={[log({ id: 1 })]} value={1} onChange={vi.fn()} {...props} />
    </MantineProvider>
  );

/** Mantine keeps the dropdown MOUNTED while it is closed, merely hidden, so the
 * same log reads twice from `screen`. Queries here are scoped to the control or
 * to the option role, which the hidden dropdown drops out of. */
const target = () => screen.getByRole("button");
const optionTexts = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");

describe("LogPicker", () => {
  it("names the selected log on the closed control", () => {
    renderPicker();
    expect(within(target()).getByText(/#1/)).toBeTruthy();
  });

  it("keeps its options out of reach until it is opened", () => {
    renderPicker();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("offers each run of a chain as its own option", () => {
    renderPicker({ logs: [log({ id: 10 }), log({ id: 11, repeatGroup: 10 })], value: 10 });
    fireEvent.click(target());
    expect(optionTexts().map((text) => text.match(/#\d+/)?.[0])).toEqual(["#10", "#11"]);
  });

  it("reports the chosen log's id", () => {
    const onChange = vi.fn();
    renderPicker({ logs: [log({ id: 10 }), log({ id: 11, repeatGroup: 10 })], value: 10, onChange });
    fireEvent.click(target());
    const option = screen.getAllByRole("option").find((node) => node.textContent?.includes("#11"));
    fireEvent.click(option as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(11);
  });

  // A pane whose log is not in the library yet — the library load has not landed,
  // or the log was deleted from under a bookmarked URL — must still draw a
  // control that opens, rather than an empty box or a crash.
  it("stands in for a log the library does not carry", () => {
    renderPicker({ logs: [], value: 999 });
    expect(within(target()).getByText("#999")).toBeTruthy();
  });

  it("says so when the search matches nothing", () => {
    renderPicker();
    fireEvent.click(target());
    fireEvent.change(screen.getByPlaceholderText("ui.logs.picker-search-placeholder"), {
      target: { value: "wilinus" },
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("ui.logs.picker-empty")).toBeTruthy();
  });

  it("searches the party, not just the quest", () => {
    renderPicker({ logs: [log({ id: 10, p1Type: "Pl1400" }), log({ id: 11, p1Type: "Pl0700" })], value: 10 });
    fireEvent.click(target());
    fireEvent.change(screen.getByPlaceholderText("ui.logs.picker-search-placeholder"), {
      target: { value: "pl0700" },
    });
    expect(optionTexts().map((text) => text.match(/#\d+/)?.[0])).toEqual(["#11"]);
  });
});
