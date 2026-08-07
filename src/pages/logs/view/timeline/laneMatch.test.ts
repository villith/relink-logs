import { describe, expect, it } from "vitest";

import type { EventRow } from "../events/eventRows";
import type { MetricRow } from "../metrics/types";

import type { SkillRow } from "@/types";

import { abilityRowKey, rowKeyingFor } from "../abilitySkills";

import { laneMatcherFor, type LaneMatchContext } from "./laneMatch";

const event = (over: Partial<EventRow>): EventRow => ({
  timeMs: 0,
  kind: "damage",
  sourceIndex: null,
  targetIndex: null,
  targetSpace: "actor",
  abilityKey: null,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: null,
  ...over,
});

const metricRow = (over: Partial<MetricRow>): MetricRow => ({
  key: "",
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
  ...over,
});

/** Segment 0 is the boss for the whole fight; segment 1 is a second spawn that
 * REUSES actor index 900 later on — the reissued-index case the parser learned
 * the expensive way. */
const CTX: LaneMatchContext = {
  everySkill: [],
  end: "source",
  segmentAt: (index, atMs) => (index !== 900 ? -1 : atMs < 5000 ? 0 : 1),
  enemyTypeAt: (index, atMs) => (index !== 900 ? null : atMs < 5000 ? "Wilinus" : "Vrazarek"),
};

describe("laneMatcherFor", () => {
  describe("ability lanes", () => {
    // A folded skill-group row claims every raw action behind it, through the
    // SAME expansion `eventPins.abilityKeys` uses — so a lane and the pin made
    // by clicking it can never disagree about what the row contains.
    it("claims an event by the raw action its lane expands to", () => {
      const rows = [metricRow({ key: "skill:Normal:100", label: "Normal:100", kind: "ability" })];
      const matcher = laneMatcherFor(rows, CTX);
      expect(matcher.laneOf(event({ abilityKey: "Normal:100" }))).toBe("skill:Normal:100");
    });

    // 9001 is deliberately an id no shipped skill group claims, so the row key
    // is the raw action and these cases turn only on the collapse keying.
    const ECHO_AND_CAUSE: SkillRow[] = [
      { actionType: { Normal: 9001 }, childCharacterType: "Pl1900" },
      { actionType: { SupplementaryDamage: 9001 }, childCharacterType: "Pl1900" },
    ];

    /** The cause's lane, keyed exactly as the table would key it. */
    const causeLane = (keying: ReturnType<typeof rowKeyingFor>) => {
      const rowKey = abilityRowKey(ECHO_AND_CAUSE[0], keying);
      const rows = [metricRow({ key: `skill:${rowKey}`, label: rowKey, kind: "ability" })];
      return { rows, matcher: laneMatcherFor(rows, { ...CTX, everySkill: ECHO_AND_CAUSE, keying }) };
    };

    it("puts an echo on its cause's lane when collapsing", () => {
      const { rows, matcher } = causeLane(rowKeyingFor(ECHO_AND_CAUSE, true));
      expect(matcher.laneOf(event({ abilityKey: "SupplementaryDamage:9001" }))).toBe(rows[0].key);
    });

    it("leaves an echo off the cause's lane without collapsing", () => {
      const { matcher } = causeLane(rowKeyingFor(ECHO_AND_CAUSE, false));
      expect(matcher.laneOf(event({ abilityKey: "SupplementaryDamage:9001" }))).toBeNull();
    });

    it("answers null for an action no lane expands to", () => {
      const rows = [metricRow({ key: "skill:Normal:100", label: "Normal:100", kind: "ability" })];
      const matcher = laneMatcherFor(rows, CTX);
      expect(matcher.laneOf(event({ abilityKey: "Normal:999" }))).toBeNull();
    });

    it("answers null for an event that names no ability at all", () => {
      const rows = [metricRow({ key: "skill:Normal:100", label: "Normal:100", kind: "ability" })];
      const matcher = laneMatcherFor(rows, CTX);
      expect(matcher.laneOf(event({ abilityKey: null, kind: "stun", sourceIndex: 0 }))).toBeNull();
    });
  });

  describe("player lanes", () => {
    it("claims an event by the end the metric is keyed on", () => {
      const rows = [metricRow({ key: "player:2", label: "2", kind: "player" })];
      const dealt = laneMatcherFor(rows, CTX);
      expect(dealt.laneOf(event({ sourceIndex: 2, targetIndex: 900 }))).toBe("player:2");

      // Damage TAKEN keys its player lanes by the victim, not the attacker.
      const taken = laneMatcherFor(rows, { ...CTX, end: "target" });
      expect(taken.laneOf(event({ sourceIndex: 900, targetIndex: 2 }))).toBe("player:2");
      expect(taken.laneOf(event({ sourceIndex: 2, targetIndex: 900 }))).toBeNull();
    });
  });

  describe("spawn lanes", () => {
    // The game reissues a dead boss's actor index to a later spawn, so the
    // moment of the event is what separates the two.
    it("resolves a reissued actor index by the moment of the event", () => {
      const rows = [
        metricRow({ key: "target:0", label: "target:0", kind: "target" }),
        metricRow({ key: "target:1", label: "target:1", kind: "target" }),
      ];
      const matcher = laneMatcherFor(rows, { ...CTX, end: "target" });
      expect(matcher.laneOf(event({ targetIndex: 900, timeMs: 1000 }))).toBe("target:0");
      expect(matcher.laneOf(event({ targetIndex: 900, timeMs: 9000 }))).toBe("target:1");
    });
  });

  describe("taken-attack lanes", () => {
    // A `taken:` row is keyed by enemy TYPE plus action id, while the event
    // carries an actor index — so the type has to be resolved at that moment.
    it("claims a hit by its attacker's type and action", () => {
      const label = JSON.stringify({ enemyType: "Wilinus", actionId: { Normal: 42 } });
      const rows = [metricRow({ key: `taken:${label}`, label, kind: "takenAttack" })];
      const matcher = laneMatcherFor(rows, CTX);
      expect(matcher.laneOf(event({ sourceIndex: 900, timeMs: 1000, abilityKey: "Normal:42" }))).toBe(`taken:${label}`);
      // Same action id, different attacker after the index was reissued.
      expect(matcher.laneOf(event({ sourceIndex: 900, timeMs: 9000, abilityKey: "Normal:42" }))).toBeNull();
    });
  });

  // Stun grouped by ability: `OnPlayerStun` carries no action id, so nothing
  // can be placed. An empty lane is the honest answer; a guess is not.
  it("claims nothing for a row kind it cannot key", () => {
    const rows = [metricRow({ key: 'enemy:"Wilinus"', label: '"Wilinus"', kind: "enemy" })];
    const matcher = laneMatcherFor(rows, CTX);
    expect(matcher.laneOf(event({ sourceIndex: 0, abilityKey: "Normal:100" }))).toBeNull();
  });

  it("claims nothing when there are no rows", () => {
    expect(laneMatcherFor([], CTX).laneOf(event({ abilityKey: "Normal:100" }))).toBeNull();
  });
});
