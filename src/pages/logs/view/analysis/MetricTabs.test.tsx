import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MetricTabs } from "./MetricTabs";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const TABS = [
  { value: "damage", labelKey: "ui.logs.metric-damage-done" },
  { value: "stun", labelKey: "ui.logs.metric-stun" },
];

const renderIt = (props: Partial<React.ComponentProps<typeof MetricTabs>> = {}) =>
  render(
    <MantineProvider>
      <MetricTabs tabs={TABS} value="damage" onChange={() => {}} {...props} />
    </MantineProvider>
  );

describe("MetricTabs", () => {
  it("renders one tab per entry", () => {
    renderIt();
    expect(screen.getByText("ui.logs.metric-damage-done")).toBeTruthy();
    expect(screen.getByText("ui.logs.metric-stun")).toBeTruthy();
  });

  it("marks the active tab as selected", () => {
    renderIt();
    const active = screen.getByRole("tab", { name: "ui.logs.metric-damage-done" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "ui.logs.metric-stun" }).getAttribute("aria-selected")).toBe("false");
  });

  it("reports the chosen tab", () => {
    const onChange = vi.fn();
    renderIt({ onChange });
    fireEvent.click(screen.getByRole("tab", { name: "ui.logs.metric-stun" }));
    expect(onChange).toHaveBeenCalledWith("stun");
  });
});
