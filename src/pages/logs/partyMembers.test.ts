import { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import { Log } from "@/types";

import { partyMembers } from "./partyMembers";

/** Translation is not what these assertions are about — the slot arithmetic
 * and the label's shape are. i18next is not initialised under vitest, so the
 * real lookup would yield `undefined` and every label would read the same. */
vi.mock("@/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils")>()),
  translateCharacterType: (characterType: string) => `characters:${characterType}`,
}));

const t = ((key: string) => key) as unknown as TFunction;

const log = (fields: Partial<Log>): Log =>
  ({
    id: 1,
    name: "",
    time: 0,
    duration: 0,
    version: 1,
    primaryTarget: null,
    p1Name: null,
    p1Type: null,
    p2Name: null,
    p2Type: null,
    p3Name: null,
    p3Type: null,
    p4Name: null,
    p4Type: null,
    questId: null,
    questElapsedTime: null,
    questCompleted: true,
    ...fields,
  }) as Log;

const shown = { showDisplayNames: true, streamerMode: false, t };

describe("partyMembers", () => {
  /** The whole point of the slot number: it indexes the same party slot the
   * backend stamped its verdicts with, so a finding can be attributed to the
   * person it was computed from rather than to whoever is listed first. */
  it("numbers each member by its own party slot, zero-based", () => {
    const members = partyMembers(
      log({
        p1Name: "Kahs",
        p1Type: "Pl1400",
        p2Name: "Manmoth",
        p2Type: "Pl1300",
        p3Name: "炎顺帝",
        p3Type: "Pl1600",
        p4Name: "Rin",
        p4Type: "Pl1000",
      }),
      shown
    );

    expect(members.map((member) => member.slot)).toEqual([0, 1, 2, 3]);
  });

  /** An empty slot drops out of the list but must NOT renumber the ones after
   * it. A three-person party with slot 0 empty would otherwise colour the
   * wrong player. */
  it("keeps the true slot of each member when earlier slots are empty", () => {
    const members = partyMembers(log({ p3Name: "Kahs", p3Type: "Pl1400", p4Name: null, p4Type: "Pl1000" }), shown);

    expect(members.map((member) => member.slot)).toEqual([2, 3]);
  });

  it("labels a named player as character and name", () => {
    const [member] = partyMembers(log({ p1Name: "Kahs", p1Type: "Pl1400" }), shown);

    expect(member.label).toBe("characters:Pl1400 (Kahs)");
  });

  /** A slot with a character but no player name is an AI companion. */
  it("marks a slot with no player name as an AI companion", () => {
    const [member] = partyMembers(log({ p1Type: "Pl1400" }), shown);

    expect(member.label).toBe("characters:Pl1400 (ui.logs.ai-companion)");
  });

  /** In an imported log a nameless slot may be a backfilled character whose
   * player name was simply never recorded — calling it an AI companion would
   * be a guess, so the bare character is all that is claimed. */
  it("does not call a nameless slot an AI companion in an imported log", () => {
    const [member] = partyMembers(log({ p1Type: "Pl1400", imported: true }), shown);

    expect(member.label).toBe("characters:Pl1400");
  });

  it("drops the name when names are hidden, and under streamer mode", () => {
    const entry = log({ p1Name: "Kahs", p1Type: "Pl1400" });

    expect(partyMembers(entry, { ...shown, showDisplayNames: false })[0].label).toBe("characters:Pl1400");
    expect(partyMembers(entry, { ...shown, streamerMode: true })[0].label).toBe("characters:Pl1400");
  });

  /** Legacy logs stored one comma-joined name string and no slots at all, so
   * there is nothing to attribute a finding to. `null` says so — it is never
   * an index, so it can never match one. */
  it("gives legacy version-0 logs no slot to attribute a finding to", () => {
    const members = partyMembers(log({ version: 0, name: "Pl1400, Pl1300" }), shown);

    expect(members.map((member) => member.slot)).toEqual([null, null]);
    expect(members.map((member) => member.label)).toEqual(["characters:Pl1400", "characters:Pl1300"]);
  });

  it("has nothing to show for a log with no party at all", () => {
    expect(partyMembers(log({}), shown)).toEqual([]);
  });
});
