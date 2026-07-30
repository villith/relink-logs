import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, LegalityFinding, PlayerData } from "@/types";

import { usePlayerRow } from "./usePlayerRow";

const finding = (severity: LegalityFinding["severity"]): LegalityFinding => ({
  rule: severity === "impossible" ? "summonBonusMagnitude" : "summonPerfectCount",
  severity,
  subject: { kind: "summon", index: 0 },
  observed: { kind: "amount", value: 75 },
  allowed: { kind: "amount", value: 50 },
  odds: null,
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
      useMeterSettingsStore.setState({ highlight_illegal_builds: true, streamer_mode: false });
    });
  });

  it("colours a player whose build cannot come from the game", () => {
    expect(render([[finding("impossible")], [], [], []]).current.legalityColor).toBe("red");
  });

  it("colours a merely improbable build differently, never the same", () => {
    expect(render([[finding("improbable")], [], [], []]).current.legalityColor).toBe("yellow");
  });

  it("leaves a clean player uncoloured", () => {
    expect(render([[], [], [], []]).current.legalityColor).toBeUndefined();
  });

  it("reads the findings of the player's own party slot, not the first", () => {
    const other = { index: 9, partyIndex: 1 } as ComputedPlayerState;
    const party = [{ actorIndex: 7 } as PlayerData, { actorIndex: 9 } as PlayerData, null, null];
    const legality = [[finding("impossible")], [], [], []];

    const clean = renderHook(() => usePlayerRow(true, other, party, legality)).result;
    expect(clean.current.legalityColor).toBeUndefined();
  });

  /** The setting exists because a coloured name in an always-on-top overlay is
   * a public accusation. Off means off. */
  it("shows nothing when the user has turned the highlight off", () => {
    act(() => {
      useMeterSettingsStore.setState({ highlight_illegal_builds: false });
    });
    expect(render([[finding("impossible")], [], [], []]).current.legalityColor).toBeUndefined();
  });

  /** Streamer mode already hides names; colouring one would put an accusation
   * on stream that the user explicitly asked to keep off it. */
  it("shows nothing in streamer mode even with the highlight on", () => {
    act(() => {
      useMeterSettingsStore.setState({ streamer_mode: true });
    });
    expect(render([[finding("impossible")], [], [], []]).current.legalityColor).toBeUndefined();
  });

  /** A caller with no legality data at all (an old log, a fight before the
   * first party update) must not throw or colour anything. */
  it("is silent when no findings were supplied", () => {
    expect(renderHook(() => usePlayerRow(true, player, partyData)).result.current.legalityColor).toBeUndefined();
  });
});
