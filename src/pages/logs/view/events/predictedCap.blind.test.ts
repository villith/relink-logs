import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ActionType, CharacterType } from "@/types";

import { PREDICTED_CAP_DENYLIST, capPredictableKey, selectCapUp, type PlayerCapUp } from "./capBreakdown";
import { deriveChannelBreakdown } from "./capFactors";
import { conditionsForHit } from "./capFactors/conditions";
import { gameLadderBase, ladderCurveFor } from "./capLadder";
import { capClassOf, dmgCapTraitValue, type CapLoadout } from "./capSources";

/** Manual sweep, not part of the suite: set CAP_BLIND_FIXTURE to the JSONL
 * `cap_predict_dump` wrote. Validates the production prediction arithmetic
 * against ground truth by predicting LOCAL hits blind — the caps the game
 * actually logged are the answer key the remote card never has. */
const fixture = process.env.CAP_BLIND_FIXTURE;

type PlayerLine = {
  t: "player";
  log: number;
  actor: number;
  capUp: PlayerCapUp;
  loadout: CapLoadout & { characterType?: CharacterType };
};
type HitLine = {
  t: "hit";
  log: number;
  actor: number;
  action: ActionType;
  rate: number;
  classFlags: number;
  cap: number;
  sourceCurrentHp: number | null;
  sourceMaxHp: number | null;
  sourceStatuses: { status_id: number; stacks: number }[] | null;
};

describe.skipIf(fixture === undefined)("blind local prediction sweep", () => {
  it("matches the logged cap on formula-resolved hits", () => {
    const lines = readFileSync(fixture!, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as PlayerLine | HitLine);

    const players = new Map<string, PlayerLine>();
    for (const line of lines) if (line.t === "player") players.set(`${line.log}:${line.actor}`, line);

    // per character: [hits, exact, open-channel, mismatched]
    const byCharacter = new Map<string, [number, number, number, number]>();
    // Relative undershoot of every mismatched hit, per character — the size of
    // the error the card's ≈ stands for where the model has known gaps.
    const missSizes = new Map<string, number[]>();
    let considered = 0;
    let exact = 0;
    let open = 0;

    for (const line of lines) {
      if (line.t !== "hit") continue;
      const player = players.get(`${line.log}:${line.actor}`);
      if (player === undefined) continue;
      const characterType = player.loadout.characterType;
      // The union's `{ Unknown: n }` arm has no ladder and no denylist row —
      // narrowing to string is the same "named character" gate the card uses.
      if (typeof characterType !== "string" || PREDICTED_CAP_DENYLIST.has(characterType)) continue;
      const record = selectCapUp(player.capUp, line.classFlags);
      const curve = ladderCurveFor(characterType, line.classFlags);
      if (record === null || curve === null) continue;
      const ladderBase = gameLadderBase(curve, line.rate);
      if (ladderBase <= 0) continue;

      const conditions = conditionsForHit(
        {
          source_current_hp: line.sourceCurrentHp,
          source_max_hp: line.sourceMaxHp,
          source_statuses: line.sourceStatuses,
        },
        null,
        line.action
      );
      const capClass = capClassOf(line.classFlags);
      const channel = deriveChannelBreakdown(player.loadout, capClass, conditions);
      const predicted = Math.trunc(
        ladderBase * (1 + record + dmgCapTraitValue(player.loadout, capClass) + channel.active)
      );

      considered += 1;
      const stats = byCharacter.get(characterType) ?? [0, 0, 0, 0];
      stats[0] += 1;
      // ±1 absorbs the f32-sum drift the measured card's grid check also allows.
      if (Math.abs(predicted - line.cap) <= 1) {
        exact += 1;
        stats[1] += 1;
      } else if (channel.unresolved > 0) {
        // An open channel factor: the prediction knowingly undershoots and its
        // card would carry the Unresolved row. Not a failure of the formula.
        open += 1;
        stats[2] += 1;
      } else {
        stats[3] += 1;
        const sizes = missSizes.get(characterType) ?? [];
        sizes.push((line.cap - predicted) / line.cap);
        missSizes.set(characterType, sizes);
      }
      byCharacter.set(characterType, stats);
    }

    const percentile = (sorted: number[], p: number): number => sorted[Math.floor(p * (sorted.length - 1))];
    for (const [character, [hits, hitExact, hitOpen, mismatch]] of [...byCharacter].sort()) {
      const sizes = (missSizes.get(character) ?? []).sort((a, b) => a - b);
      const spread =
        sizes.length === 0
          ? ""
          : `, miss p50 ${(percentile(sizes, 0.5) * 100).toFixed(1)}% p95 ${(percentile(sizes, 0.95) * 100).toFixed(1)}%`;
      // eslint-disable-next-line no-console -- a sweep exists to be read
      console.log(
        `${character}: ${hits} hits, ${hitExact} exact, ${hitOpen} open-channel, ${mismatch} mismatched${spread}`
      );
    }
    // eslint-disable-next-line no-console -- a sweep exists to be read
    console.log(`total: ${considered} considered, ${exact} exact, ${open} open-channel`);

    expect(considered).toBeGreaterThan(0);
    // The sweep guarantees two things; the printout is the error bar itself.
    // 1. WIRING: where the factor model is complete, the arithmetic reproduces
    //    the game's cap exactly — at least one well-sampled character must be
    //    100% exact.
    expect([...byCharacter.values()].some(([hits, hitExact]) => hits >= 500 && hitExact === hits)).toBe(true);
    // 2. DIRECTION: unmodeled terms are additive, so a steady-state mismatch
    //    may only ever UNDERSHOOT. Transient overshoots exist — a state buff
    //    dropping eases the game's cap DOWN over ~1.3s while the prediction
    //    stays at the resting value — but they must stay a small minority. A
    //    character that overshoots systematically (Seofon: every hit, ~5x)
    //    belongs on PREDICTED_CAP_DENYLIST, not in the card.
    for (const [character, sizes] of missSizes) {
      const overshoots = sizes.filter((size) => size < 0).length;
      const hits = byCharacter.get(character)![0];
      expect(overshoots / hits, `${character} overshoots on ${overshoots}/${hits} hits`).toBeLessThan(0.1);
    }
  });
});

// Keeps the file green (and visible) in the normal suite run.
it.skipIf(fixture !== undefined)("blind sweep skipped without CAP_BLIND_FIXTURE", () => {
  expect(capPredictableKey("Normal:1")).toBe(true);
});
