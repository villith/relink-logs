import { abilityKey, supplementaryCause } from "@/pages/logs/view/abilityKey";
import type { ExplainHit } from "@/pages/logs/view/events/capExplain";
import type { ActionType, LogEvent } from "@/types";

/** One damage event, projected to what the cap debugger browses and explains.
 *
 * `eventIndex` is the position in the RAW stream, not in the filtered list: it
 * is how a hit is named in the UI and how a finding is quoted back at a log, so
 * it must not shift when the character filter changes. */
export type CapDebugHit = {
  eventIndex: number;
  timeMs: number;
  /** The acting player — the source's PARENT index, so a summon's hit is
   * attributed to whoever called it. That is the key the cap-up record, the
   * stored loadout and the ladder's character are all held under. */
  sourceIndex: number;
  targetIndex: number;
  actionId: ActionType;
  abilityKey: string;
  hit: ExplainHit;
};

/** Every damage event in the stream, in order. Nothing is filtered out — a hit
 * the explanation cannot decode is exactly the hit worth looking at, and
 * dropping it here would leave a pre-capture log looking empty. */
export const damageHits = (events: LogEvent[]): CapDebugHit[] => {
  const hits: CapDebugHit[] = [];
  events.forEach(([timeMs, payload], eventIndex) => {
    if (!("DamageEvent" in payload)) return;
    const event = payload.DamageEvent;
    hits.push({
      eventIndex,
      timeMs,
      sourceIndex: event.source.parent_index,
      targetIndex: event.target.index,
      actionId: event.action_id,
      abilityKey: abilityKey(event.action_id),
      hit: {
        damage: event.damage,
        damage_cap: event.damage_cap,
        base_damage: event.base_damage,
        attack_rate: event.attack_rate,
        class_flags: event.class_flags,
        flags: event.flags,
      },
    });
  });
  return hits;
};

/**
 * The damage hits worth stepping through, which is every one except the
 * supplementary echoes.
 *
 * An echo is a fixed ratio off a hit that is already in this list (see
 * `f32@0x154`, the readable echo ratio), so it has no cap derivation of its own
 * to walk — it only pads the list between the hits that do. Filtered from the
 * LIST and not renumbered: `eventIndex` still addresses the same event in the
 * stored stream, so a hit quoted from here can be found again.
 */
export const browsableHits = (events: LogEvent[]): CapDebugHit[] =>
  damageHits(events).filter((hit) => supplementaryCause(hit.abilityKey) === null);

/** How a hit names itself in the list and in the panel header. The stream
 * position leads, because it is the only part that is unique. */
export const hitLabel = (hit: CapDebugHit, name: string): string => `#${hit.eventIndex} ${name}`;
