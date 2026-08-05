import type { DeathEvent, SBAEvent } from "@/types";

/** What a marker is about. Two kinds now; phase transitions were investigated
 * and are NOT recorded mid-encounter (OnAreaEnter ends the encounter), so they
 * cannot join without hook changes — out of scope for this package. */
export type MarkerKind = "death" | "sba";

/** A marker as extracted from the event log: rebased onto the chart window,
 * not yet named or coloured — the view resolves those (they need the player
 * labels and palette). */
export type MarkerEvent = { kind: MarkerKind; atMs: number; actorIndex: number };

/** A marker as the chart draws it: a vertical line at `atMs` (milliseconds
 * from the chart window's start) plus the tooltip line for its bucket. */
export type ChartMarker = { kind: MarkerKind; atMs: number; color: string; label: string };

/** The SBA markers' colour — the analysis view's own accent (analysis.css),
 * distinct from every party colour. Deaths take the dead player's colour. */
export const SBA_MARKER_COLOR = "var(--an-accent)";

/** Death and SBA-activation markers for the chart, rebased onto `window` (the
 * same `{startMs, endMs}` span the status tables and bands measure — event
 * timestamps arrive already relative to fight start, see main.rs).
 *
 * `knownActors` is the party's actor indexes; an event about anyone else is
 * dropped — the death hook fires for every entity, and enemy deaths are out of
 * scope for this package.
 *
 * An SBA ACTIVATION is `OnPerformSBA` or `OnContinueSBAChain` (a continuation
 * is that player's own SBA going off). `OnAttemptSBA` is the button press,
 * not the art, and is skipped. */
export const extractMarkers = ({
  deathEvents,
  sbaEvents,
  window,
  knownActors,
}: {
  deathEvents: DeathEvent[];
  sbaEvents: SBAEvent[];
  window: { startMs: number; endMs: number };
  knownActors: Set<number>;
}): MarkerEvent[] => {
  const markers: MarkerEvent[] = [];
  const admit = (ts: number, actorIndex: number) =>
    ts >= window.startMs && ts < window.endMs && knownActors.has(actorIndex);

  for (const [ts, event] of deathEvents) {
    const { actor_index } = event.OnDeathEvent;
    if (admit(ts, actor_index)) markers.push({ kind: "death", atMs: ts - window.startMs, actorIndex: actor_index });
  }

  for (const [ts, event] of sbaEvents) {
    const activation =
      "OnPerformSBA" in event ? event.OnPerformSBA : "OnContinueSBAChain" in event ? event.OnContinueSBAChain : null;
    if (activation === null) continue;
    if (admit(ts, activation.actor_index)) {
      markers.push({ kind: "sba", atMs: ts - window.startMs, actorIndex: activation.actor_index });
    }
  }

  return markers.sort((a, b) => a.atMs - b.atMs);
};
