import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { statusClassName } from "@/statusClassName";
import type { CharacterType, ComputedPlayerState, StatusInterval } from "@/types";
import { causeSkillName, translateStatusName } from "@/utils";

import { groupBy } from "../../groupBy";
import { statusPinKey } from "../../statusUptime";
import type { CauseClass } from "../causeClass";
import { causeClassOfKey } from "../causeClass";
import { casterActionOf, causeCandidatesOf, causeNameFor, statusKeyParts, statusLabelFor } from "../statusLabel";

/** The four rungs a status cause is named through, in order: the recorded cause
 * id against the row's own casters, then the caster's action through those same
 * tables, then the effect's RTTI class, then nothing.
 *
 * ONE spelling. The view had this written out in `statusDisplayLabel` and again
 * in `classOfRow` — which is how a row could be NAMED "Guardpoint" and still
 * FILE under Unknown, the section and the label disagreeing about one row. The
 * comment in `classOfRow` already said the rungs had to match; now they cannot
 * fail to.
 *
 * The caster action is read off the row's own intervals (it is labelling
 * payload, never part of the key); the class comes out of the key itself. */
const causeResolverFor = (
  key: string,
  candidates: CharacterType[],
  intervals: StatusInterval[],
  t: TFunction
  // `number | null` to match `statusLabelFor`'s own cause callback: a row whose
  // effect was never attributed carries a null cause, and `causeNameFor` owns
  // the "no cause at all" test rather than each caller re-spelling it.
): ((causeId: number | null) => string) => {
  const casterAction = casterActionOf(intervals);
  const classHash = statusKeyParts(key)?.classHash ?? null;
  return (causeId: number | null) =>
    causeNameFor(
      causeId,
      (cause) => causeSkillName(candidates, cause),
      // The caster action is the same id space as the cause, so it resolves
      // through the same caster-scoped tables.
      () => (casterAction === null ? "" : causeSkillName(candidates, casterAction)),
      () => statusClassName(classHash, t)
    );
};

export type StatusNaming = {
  /** The name an effect's row shows — and the one the Ability selector shows
   * for a pinned effect, which is why it is shared rather than spelled twice. */
  statusDisplayLabel: (key: string) => string;
  /** A row's provenance class, resolved through the SAME ladder the label
   * uses, so the section and the name cannot disagree. */
  classOfRow: (rowKey: string) => CauseClass;
};

export const useStatusNaming = ({
  statusIntervals,
  playerByIndex,
}: {
  statusIntervals: StatusInterval[];
  playerByIndex: Map<number, { player: ComputedPlayerState; slot: number }>;
}): StatusNaming => {
  const { t, i18n } = useTranslation();

  const intervalsByPinKey = useMemo(() => groupBy(statusIntervals, statusPinKey), [statusIntervals]);

  // A cause is the CASTER's action id, so it is named through the tables of
  // that row's own casters (and their sub-actors) — never the whole party,
  // whose colliding action ids fabricated cross-character names.
  const causeCandidates = useMemo(() => {
    const byKey = new Map<string, CharacterType[]>();
    for (const [key, group] of intervalsByPinKey) {
      byKey.set(
        key,
        causeCandidatesOf(group, (index) => playerByIndex.get(index)?.player)
      );
    }
    return byKey;
  }, [intervalsByPinKey, playerByIndex]);

  // The one ladder, bound per key. Both consumers below go through this, which
  // is the whole point of the extraction.
  const causeResolver = useCallback(
    (key: string) => causeResolverFor(key, causeCandidates.get(key) ?? [], intervalsByPinKey.get(key) ?? [], t),
    [causeCandidates, intervalsByPinKey, t]
  );

  const statusDisplayLabel = useCallback(
    (key: string) => statusLabelFor(key, t, { effect: translateStatusName, cause: causeResolver(key) }),
    // i18n.language: skill and band names are translated.
    [t, causeResolver, i18n.language]
  );

  // A cause is classed `skill` only when a name actually resolves for it —
  // through the row's own casters, the same pipeline the labels use. A row
  // named "Guardpoint" filing under Unknown would be the section and the label
  // disagreeing about the same row.
  const classOfRow = useCallback(
    (rowKey: string) => {
      const resolve = causeResolver(rowKey);
      return causeClassOfKey(rowKey, (causeId) => resolve(causeId) !== "");
    },
    // i18n.language: the skill tables the resolution reads are translated.
    [causeResolver, i18n.language]
  );

  return { statusDisplayLabel, classOfRow };
};
