import type { LogEvent } from "@/types";

import { abilityKey } from "../abilityKey";

/** What the colour coding and the kind toggles key on. */
export type EventKind = "damage" | "stun" | "perfectGuard" | "sba" | "sbaTick" | "death" | "status" | "other";

/** A projected event row. Null means "this kind has no such field" — never zero,
 * which would render as real data. */
export type EventRow = {
  timeMs: number;
  kind: EventKind;
  /** The acting actor, or null for a party-wide event that names none. */
  sourceIndex: number | null;
  targetIndex: number | null;
  /** The ability the row names, for rows that have one. */
  abilityKey: string | null;
  /** A translated descriptor for a row with no ability — the
   * `labelKey`/`labelParams` idiom `MetricRow` already uses. Rendered in the
   * Ability column, so the two are mutually exclusive. */
  detailKey: string | null;
  detailParams?: Record<string, number | string>;
  amount: number | null;
};

/** The `Message` variant tag. Externally tagged, so the payload is a one-key
 * object — the tag IS that key. */
const variantOf = (event: LogEvent): string => Object.keys(event[1])[0] ?? "";

/** Which kind each known variant belongs to. A lookup rather than a `switch`
 * with a `default`, so a variant appended to `Message` later lands in `other`
 * instead of silently inheriting whichever branch the default happened to be. */
const KIND_OF: Record<string, EventKind> = {
  DamageEvent: "damage",
  OnDeathEvent: "death",
  OnPlayerStun: "stun",
  OnStunEffect: "stun",
  OnPerfectGuardStun: "perfectGuard",
  OnPerfectGuardQuickening: "perfectGuard",
  OnAttemptSBA: "sba",
  OnPerformSBA: "sba",
  OnContinueSBAChain: "sba",
  // Gauge noise, both of them: OnUpdateSBA is a per-tick reading and SbaGain is
  // one event per damaging hit. 29% of a stored log is the former alone.
  OnUpdateSBA: "sbaTick",
  SbaGain: "sbaTick",
  StatusApply: "status",
  StatusRemove: "status",
};

export const eventKind = (event: LogEvent): EventKind => KIND_OF[variantOf(event)] ?? "other";

/** The translated line an ability-less row shows. */
const DETAIL_KEY: Record<string, string> = {
  OnDeathEvent: "ui.logs.events-died",
  OnAttemptSBA: "ui.logs.events-sba-attempt",
  OnPerformSBA: "ui.logs.events-sba-perform",
  OnContinueSBAChain: "ui.logs.events-sba-chain",
  OnPlayerStun: "ui.logs.events-stun-dealt",
  OnStunEffect: "ui.logs.events-stun-effect",
  OnPerfectGuardStun: "ui.logs.events-guard-stun",
  OnPerfectGuardQuickening: "ui.logs.events-guard-quickening",
  OnUpdateSBA: "ui.logs.events-sba-gauge",
  SbaGain: "ui.logs.events-sba-gain",
  StatusApply: "ui.logs.events-status-applied",
  StatusRemove: "ui.logs.events-status-removed",
};

/** The sentinel detail key: a variant this file has never heard of. */
const UNKNOWN_DETAIL_KEY = "ui.logs.events-unknown";

/** A number off a payload only when it really is one — an unknown variant's
 * field could be anything, and `undefined` renders as "undefined". */
const numberAt = (body: unknown, field: string): number | null => {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "number" ? value : null;
};

const rounded = (value: number | null): number | null => (value === null ? null : Math.round(value));

export const toEventRow = (event: LogEvent): EventRow => {
  const [timeMs, payload] = event;
  const kind = eventKind(event);
  const variant = variantOf(event);

  if ("DamageEvent" in payload) {
    const hit = payload.DamageEvent;
    return {
      timeMs,
      kind,
      // The PARENT actor, matching `SelectionFact.sourceIndex` — a summon's hit
      // belongs to the player who called it, and the source pin is in that same
      // index space, so a pin can only filter against the parent.
      sourceIndex: hit.source.parent_index,
      targetIndex: hit.target.index,
      abilityKey: abilityKey(hit.action_id),
      detailKey: null,
      amount: hit.damage,
    };
  }

  // Link Time names no actor and carries a direction instead of an amount.
  if ("LinkTime" in payload) {
    return {
      timeMs,
      kind,
      sourceIndex: null,
      targetIndex: null,
      abilityKey: null,
      detailKey: payload.LinkTime.active ? "ui.logs.events-link-start" : "ui.logs.events-link-end",
      amount: null,
    };
  }

  if ("EnemyMode" in payload) {
    return {
      timeMs,
      kind,
      sourceIndex: payload.EnemyMode.actor_index,
      targetIndex: null,
      abilityKey: null,
      detailKey: "ui.logs.events-enemy-mode",
      detailParams: { mode: payload.EnemyMode.mode },
      amount: null,
    };
  }

  const body: unknown = Object.values(payload)[0];
  const detailKey = DETAIL_KEY[variant] ?? UNKNOWN_DETAIL_KEY;
  return {
    timeMs,
    kind,
    sourceIndex: numberAt(body, "actor_index"),
    targetIndex: null,
    abilityKey: null,
    detailKey,
    // An unrecognised variant names itself, so a stored log never renders a
    // blank row the reader cannot account for.
    ...(detailKey === UNKNOWN_DETAIL_KEY ? { detailParams: { variant } } : {}),
    // The measure each kind carries, whichever field it spells it in. The first
    // three are f32 on the wire, so they round for the column; `stacks` is a
    // count and is already whole.
    amount:
      rounded(numberAt(body, "stun_amount")) ??
      rounded(numberAt(body, "sba_value")) ??
      rounded(numberAt(body, "amount")) ??
      numberAt(body, "stacks"),
  };
};

/** Every kind, in the order the toggles show them. The one list the toggle strip
 * and the colour map are both built from, so a kind cannot exist without a way
 * to turn it off. */
export const EVENT_KINDS: EventKind[] = [
  "damage",
  "stun",
  "perfectGuard",
  "sba",
  "death",
  "status",
  "other",
  "sbaTick",
];

/** Every kind except the gauge ticks, which are 29%-plus of a log and carry
 * nothing readable. One toggle brings them back. */
export const DEFAULT_KINDS: ReadonlySet<EventKind> = new Set(EVENT_KINDS.filter((kind) => kind !== "sbaTick"));

export const filterByKind = (rows: EventRow[], kinds: ReadonlySet<EventKind>): EventRow[] =>
  rows.filter((row) => kinds.has(row.kind));

/** One pinned enemy SPAWN: its actor index plus the span it was alive for. A
 * span, not an id, because the game reissues a dead boss's actor index. */
export type EventTargetSpan = { actorIndex: number; startMs: number; endMs: number };

/** The pins, already resolved out of their own index spaces by the view.
 *
 * `abilityKeys` is `null` for "no ability pinned" and an EMPTY SET for "pinned,
 * but it expands to no action" (a status pin, a stale URL) — which narrows to
 * nothing. Collapsing the two would make a status pin silently show everything. */
export type EventPins = {
  source: number | null;
  targetSpans: EventTargetSpan[];
  abilityKeys: ReadonlySet<string> | null;
};

/** The pins applied, ANDed. A row that cannot answer a pinned dimension is
 * excluded: under a player pin, a party-wide row belongs to nobody, and keeping
 * it would read as the pin failing to apply. */
export const filterByPins = (rows: EventRow[], pins: EventPins): EventRow[] =>
  rows.filter((row) => {
    if (pins.source !== null && row.sourceIndex !== pins.source) return false;
    if (pins.targetSpans.length > 0) {
      const hit = pins.targetSpans.some(
        (span) => row.targetIndex === span.actorIndex && row.timeMs >= span.startMs && row.timeMs <= span.endMs
      );
      if (!hit) return false;
    }
    if (pins.abilityKeys !== null && (row.abilityKey === null || !pins.abilityKeys.has(row.abilityKey))) {
      return false;
    }
    return true;
  });
