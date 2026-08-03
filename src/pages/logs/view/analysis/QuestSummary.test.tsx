import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EncounterState } from "@/types";

import { QuestSummary } from "./QuestSummary";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// translateQuestId and friends reach i18next resources that are not loaded in
// jsdom; stub the two this component calls.
vi.mock("@/utils", async () => {
  const actual = await vi.importActual<typeof import("@/utils")>("@/utils");
  return {
    ...actual,
    translateQuestId: (id: number) => `quest-${id}`,
  };
});

const ENCOUNTER = {
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_252_000,
  totalDamage: 48_200_000,
} as EncounterState;

const renderIt = (props: Partial<React.ComponentProps<typeof QuestSummary>> = {}) =>
  render(
    <MantineProvider>
      <QuestSummary
        encounter={ENCOUNTER}
        questId={123}
        roomIndex={null}
        questCompleted
        questTimer={null}
        imported={false}
        {...props}
      />
    </MantineProvider>
  );

describe("QuestSummary", () => {
  it("names the quest", () => {
    renderIt();
    expect(screen.getByText("quest-123")).toBeTruthy();
  });

  it("states the duration between the first and last hit", () => {
    renderIt();
    // Duration shares its element with the wall-clock time, so match the
    // leading figure rather than the whole line.
    expect(screen.getByText(/^04:12 · /)).toBeTruthy();
  });

  it("humanises the total", () => {
    renderIt();
    expect(screen.getByText("48.2m")).toBeTruthy();
  });

  it("says cleared or not cleared", () => {
    renderIt();
    expect(screen.getByText("ui.logs.quest-cleared")).toBeTruthy();

    renderIt({ questCompleted: false });
    expect(screen.getByText("ui.logs.quest-failed")).toBeTruthy();
  });

  it("names a Conflux room instead of a quest when there is one", () => {
    renderIt({ roomIndex: 2 });
    expect(screen.getByText("ui.logs.conflux-room #3")).toBeTruthy();
    expect(screen.queryByText("quest-123")).toBeNull();
  });

  it("shows the imported warning only for an imported log", () => {
    renderIt();
    expect(screen.queryByLabelText("ui.imported-badge")).toBeNull();

    renderIt({ imported: true });
    expect(screen.getByLabelText("ui.imported-badge")).toBeTruthy();
  });
});
