import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, LegalityFinding, PlayerData } from "@/types";

import { usePlayerRow } from "./usePlayerRow";

const finding = (): LegalityFinding => ({
  rule: "summonBonusMagnitude",
  subject: { kind: "summon", index: 0 },
  observed: { kind: "amount", value: 75 },
  allowed: { kind: "amount", value: 50 },
  odds: null,
});

/** A full set of perfect summons — the one finding that reads as luck rather
 * than cheating, and so colours gold instead of red. */
const perfectSummons = (): LegalityFinding => ({
  rule: "summonPerfectCount",
  subject: { kind: "summons" },
  observed: { kind: "count", value: 3 },
  allowed: { kind: "none" },
  odds: 4.7e-7,
});

/** The OTHER long-odds report. It stays red: only perfect summons earns the
 * gold, and a second unexplained colour would be a second kind of accusation. */
const perfectOvermasteries = (): LegalityFinding => ({
  rule: "overmasteryAllMaxed",
  subject: { kind: "overmasteries" },
  observed: { kind: "count", value: 4 },
  allowed: { kind: "none" },
  odds: 1.2e-5,
});

/** Enough of a player for the hook; the row's damage columns are not under
 * test here, only the legality colour. */
const player = { index: 7, partyIndex: 0 } as ComputedPlayerState;
const partyData = [{ actorIndex: 7 } as PlayerData, null, null, null];

const render = (legality: LegalityFinding[][]) =>
  renderHook(() => usePlayerRow(true, player, partyData, legality)).result;

describe("usePlayerRow legality colour", () => {
  beforeEach(() => {
    act(() => {
      useMeterSettingsStore.setState({
        show_flagged_builds: true,
        highlight_illegal_builds: true,
        streamer_mode: false,
      });
    });
  });

  it("colours a player whose build was flagged", () => {
    expect(render([[finding()], [], [], []]).current.legalityColor).toBe("red");
  });

  /** "Blessed by RNG": a player whose ONLY finding is a full set of perfect
   * summons is a farmer, and their name says so in gold rather than red. */
  it("colours a purely lucky player gold", () => {
    expect(render([[perfectSummons()], [], [], []]).current.legalityColor).toBe("yellow");
  });

  /** Luck does not launder a modded build: one real breach beside the perfect
   * summons and the row is red like any other cheat. */
  it("colours a lucky player red once a real breach joins", () => {
    expect(render([[perfectSummons(), finding()], [], [], []]).current.legalityColor).toBe("red");
  });

  /** Only perfect summons earns the gold; all-maxed overmasteries is a ladder a
   * few rerolls can walk, and stays a cheat read. */
  it("colours the other long-odds report red", () => {
    expect(render([[perfectOvermasteries()], [], [], []]).current.legalityColor).toBe("red");
  });

  it("leaves a clean player uncoloured", () => {
    expect(render([[], [], [], []]).current.legalityColor).toBeUndefined();
  });

  it("reads the findings of the player's own party slot, not the first", () => {
    const other = { index: 9, partyIndex: 1 } as ComputedPlayerState;
    const party = [{ actorIndex: 7 } as PlayerData, { actorIndex: 9 } as PlayerData, null, null];
    const legality = [[finding()], [], [], []];

    const clean = renderHook(() => usePlayerRow(true, other, party, legality)).result;
    expect(clean.current.legalityColor).toBeUndefined();
  });

  /** The setting exists because a coloured name in an always-on-top overlay is
   * a public accusation. Off means off. */
  it("shows nothing when the user has turned the highlight off", () => {
    act(() => {
      useMeterSettingsStore.setState({ highlight_illegal_builds: false });
    });
    expect(render([[finding()], [], [], []]).current.legalityColor).toBeUndefined();
  });

  /** The app-wide switch is the master: with flagged builds hidden everywhere,
   * the meter's own highlight setting cannot put one back on screen. */
  it("shows nothing when flagged builds are hidden app-wide, whatever the meter setting says", () => {
    act(() => {
      useMeterSettingsStore.setState({ show_flagged_builds: false, highlight_illegal_builds: true });
    });
    expect(render([[finding()], [], [], []]).current.legalityColor).toBeUndefined();
  });

  /** Streamer mode already hides names; colouring one would put an accusation
   * on stream that the user explicitly asked to keep off it. */
  it("shows nothing in streamer mode even with the highlight on", () => {
    act(() => {
      useMeterSettingsStore.setState({ streamer_mode: true });
    });
    expect(render([[finding()], [], [], []]).current.legalityColor).toBeUndefined();
  });

  /** A caller with no legality data at all (an old log, a fight before the
   * first party update) must not throw or colour anything. */
  it("is silent when no findings were supplied", () => {
    expect(renderHook(() => usePlayerRow(true, player, partyData)).result.current.legalityColor).toBeUndefined();
  });
});
