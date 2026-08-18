import { describe, expect, it } from "vitest";

import type { EncounterState, LegalityFinding, PlayerData } from "@/types";

import { encounterFromResponse, type EncounterStateResponse } from "./useEncounterStore";

const player = (index: number) => ({ index, displayName: `p${index}` }) as unknown as PlayerData;
const finding = (name: string) => ({ kind: name }) as unknown as LegalityFinding;

const response = (over: Partial<EncounterStateResponse> = {}): EncounterStateResponse => ({
  encounterState: { party: {} } as unknown as EncounterState,
  dpsChart: {},
  hpChart: [],
  sbaChart: {},
  sbaEvents: [],
  deathEvents: [],
  chartLen: 0,
  sbaChartLen: 0,
  targetEntries: [],
  players: [],
  legality: [],
  questId: null,
  questTimer: null,
  questCompleted: null,
  roomIndex: null,
  ...over,
});

describe("encounterFromResponse", () => {
  // The response is keyed by PARTY SLOT and empty slots are dropped, so the two
  // filters have to move together — a finding landing one row early accuses the
  // wrong person of a cheated build.
  it("keeps a finding with its player when an earlier slot was empty", () => {
    const facts = encounterFromResponse(
      response({
        players: [null as unknown as PlayerData, player(1), player(2)],
        legality: [[finding("slot0")], [finding("slot1")], [finding("slot2")]],
      })
    );

    expect(facts.players).toHaveLength(2);
    expect(facts.legality).toEqual([[finding("slot1")], [finding("slot2")]]);
  });

  it("gives a player with no findings an empty vector rather than a hole", () => {
    const facts = encounterFromResponse(response({ players: [player(0), player(1)], legality: [[finding("a")]] }));

    expect(facts.legality).toEqual([[finding("a")], []]);
  });

  // Every optional field is one a backend older than it simply does not send;
  // the view indexes them all, where undefined throws the page away.
  it("reads a backend older than each optional field as that field's empty value", () => {
    const facts = encounterFromResponse(response());

    expect(facts.stunChart).toEqual({});
    expect(facts.takenChart).toEqual({});
    expect(facts.statusIntervals).toEqual([]);
    expect(facts.chartWindows).toEqual([]);
    expect(facts.abilitySeries).toEqual({});
    expect(facts.selectionFacts).toEqual([]);
    expect(facts.groups).toEqual([]);
    expect(facts.groupReference).toEqual([]);
    expect(facts.imported).toBe(false);
  });

  it("reads an unreported clear as not cleared", () => {
    expect(encounterFromResponse(response({ questCompleted: null })).questCompleted).toBe(false);
  });
});
