import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricRow } from "../metrics/types";

import { TimelineTab } from "./TimelineTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

// The stream is the container's only fetch; stubbing the hook keeps this test
// about wiring rather than about Tauri.
vi.mock("../events/useEvents", () => ({
  useEvents: () => ({
    events: [
      [
        1000,
        {
          DamageEvent: { source: { parent_index: 0 }, target: { index: 900 }, action_id: { Normal: 100 }, damage: 500 },
        },
      ],
      [
        2000,
        {
          DamageEvent: { source: { parent_index: 0 }, target: { index: 900 }, action_id: { Normal: 100 }, damage: 700 },
        },
      ],
    ],
    total: 2,
  }),
}));

const ROWS: MetricRow[] = [
  {
    key: "skill:Normal:100",
    label: "Normal:100",
    kind: "ability",
    value: 1200,
    columns: [],
    pinOnClick: null,
    colorSlot: 0,
  },
];

const renderTab = (over = {}) =>
  render(
    <MantineProvider>
      <TimelineTab
        id="1"
        metric="damage"
        hostility="friendly"
        rows={ROWS}
        everySkill={[]}
        pins={{ source: null, targetSpans: [], abilityKeys: null }}
        probes={{ isPartyMember: (index: number) => index < 4, isHarmful: () => false }}
        window={{ startMs: 0, endMs: 30_000 }}
        segmentAt={() => -1}
        enemyTypeAt={() => null}
        renderLabel={(row: MetricRow) => `label(${row.key})`}
        rowColor={() => "#36B37E"}
        onPin={() => {}}
        {...over}
      />
    </MantineProvider>
  );

describe("TimelineTab", () => {
  it("renders a lane for each row it was given", () => {
    renderTab();
    expect(screen.getByText("label(skill:Normal:100)")).toBeTruthy();
  });

  // The events must actually reach the lane, or the timeline is an empty
  // skeleton that still looks correct.
  it("places the metric's events onto their lane", () => {
    const { container } = renderTab();
    expect(container.querySelectorAll(".timeline-mark").length).toBeGreaterThan(0);
  });

  it("shows the empty state when the metric has no rows", () => {
    renderTab({ rows: [] });
    expect(screen.getByText("ui.logs.timeline-empty")).toBeTruthy();
  });
});
