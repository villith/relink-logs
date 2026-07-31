import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options === "object" ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: "en" },
  }),
}));

const invoke = vi.fn<unknown[], Promise<unknown>>(() => Promise.resolve({}));
vi.mock("@tauri-apps/api", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

vi.mock("@/utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  translateCharacterType: (type: string) => `char:${type}`,
  translateQuestId: (id: number | null) => `quest:${id}`,
  translateEnemyType: () => "enemy",
  translateEnemyTypeId: (id: number) => `enemy:${id}`,
  epochToLocalTime: (time: number) => `time:${time}`,
}));

import { useLogIndexStore } from "@/stores/useLogIndexStore";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { Log, StoredLegalityFinding } from "@/types";

import { IndexPage } from "./Index";

const log = (): Log =>
  ({
    id: 42,
    name: "",
    time: 1,
    duration: 1000,
    version: 1,
    primaryTarget: null,
    p1Name: "Kahs",
    p1Type: "Pl1400",
    p2Name: "Manmoth",
    p2Type: "Pl1300",
    p3Name: null,
    p3Type: null,
    p4Name: null,
    p4Type: null,
    questId: 101,
    questElapsedTime: 60,
    questCompleted: true,
  }) as Log;

/** A finding against party slot 1 — Manmoth, the SECOND name in the row. */
const findingAgainstSlotOne = (): StoredLegalityFinding => ({
  playerIndex: 1,
  displayName: "Manmoth",
  characterType: "Pl1300",
  finding: {
    rule: "summonBonusMagnitude",
    subject: { kind: "summon", index: 0 },
    observed: { kind: "amount", value: 75 },
    allowed: { kind: "amount", value: 50 },
    odds: null,
  },
});

const showList = ({ flagged }: { flagged: boolean }) => {
  const legality: Record<string, StoredLegalityFinding[]> = flagged ? { 42: [findingAgainstSlotOne()] } : {};
  const searchResult = {
    logs: [log()],
    page: 1,
    pageCount: 1,
    logCount: 1,
    enemyIds: [],
    questIds: [],
    playerIds: [],
    playerTypes: [],
    legality,
  };

  useLogIndexStore.setState({ searchResult });
  // The page refetches on mount, so the mocked command has to answer with the
  // same page or it would immediately replace the fixture with nothing.
  invoke.mockResolvedValue(searchResult);

  return render(
    <MantineProvider>
      <MemoryRouter>
        <IndexPage />
      </MemoryRouter>
    </MantineProvider>
  );
};

/** The names carrying a legality mark. A marked member is wrapped in its own
 * element with the mark's hover affordance; a clean one stays a bare text node,
 * which is what makes "who is marked" answerable at all. */
const markedNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("span[style*='cursor: help']")).map(
    (element) => element.textContent
  );

describe("the quest list's flagged players", () => {
  beforeEach(() => {
    useMeterSettingsStore.setState({ show_flagged_builds: true, show_display_names: true, streamer_mode: false });
  });

  /** Each party member is drawn separately so exactly the flagged one can be
   * marked; the joined string this replaced could only mark the whole party. */
  it("marks the flagged player and leaves their party alone", () => {
    const { container } = showList({ flagged: true });

    expect(markedNames(container)).toEqual(["char:Pl1300 (Manmoth)"]);
  });

  /** The row still reads as a party, marked or not. */
  it("still lists the whole party in slot order", () => {
    showList({ flagged: true });

    expect(screen.getByRole("row", { name: /Manmoth/ }).textContent).toContain(
      "char:Pl1400 (Kahs), char:Pl1300 (Manmoth)"
    );
  });

  /** Off by default and off means off: the verdicts are in hand, and nothing
   * on the row may hint at them. */
  it("marks nobody when flagged builds are hidden app-wide", () => {
    useMeterSettingsStore.setState({ show_flagged_builds: false });
    const { container } = showList({ flagged: true });

    expect(markedNames(container)).toEqual([]);
    expect(screen.getByRole("row", { name: /Manmoth/ }).textContent).toContain("char:Pl1300 (Manmoth)");
  });

  /** A response with no `legality` at all — what a backend older than the field
   * returns, which in development is simply the binary that has not been
   * rebuilt yet. The row must read it as "nobody flagged", not walk off it:
   * this is a render path, so throwing here takes the whole page down. */
  it("survives a response from a backend that knows nothing about legality", () => {
    const legacyResult = {
      logs: [log()],
      page: 1,
      pageCount: 1,
      logCount: 1,
      enemyIds: [],
      questIds: [],
      playerIds: [],
      playerTypes: [],
    };
    useLogIndexStore.setState({ searchResult: legacyResult as never });
    invoke.mockResolvedValue(legacyResult);

    expect(() =>
      render(
        <MantineProvider>
          <MemoryRouter>
            <IndexPage />
          </MemoryRouter>
        </MantineProvider>
      )
    ).not.toThrow();

    expect(screen.getByRole("row", { name: /Manmoth/ })).toBeTruthy();
  });

  it("offers the flagged filter only while flagged builds are shown", () => {
    useLogIndexStore.setState({ filters: { ...useLogIndexStore.getState().filters, showAdvancedFilters: true } });

    const { unmount } = showList({ flagged: false });
    expect(screen.queryByPlaceholderText("ui.logs.filter-flagged")).not.toBeNull();
    unmount();

    useMeterSettingsStore.setState({ show_flagged_builds: false });
    showList({ flagged: false });
    expect(screen.queryByPlaceholderText("ui.logs.filter-flagged")).toBeNull();
  });
});
