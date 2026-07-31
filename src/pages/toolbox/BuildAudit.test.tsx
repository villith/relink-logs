import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options === "object" ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: "en" },
  }),
}));

const invoke = vi.fn();
vi.mock("@tauri-apps/api", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

// The gear names come from bundles the real app loads; the audit page only has
// to hand them the right ids, so stub them to something a test can read back.
vi.mock("@/utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  translateCharacterType: (type: string) => `char:${type}`,
  translateQuestId: (id: number | null) => `quest:${id}`,
  epochToLocalTime: (time: number) => `time:${time}`,
  translateWrightstoneId: () => "Dread Wrightstone III",
  translateTraitId: (id: number) => `trait:${id}`,
  translateSigilId: (id: number) => `sigil:${id}`,
}));

import BuildAudit from "./BuildAudit";

const wrightstoneFinding = {
  rule: "wrightstoneTraitLevel",
  subject: { kind: "wrightstone" },
  observed: { kind: "levels", value: [30, 20, 20] },
  allowed: { kind: "levels", value: [20, 15, 10] },
  odds: null,
  evidence: {
    kind: "wrightstone",
    wrightstoneId: 77,
    traits: [
      { id: 1, level: 30 },
      { id: 2, level: 20 },
      { id: 3, level: 20 },
    ],
  },
};

/** One person, flagged with the SAME finding in two fights — the normal case,
 * and the one the case-reduction exists for. */
const kahs = {
  displayName: "Kahs",
  characterType: "Pl1000",
  encounters: 2,
  lastSeen: 300,
  findings: [
    { logId: 10, time: 300, questId: 401, finding: wrightstoneFinding },
    { logId: 11, time: 200, questId: 402, finding: wrightstoneFinding },
  ],
};

const encounter = {
  players: [
    {
      displayName: "Kahs",
      characterType: "Pl1000",
      weaponInfo: {
        wrightstoneId: 77,
        trait1Id: 1,
        trait1Level: 30,
        trait2Id: 2,
        trait2Level: 20,
        trait3Id: 3,
        trait3Level: 20,
      },
    },
  ],
};

const renderPage = () =>
  render(
    <MantineProvider>
      <MemoryRouter>
        <BuildAudit />
      </MemoryRouter>
    </MantineProvider>
  );

describe("BuildAudit", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((command: string) =>
      command === "fetch_legality_players" ? Promise.resolve([kahs]) : Promise.resolve(encounter)
    );
  });

  /** A rail beside an empty pane is a page that asks the reader to click before
   * it will say anything. */
  it("lands on the first flagged player without being asked", async () => {
    renderPage();
    expect(await screen.findByText("char:Pl1000")).toBeTruthy();
  });

  /** The page opens ONE query and opens no encounter at all: every finding
   * carries the gear it is about, so there is nothing left to go and look up.
   * This used to cost a full log parse per selected player. */
  it("never opens an encounter", async () => {
    renderPage();
    await screen.findByText("Dread Wrightstone III");

    expect(invoke.mock.calls.filter(([command]) => command === "fetch_encounter_state")).toEqual([]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["fetch_legality_players"]);
  });

  /** The same wrightstone in two fights is ONE fact. Stating it twice is what
   * made the old page a wall of repetition. */
  it("states a repeated finding once", async () => {
    renderPage();
    await screen.findByText("Dread Wrightstone III");
    expect(screen.getAllByText("Dread Wrightstone III")).toHaveLength(1);
  });

  /** Each slot must quote ITS OWN cap — the failure this guards against prints
   * one cap three times, which reads as three identical claims about three
   * different traits. */
  it("quotes each breached trait line against its own cap", async () => {
    renderPage();
    await screen.findByText("Dread Wrightstone III");

    for (const allowed of [20, 15, 10]) {
      expect(
        screen.getByText(
          `ui.legality.limit.wrightstoneTraitLevel:${JSON.stringify({
            observed: allowed === 20 ? 30 : 20,
            allowed,
            chance: "",
          })}`
        )
      ).toBeTruthy();
    }
  });

  /** Every flagged fight is still reachable — they are the links out. */
  it("lists both flagged fights", async () => {
    renderPage();
    expect(await screen.findByText("quest:401 · time:300")).toBeTruthy();
    expect(screen.getByText("quest:402 · time:200")).toBeTruthy();
  });

  /** Empty is the CORRECT result for almost everyone, so it must not look like
   * a failure to load. */
  it("says what was checked when nothing is flagged", async () => {
    invoke.mockImplementation((command: string) =>
      command === "fetch_legality_players" ? Promise.resolve([]) : Promise.resolve(encounter)
    );
    renderPage();

    expect(await screen.findByText("ui.legality.no-findings-detail")).toBeTruthy();
  });

  /** A search that matches nobody must offer the way back out, not strand the
   * reader on a blank rail. */
  it("offers a way back when a search matches nobody", async () => {
    renderPage();
    // Wait for the detail pane, not just the rail — auto-selection lands a tick
    // after the list does, and counting before it makes this a race.
    await screen.findByText("Dread Wrightstone III");
    // Twice over: once in the rail, once as the detail heading.
    expect(screen.getAllByText("Kahs")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("ui.legality.search-placeholder"), { target: { value: "nobody" } });

    await waitFor(() => expect(screen.getByText("ui.legality.no-matches")).toBeTruthy());
    expect(screen.getByText("ui.legality.clear-filters")).toBeTruthy();
  });

  /** A row stored before findings carried their gear. The sweep refills these,
   * so it is transient — but it must say so rather than guess a name, and it
   * must not render the blank the old cell did. */
  it("says so when a stored finding predates the gear snapshot", async () => {
    const old = {
      ...kahs,
      findings: [{ logId: 10, time: 300, questId: 401, finding: { ...wrightstoneFinding, evidence: null } }],
    };
    invoke.mockImplementation((command: string) =>
      command === "fetch_legality_players" ? Promise.resolve([old]) : Promise.resolve(encounter)
    );
    renderPage();

    expect(await screen.findByText("ui.legality.detail-unavailable")).toBeTruthy();
  });
});

/**
 * A person who CHANGED their build between fights.
 *
 * Slot 0 held sigil 111 in the older fight (log 21) and sigil 222 in the newer
 * one (log 20). A finding's subject is a slot index into the encounter it was
 * computed from, so the log-21 finding is about sigil 111 — and naming it
 * against log 20's gear accuses sigil 222 of something it never carried.
 */
const swapped = {
  displayName: "Swapper",
  characterType: "Pl1000",
  encounters: 2,
  lastSeen: 900,
  findings: [
    {
      logId: 20,
      time: 900,
      questId: 501,
      finding: {
        rule: "sigilTraitLevel",
        subject: { kind: "sigil", index: 1 },
        observed: { kind: "level", value: 40 },
        allowed: { kind: "level", value: 15 },
        odds: null,
        evidence: {
          kind: "sigil",
          sigilId: 333,
          level: 15,
          traits: [
            { id: 9, level: 15 },
            { id: 8, level: 40 },
          ],
        },
      },
    },
    {
      logId: 21,
      time: 800,
      questId: 502,
      finding: {
        rule: "sigilTraitLevel",
        subject: { kind: "sigil", index: 0 },
        observed: { kind: "level", value: 30 },
        allowed: { kind: "level", value: 15 },
        odds: null,
        evidence: {
          kind: "sigil",
          sigilId: 111,
          level: 15,
          traits: [
            { id: 9, level: 15 },
            { id: 8, level: 30 },
          ],
        },
      },
    },
  ],
};

const sigil = (sigilId: number, secondLevel: number) => ({
  sigilId,
  sigilLevel: 15,
  firstTraitId: 9,
  firstTraitLevel: 15,
  secondTraitId: 8,
  secondTraitLevel: secondLevel,
});

const swappedEncounters: Record<number, unknown> = {
  // Newest: slot 0 is now a legal sigil 222; slot 1 carries the level-40 trait.
  20: { players: [{ displayName: "Swapper", characterType: "Pl1000", sigils: [sigil(222, 15), sigil(333, 40)] }] },
  // Older: slot 0 was sigil 111, carrying the level-30 trait.
  21: { players: [{ displayName: "Swapper", characterType: "Pl1000", sigils: [sigil(111, 30), sigil(333, 15)] }] },
};

describe("BuildAudit when the build changed between fights", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((command: string, args?: { id: number }) =>
      command === "fetch_legality_players"
        ? Promise.resolve([swapped])
        : Promise.resolve(swappedEncounters[args?.id ?? 0])
    );
  });

  /** The bug this guards: a finding from an older fight resolved against the
   * newest encounter names whatever sigil now sits in that slot. A wrong item
   * name is the worst failure an accusation can have. */
  it("names each finding's gear from the fight that finding came from", async () => {
    renderPage();

    expect(await screen.findByText(/sigil:111/)).toBeTruthy();
    expect(screen.getByText(/sigil:333/)).toBeTruthy();
    expect(screen.queryByText(/sigil:222/)).toBeNull();
  });

  /** Two different builds are two different fights, and the reader has to know
   * which gear belongs to which — otherwise the case reads as one incoherent
   * build wearing four sigils in two slots. */
  it("attributes each build to the fight it was worn in", async () => {
    renderPage();
    await screen.findByText(/sigil:111/);

    expect(screen.getAllByText("quest:501 · time:900").length).toBeGreaterThan(1);
    expect(screen.getAllByText("quest:502 · time:800").length).toBeGreaterThan(1);
  });
});
