import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { enemyIconUrl } from "@/enemyIcon";
import { statusIconUrl } from "@/statusIcon";
import type { ComputedPlayerState } from "@/types";
import { getSkillName, translateEnemyType } from "@/utils";

import { actorColor } from "../../actorColor";
import { cellOfKey, cellOfRow, type EntityCell, type EntityResolvers } from "../../entity";
import { sbaCauseLabel } from "../../metrics/sba";
import type { LabelKind, MetricRow } from "../../metrics/types";
import { abilityLabelFor } from "../abilityLabel";
import { abilityRowIconUrl } from "../rowIcon";
import { statusIdOfKey } from "../statusLabel";

import type { ActorIdentity } from "./useActorIdentity";

export type EntityCells = {
  /** Everything the view knows about the thing a row or band KEY names. */
  cellOf: (key: string, owner?: ComputedPlayerState) => EntityCell;
  /** The same, for a table ROW — which carries its kind separately and its
   * payload unprefixed (see `rowRefOfRow`). */
  rowCell: (row: MetricRow, tableKind: LabelKind, owner?: ComputedPlayerState) => EntityCell;
  /** The bundle itself, for the folds that resolve one dimension directly
   * (a hover card's per-player section knows it is naming players). */
  resolvers: EntityResolvers;
};

/**
 * The view's ONE set of entity lookups.
 *
 * Every surface — the table's rows, the chart's bands and its tooltip, the
 * three pin selectors, the hover cards, the raw event stream, the timeline's
 * lanes — names, illustrates and colours the same handful of things. Each used
 * to reach for its own resolver: `bandLabelFor` named a band, `bandIconFor`
 * illustrated it, `actorOfKey` coloured it, and `renderLabel`/`rowIconUrl` did
 * the first two again over the row grammar. Five ladders, one taxonomy.
 *
 * That is why the same defect kept arriving one surface at a time — a band with
 * the table's name but no picture, a hover card listing grouped abilities as
 * bare text, a dropdown entry with no colour. None of them threw; each just
 * quietly answered `undefined` and rendered as missing data.
 *
 * Bound once here and threaded into the models, so a new surface asks for a
 * cell and gets the art and the colour it did not know to ask for.
 */
export const useEntityCells = ({
  identity,
  statusDisplayLabel,
  sourcePin,
}: {
  identity: ActorIdentity;
  statusDisplayLabel: (key: string) => string;
  /** The pinned source, whose skill tables win when naming a shared action id.
   * Action ids collide across characters (120 is Eustace's "Grade 1 Shot" AND
   * Id's "Combo Finisher (Dragonform)"). */
  sourcePin: number | null;
}): EntityCells => {
  const { t, i18n } = useTranslation();
  const {
    identityPlayers,
    playerByIndex,
    colorContext,
    labelForSource,
    labelForAbility,
    labelForTarget,
    labelForTakenAttack,
    sourceIconUrl,
    targetIconUrl,
  } = identity;

  const pinnedPlayer = playerByIndex.get(sourcePin ?? -1)?.player;

  const resolvers: EntityResolvers = useMemo(
    () => ({
      player: (index) => ({
        name: labelForSource(index),
        iconUrl: sourceIconUrl(index),
        color: actorColor({ kind: "player", index }, colorContext),
      }),
      target: (segment) => ({
        name: labelForTarget(segment),
        iconUrl: targetIconUrl(segment),
        color: actorColor({ kind: "target", segment }, colorContext),
      }),
      // A holder the segmenter never placed. Its raw actor id is the only
      // identity there is — it indexes no spawn, so there is no portrait to
      // draw and no spawn colour to take. Colouring it by the bare index would
      // give a reissued index two spawns' colours.
      actor: (actorIndex) => ({ name: String(actorIndex) }),
      enemy: (enemyType) => ({
        name: translateEnemyType(enemyType),
        iconUrl: enemyIconUrl(enemyType),
        color: actorColor({ kind: "enemy", enemyType }, colorContext),
      }),
      // An enemy's attack wears the attacker's portrait — it has none of its
      // own, and the attacker is what the name already leads with.
      takenAttack: (enemyType, actionId) => ({
        name: labelForTakenAttack(enemyType, actionId),
        iconUrl: enemyIconUrl(enemyType),
      }),
      // An ability belongs to whoever used it, so it takes no colour of its
      // own — the row it sits on already carries that player's.
      ability: (rowKey, owner) => ({
        name: owner ? abilityLabelFor(rowKey, identityPlayers, getSkillName, owner) : labelForAbility(rowKey),
        iconUrl: abilityRowIconUrl(rowKey, identityPlayers, owner ?? pinnedPlayer),
      }),
      status: (statusKey) => {
        const statusId = statusIdOfKey(statusKey);
        return {
          name: statusDisplayLabel(statusKey),
          iconUrl: statusId === null ? undefined : statusIconUrl(statusId),
        };
      },
      // The self-naming keys carry their own i18n key. A gauge cause that
      // reached the ability join would draw whichever art the fallback landed
      // on, under a name it never asked for.
      reserved: (ref) => {
        if (ref.kind === "rollup") return { name: t("ui.logs.chart-other-label") };
        if (ref.kind === "total") return { name: t("ui.logs.chart-total-label") };
        const cause = sbaCauseLabel(ref.key);
        return { name: cause === null ? ref.key : t(cause.labelKey, cause.labelParams) };
      },
    }),
    // i18n.language: every branch produces a translated name.
    [
      t,
      i18n.language,
      labelForSource,
      labelForTarget,
      labelForAbility,
      labelForTakenAttack,
      statusDisplayLabel,
      sourceIconUrl,
      targetIconUrl,
      colorContext,
      identityPlayers,
      pinnedPlayer,
    ]
  );

  const cellOf = useCallback(
    (key: string, owner?: ComputedPlayerState) => cellOfKey(key, resolvers, owner),
    [resolvers]
  );

  const rowCell = useCallback(
    (row: MetricRow, tableKind: LabelKind, owner?: ComputedPlayerState) =>
      // A row that names itself resolves against nothing (see
      // `MetricRow.labelKey`): it is not an ability, a player or an effect, and
      // sending its sentinel through one of those joins would print that join's
      // guess. A row whose payload does not parse falls back to that payload,
      // which is what tells the user the log holds something the view cannot
      // place.
      cellOfRow(
        row,
        tableKind,
        resolvers,
        (self) => (self.labelKey ? t(self.labelKey, self.labelParams) : self.label),
        owner
      ),
    [resolvers, t]
  );

  return { cellOf, rowCell, resolvers };
};
