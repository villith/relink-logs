/**
 * Stats-only damage-cap prediction probe: how much of a player's per-hit cap
 * is derivable from their STORED loadout alone — no hook-captured record
 * totals.
 *
 * ## Why
 *
 * The hover-card breakdown anchors on two captured record values (`capUp*`,
 * `limitBonusCap*`) that only a LOCAL account can vouch for. A remote player
 * transmits their equipment (sigils, weapon, overmasteries, summons,
 * skillboard) but not their account's Mastery store or board grants. This
 * probe measures, on a player where BOTH sides are known, exactly how far
 * equipment-only prediction lands from the game's real per-hit K — that gap
 * IS the error bar a remote breakdown has to carry.
 *
 * It deliberately REUSES the shipped model (`collectCapFactors`,
 * `evaluateCapFactors`, the f32 ladder mirror) instead of re-deriving it:
 * factors of kind `account` are the captured-record slice and are EXCLUDED
 * from the prediction, then reported separately so the remainder after
 * account is visible too. Per hit, the factor set is evaluated under that
 * hit's own conditions (action id, HP, the status snapshot) — everything a
 * remote's hits also carry.
 *
 * ## Run (skipped entirely unless CAP_EVIDENCE is set, so `npm run test`
 * never depends on a local logs.db)
 *
 *   cargo run --release -p gbfr-logs --example cap_evidence -- --log 2612 --log 2617 > evidence.json
 *   CAP_EVIDENCE=evidence.json [CAP_CHARACTER=Pl2700] npx vitest run scripts/cap-stats-only.test.ts
 *
 * Output, per (log, player, attack class): the per-hit offset histogram
 * (offset = observed K − stats-only K; a constant offset means "predictable
 * up to one account-shaped number"), the captured account slice for
 * reference, what remains after it, and the factors that stayed unresolved
 * for want of a condition.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  collectCapFactors,
  evaluateCapFactors,
  type CapConditions,
  type CapFactorRow,
} from "@/pages/logs/view/events/capFactors";
import { capConsistent, gameLadderBase, ladderCurveFor } from "@/pages/logs/view/events/capLadder";
import { capClassOf, type CapClass, type CapLoadout } from "@/pages/logs/view/events/capSources";
import type { CharacterType } from "@/types";

type EvidenceHit = {
  t: number;
  actor: number;
  action: number;
  cap: number;
  rate: number;
  classFlags: number;
  summon: boolean;
  hp: number | null;
  maxHp: number | null;
  statuses: { statusId: number; stacks: number }[] | null;
};

type EvidencePlayer = CapLoadout & {
  actorIndex: number;
  characterType: CharacterType;
  displayName: string;
  isOnline: boolean;
};

type Evidence = { logs: { id: number; players: (EvidencePlayer | null)[]; hits: EvidenceHit[] }[] };

const CLASSES: CapClass[] = ["normal", "skill", "sba"];

/** The stats-only slice of an evaluated factor set: everything except the
 * captured-account rows a remote cannot provide. */
const statsOnlyRows = (rows: CapFactorRow[]): CapFactorRow[] =>
  rows.filter(({ factor }) => factor.kind !== "account");

const EVIDENCE = process.env.CAP_EVIDENCE;
const ONLY_CHARACTER = process.env.CAP_CHARACTER ?? null;

describe.skipIf(!EVIDENCE)("stats-only cap prediction", () => {
  it("scores every loadout-carrying player against their on-grid hits", () => {
    let scoredPlayers = 0;
    for (const path of (EVIDENCE as string).split(";")) {
      const evidence: Evidence = JSON.parse(readFileSync(path, "utf-8"));
      for (const log of evidence.logs) {
        const players = new Map<number, EvidencePlayer>();
        for (const player of log.players) {
          if (player) players.set(player.actorIndex, player);
        }

        for (const [actor, player] of players) {
          if (ONLY_CHARACTER !== null && player.characterType !== ONLY_CHARACTER) continue;

          const perClass = new Map<CapClass, Map<number, number>>(CLASSES.map((c) => [c, new Map()]));
          const unresolvedByClass = new Map<CapClass, Map<string, number>>(CLASSES.map((c) => [c, new Map()]));
          const accountByClass = new Map<CapClass, number>();
          let offGrid = 0;
          let summonHits = 0;
          let noBase = 0;
          let total = 0;

          const factorsByClass = new Map(
            CLASSES.map((capClass) => [capClass, collectCapFactors({ loadout: player, capClass })])
          );

          for (const hit of log.hits) {
            if (hit.actor !== actor) continue;
            total += 1;
            if (hit.summon) {
              // A summon-curve hit caps on the summon's own record, not the
              // player's conditional set — out of scope for a loadout prediction.
              summonHits += 1;
              continue;
            }
            const capClass = capClassOf(hit.classFlags);
            if (capClass === null) continue;
            const curve = ladderCurveFor(player.characterType, hit.classFlags);
            const base = curve === null ? 0 : gameLadderBase(curve, hit.rate);
            if (base <= 0) {
              noBase += 1;
              continue;
            }
            if (!capConsistent(hit.cap, base)) {
              // Off-grid hits (eased state terms, half-percent builds) are the
              // residual scan's subject, not this one's — counted, not scored.
              offGrid += 1;
              continue;
            }
            const observedK = Math.round((100 * hit.cap) / base);

            const conditions: CapConditions = { actionId: hit.action };
            if (hit.hp !== null && hit.maxHp !== null && hit.maxHp > 0) {
              conditions.hp = hit.hp;
              conditions.maxHp = hit.maxHp;
              conditions.hpRatio = hit.hp / hit.maxHp;
            }
            if (hit.statuses !== null) {
              conditions.buffs = hit.statuses.map((s) => s.statusId);
              conditions.stacks = Object.fromEntries(hit.statuses.map((s) => [s.statusId, s.stacks]));
            }

            const totals = evaluateCapFactors(factorsByClass.get(capClass) ?? [], conditions);
            let predicted = 100;
            for (const { factor, result } of statsOnlyRows(totals.rows)) {
              if (result.state === "active") predicted += result.percent;
              if (result.state === "unknown" && result.potential > 0) {
                unresolvedByClass.get(capClass)?.set(`${factor.kind}:${factor.key}`, result.potential);
              }
            }
            let account = 0;
            for (const { factor, result } of totals.rows) {
              if (factor.kind === "account" && result.state === "active") account += result.percent;
            }
            accountByClass.set(capClass, account);

            const offset = observedK - Math.round(predicted);
            const offsets = perClass.get(capClass);
            offsets?.set(offset, (offsets.get(offset) ?? 0) + 1);
          }

          if (total === 0) continue;
          scoredPlayers += 1;
          const who = `${player.characterType}${player.displayName ? ` "${player.displayName}"` : " (AI)"}${
            player.isOnline ? " [remote]" : " [local]"
          }`;
          console.log(`\nlog ${log.id} actor 0x${actor.toString(16)} ${who}: ${total} hits`);
          if (summonHits + offGrid + noBase > 0) {
            console.log(`  skipped: ${summonHits} summon-curve, ${offGrid} off-grid, ${noBase} without a base`);
          }
          for (const capClass of CLASSES) {
            const offsets = perClass.get(capClass);
            if (offsets === undefined || offsets.size === 0) continue;
            const n = [...offsets.values()].reduce((a, b) => a + b, 0);
            const sorted = [...offsets.entries()].sort((a, b) => b[1] - a[1]);
            const [modalOffset, modalCount] = sorted[0];
            const account = accountByClass.get(capClass) ?? 0;
            const sign = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
            console.log(
              `  ${capClass}: ${n} on-grid hits | stats-only offset ${sign(modalOffset)} on ${modalCount}/${n} ` +
                `(${((modalCount / n) * 100).toFixed(1)}%) | captured account ${account} | ` +
                `after account ${sign(modalOffset - account)}`
            );
            const rest = sorted.slice(1, 6).map(([offset, count]) => `${sign(offset)}x${count}`);
            if (rest.length > 0) console.log(`      other offsets: ${rest.join(" ")}`);
            const unresolved = unresolvedByClass.get(capClass);
            if (unresolved && unresolved.size > 0) {
              const rows = [...unresolved.entries()].map(([key, potential]) => `${key} (≤${potential})`);
              console.log(`      unresolved stats factors: ${rows.join(", ")}`);
            }
          }
        }
      }
    }
    expect(scoredPlayers).toBeGreaterThan(0);
  });
});
