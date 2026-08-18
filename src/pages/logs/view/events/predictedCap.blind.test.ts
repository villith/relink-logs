import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ActionType, CharacterType } from "@/types";

import { PREDICTED_CAP_DENYLIST, capPredictableKey, selectCapUp, type PlayerCapUp } from "./capBreakdown";
import { deriveChannelBreakdown } from "./capFactors";
import { conditionsForHit } from "./capFactors/conditions";
import { gameLadderBase, isSummonClass, ladderCurveFor } from "./capLadder";
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

    // Evaluate first, score second: a level-sync quest clamps every account
    // store below its captured value, so predictions overshoot for EVERY
    // character in that log (2622 read as "Seofon ~5x" until this pass).
    // Unmodeled terms are additive — a legitimate steady-state miss can only
    // undershoot — so a log whose MEDIAN hit overshoots is contaminated and
    // is dropped whole, never read as per-character model drift.
    type Evaluated = {
      log: number;
      characterType: string;
      predicted: number;
      cap: number;
      unresolved: number;
      ladderBase: number;
    };
    const evaluated: Evaluated[] = [];
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
          // The dump predates the raw term-bits probe and `conditionsForHit`
          // never reads it — null is the honest stand-in, not a claim.
          source_statuses: line.sourceStatuses?.map((status) => ({ ...status, term_bits: null })) ?? null,
        },
        null,
        line.action
      );
      const capClass = capClassOf(line.classFlags);
      const channel = deriveChannelBreakdown(player.loadout, capClass, conditions);
      // The card's own branch: a summon-class hit predicts the bare ladder
      // base — the multiplier terms are the attacker's, and the summon actor
      // has none. No unresolved potentials either, for the same reason.
      const summon = isSummonClass(line.classFlags);
      const predicted = summon
        ? Math.trunc(ladderBase)
        : Math.trunc(ladderBase * (1 + record + dmgCapTraitValue(player.loadout, capClass) + channel.active));
      evaluated.push({
        log: line.log,
        characterType,
        predicted,
        cap: line.cap,
        unresolved: summon ? 0 : channel.unresolved,
        ladderBase,
      });
    }

    const ratiosByLog = new Map<number, number[]>();
    for (const hit of evaluated) {
      const ratios = ratiosByLog.get(hit.log) ?? [];
      ratios.push(hit.cap / hit.predicted);
      ratiosByLog.set(hit.log, ratios);
    }
    const synced = new Set<number>();
    for (const [log, ratios] of ratiosByLog) {
      const median = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
      if (median < 0.9) synced.add(log);
    }
    if (synced.size > 0) {
      // eslint-disable-next-line no-console -- a sweep exists to be read
      console.log(`dropped as level-sync contaminated: logs ${[...synced].sort((a, b) => a - b).join(", ")}`);
    }

    // per character: [hits, exact, open-channel, mismatched]
    const byCharacter = new Map<string, [number, number, number, number]>();
    // Relative undershoot of every mismatched hit, per character — the size of
    // the error the card's ≈ stands for where the model has known gaps.
    const missSizes = new Map<string, number[]>();
    let considered = 0;
    let exact = 0;
    let open = 0;

    for (const hit of evaluated) {
      if (synced.has(hit.log)) continue;
      const { characterType, predicted, cap, unresolved, ladderBase } = hit;

      considered += 1;
      const stats = byCharacter.get(characterType) ?? [0, 0, 0, 0];
      stats[0] += 1;
      const miss = cap - predicted;
      // ±1 absorbs the f32-sum drift the measured card's grid check also allows.
      if (Math.abs(miss) <= 1) {
        exact += 1;
        stats[1] += 1;
      } else if (miss > 1 && miss <= unresolved * ladderBase + 1) {
        // An open channel factor that COULD cover this miss: the prediction
        // knowingly undershoots and its card carries the Unresolved row. An
        // unresolved potential is an additive positive, so it can only ever
        // excuse an UNDERSHOOT, and only up to unresolved × base — anything
        // else is a genuine miss and must feed the error bars below.
        open += 1;
        stats[2] += 1;
      } else {
        stats[3] += 1;
        const sizes = missSizes.get(characterType) ?? [];
        sizes.push(miss / cap);
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
    //    100% exact. This assumes a corpus-scale fixture; a single-log fixture
    //    without a complete-model character fails here by design, because it
    //    cannot prove the wiring.
    expect(
      [...byCharacter.values()].some(([hits, hitExact]) => hits >= 500 && hitExact === hits),
      "no character with >=500 hits is 100% exact — wiring unproven for this fixture"
    ).toBe(true);
    // 2. DIRECTION: unmodeled terms are additive, so a steady-state mismatch
    //    may only ever UNDERSHOOT. Transient overshoots exist — a state buff
    //    dropping eases the game's cap DOWN over ~1.3s while the prediction
    //    stays at the resting value — but they must stay BOTH a small minority
    //    AND easing-sized: an ease can traverse at most the dropped terms'
    //    share of the multiplier, i.e. percent scale. A factor-scale overshoot
    //    (>50%) is never easing — it is a wrong ladder row or a missing
    //    formula branch (that ceiling is what exposed the summon path, which
    //    the ~5x-per-hit "Zeta transients" turned out to be). A character that
    //    overshoots systematically belongs on PREDICTED_CAP_DENYLIST — unless
    //    the overshoot is log-wide, which is level-sync contamination and is
    //    dropped by the guard above (what cleared Seofon's phantom ~5x).
    for (const [character, sizes] of missSizes) {
      const overshoots = sizes.filter((size) => size < 0);
      const hits = byCharacter.get(character)![0];
      expect(overshoots.length / hits, `${character} overshoots on ${overshoots.length}/${hits} hits`).toBeLessThan(
        0.1
      );
      const worst = Math.min(0, ...overshoots);
      expect(-worst, `${character} worst overshoot ${(-worst * 100).toFixed(1)}% of the logged cap`).toBeLessThan(0.5);
    }
  });
});

// Keeps the file green (and visible) in the normal suite run.
it.skipIf(fixture !== undefined)("blind sweep skipped without CAP_BLIND_FIXTURE", () => {
  expect(capPredictableKey("Normal:1")).toBe(true);
});
