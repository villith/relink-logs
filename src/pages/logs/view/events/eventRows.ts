import { statusPinKey } from "@/pages/logs/view/statusUptime";
import type { LogEvent } from "@/types";

import { abilityKey } from "../abilityKey";
import type { CapHit } from "./capBreakdown";
import { conditionsForHit } from "./capFactors/conditions";
import type { CapConditions } from "./capFactors/types";

/** What the colour coding and the kind toggles key on. */
export type EventKind = "damage" | "stun" | "perfectGuard" | "sba" | "sbaTick" | "death" | "status" | "other";

/** Which index space a row's `targetIndex` is in.
 *
 * The two capture paths do NOT share one, and nothing about the number says
 * which it is. A damage event's `target.index` is the spawn's INSTANCE POINTER
 * folded to 32 bits — `TargetEntry.id`. Every other event reports the game's
 * own actor index — `TargetEntry.actorIndex`, the coarser one, because the
 * status hook sees the actor and not the damage instance.
 *
 * The parser learned this the expensive way: see `segment_at` in
 * `parser/v1/status.rs`, where comparing the two compared different namespaces,
 * never matched, and left every enemy-held status without its spawn. A row that
 * did not say which space it carries would repeat that here — which is exactly
 * what it did, and why a damage row's target rendered as a bare number.
 *
 * Players are not affected: BOTH paths report `PLAYER_SLOT_INDEX_BASE | slot`
 * for a party member, so a player resolves the same way in either space. */
export type ActorSpace = "spawn" | "actor";

/** A projected event row. Null means "this kind has no such field" — never zero,
 * which would render as real data. */
export type EventRow = {
  timeMs: number;
  kind: EventKind;
  /** The acting actor, or null for a party-wide event that names none. */
  sourceIndex: number | null;
  targetIndex: number | null;
  /** Which spawn table column `targetIndex` must be matched against. Carried on
   * every row, including those with no target, so a consumer never has to infer
   * it from the kind. */
  targetSpace: ActorSpace;
  /** The ability the row names, for rows that have one. */
  abilityKey: string | null;
  /** The `status:<effect>:<cause>:<class>` key for a row that names an EFFECT
   * rather than an ability — the same grammar the buffs tables and the ability
   * selector pin, so one effect is named and pictured identically wherever it
   * appears. Mutually exclusive with `abilityKey`. */
  statusKey: string | null;
  /** The effect id on its own, for the polarity split the Buffs and Debuffs
   * tabs make (`isHarmful`). Carried rather than parsed back out of
   * `statusKey`: it is the number the event already gave us, and re-reading it
   * through the key's grammar is a second chance to get it wrong. */
  statusId: number | null;
  /** A translated descriptor for a row with neither — the
   * `labelKey`/`labelParams` idiom `MetricRow` already uses. All three render in
   * the Ability column, so they are mutually exclusive. */
  detailKey: string | null;
  detailParams?: Record<string, number | string>;
  amount: number | null;
  /** The cap fields of a damage row, for the Amount hover card. `null` on every
   * non-damage kind — those rows have no cap to explain. A damage row from a log
   * predating the capture carries the shape with null members, which
   * `capCardRows` degrades to the one row it can honestly show. */
  capHit: CapHit | null;
  /** What the hit knew about the moment it landed — action id, attacker HP and
   * statuses — in the shape the cap factors ask for. What lets the card derive
   * the hit's channel terms. `null` on non-damage kinds; a damage row from an
   * old log carries whatever facts it has, absent keys left unclaimed. */
  capConditions: CapConditions | null;
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
      // The damage path's own key: the folded instance pointer, NOT
      // `target.parent_index` (see `ActorSpace`).
      targetIndex: hit.target.index,
      targetSpace: "spawn",
      abilityKey: abilityKey(hit.action_id),
      statusKey: null,
      statusId: null,
      detailKey: null,
      amount: hit.damage,
      capHit: {
        damage: hit.damage,
        damage_cap: hit.damage_cap,
        base_damage: hit.base_damage,
        attack_rate: hit.attack_rate,
        class_flags: hit.class_flags,
      },
      // Normalized: a log stored before these fields existed deserializes with
      // the keys ABSENT, not null, and the conditions builder tells the two
      // apart on purpose.
      capConditions: conditionsForHit(
        {
          source_current_hp: hit.source_current_hp ?? null,
          source_max_hp: hit.source_max_hp ?? null,
          source_statuses: hit.source_statuses ?? null,
        },
        null,
        hit.action_id
      ),
    };
  }

  // An effect landing. The CASTER is the source and the HOLDER is the target —
  // the same direction a damage row reads, so the two scan as one table. Filed
  // the other way round (holder as source, which is how every other variant's
  // `actor_index` is read below) a buff would read as the target buffing
  // itself.
  if ("StatusApply" in payload) {
    const status = payload.StatusApply;
    return {
      timeMs,
      kind,
      sourceIndex: status.caster_index,
      targetIndex: status.actor_index,
      targetSpace: "actor",
      abilityKey: null,
      statusKey: statusPinKey({
        statusId: status.status_id,
        abilityId: status.ability_id,
        statusClass: status.status_class,
      }),
      statusId: status.status_id,
      // Kept ALONGSIDE the effect, not instead of it: the effect says what, this
      // says whether it landed or ended, and the two render together (see
      // `CellText`'s suffix). Without it an apply and its matching remove are
      // the same effect on the same holder in the same colour.
      detailKey: "ui.logs.events-status-applied",
      amount: status.stacks,
      capHit: null,
      capConditions: null,
    };
  }

  // The remove side carries no caster and no class — the shared destructor
  // cannot vouch for either. Spelled `unknown` in the key rather than guessed,
  // which is what makes the row name the effect and stay silent about a cause
  // it does not have.
  if ("StatusRemove" in payload) {
    const status = payload.StatusRemove;
    return {
      timeMs,
      kind,
      sourceIndex: null,
      targetIndex: status.actor_index,
      targetSpace: "actor",
      abilityKey: null,
      statusKey: statusPinKey({
        statusId: status.status_id,
        abilityId: status.ability_id,
        statusClass: null,
      }),
      statusId: status.status_id,
      detailKey: "ui.logs.events-status-removed",
      amount: null,
      capHit: null,
      capConditions: null,
    };
  }

  // The gauge grant names the skill that produced it. `action_id` is 0 where
  // the cause was not a `Skill(Normal(id))` (see `SbaGainEvent`), and 0 is not
  // an action — naming it would print an unknown skill over every link attack
  // and echo that fed the gauge.
  if ("SbaGain" in payload) {
    const gain = payload.SbaGain;
    return {
      timeMs,
      kind,
      sourceIndex: gain.actor_index,
      targetIndex: null,
      targetSpace: "actor",
      abilityKey: gain.action_id === 0 ? null : abilityKey({ Normal: gain.action_id }),
      statusKey: null,
      statusId: null,
      detailKey: gain.action_id === 0 ? "ui.logs.events-sba-gain" : null,
      amount: Math.round(gain.amount),
      capHit: null,
      capConditions: null,
    };
  }

  // Link Time names no actor and carries a direction instead of an amount.
  if ("LinkTime" in payload) {
    return {
      timeMs,
      kind,
      sourceIndex: null,
      targetIndex: null,
      targetSpace: "actor",
      abilityKey: null,
      statusKey: null,
      statusId: null,
      detailKey: payload.LinkTime.active ? "ui.logs.events-link-start" : "ui.logs.events-link-end",
      amount: null,
      capHit: null,
      capConditions: null,
    };
  }

  if ("EnemyMode" in payload) {
    return {
      timeMs,
      kind,
      sourceIndex: payload.EnemyMode.actor_index,
      targetIndex: null,
      targetSpace: "actor",
      abilityKey: null,
      statusKey: null,
      statusId: null,
      detailKey: "ui.logs.events-enemy-mode",
      detailParams: { mode: payload.EnemyMode.mode },
      amount: null,
      capHit: null,
      capConditions: null,
    };
  }

  const body: unknown = Object.values(payload)[0];
  const detailKey = DETAIL_KEY[variant] ?? UNKNOWN_DETAIL_KEY;
  return {
    timeMs,
    kind,
    sourceIndex: numberAt(body, "actor_index"),
    targetIndex: null,
    targetSpace: "actor",
    abilityKey: null,
    statusKey: null,
    statusId: null,
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
    capHit: null,
    capConditions: null,
  };
};

/** Every kind, in the order the toggles show them. The one list the colour map
 * is built from, so a kind cannot exist without a colour.
 *
 * Which of these a given tab OFFERS — and which start on — is `eventScope`'s
 * business now, because the metric tab is what says which events its stream is
 * made of. This is the universe, not a default. */
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

export const filterByKind = (rows: EventRow[], kinds: ReadonlySet<EventKind>): EventRow[] =>
  rows.filter((row) => kinds.has(row.kind));

/** One pinned enemy SPAWN, in BOTH index spaces, plus the span it was alive
 * for.
 *
 * Both, because the rows it filters are not all in one space (see
 * `ActorSpace`): a damage row carries the folded instance pointer and a status
 * row carries the game's actor index, and a span holding only one of them
 * silently dropped every row of the other kind. A span rather than an id alone
 * because the game reissues a dead boss's actor index to a later spawn. */
export type EventTargetSpan = { spawnId: number; actorIndex: number; startMs: number; endMs: number };

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
        (span) =>
          row.targetIndex === (row.targetSpace === "spawn" ? span.spawnId : span.actorIndex) &&
          row.timeMs >= span.startMs &&
          row.timeMs <= span.endMs
      );
      if (!hit) return false;
    }
    if (pins.abilityKeys !== null && (row.abilityKey === null || !pins.abilityKeys.has(row.abilityKey))) {
      return false;
    }
    return true;
  });
