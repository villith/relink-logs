import type { ComputedPlayerState, TargetEntry } from "@/types";

import type { RowKeying } from "../abilitySkills";
import type { MetricCard, MetricRow, RowLevel } from "../metrics/types";
import { spawnRowSegment } from "../rowKey";
import type { SelectorPins } from "../selectorOptions";

import type { CardSection } from "./HoverCard";
import { cardSectionsFor, targetCardSectionsFor, type SectionLabels } from "./cardSections";
import {
  enemyDealtCardSectionsFor,
  enemyReceivedCardSectionsFor,
  type HostilityCardLabels,
} from "./hostilityCardSections";
import type { CardKind } from "./machine/capabilities";
import type { Dimension } from "./machine/state";
import { takenAbilityCardSectionsFor, takenCardSectionsFor } from "./takenCardSections";

/** The union of every builder's lookups — one labels object for all of them,
 * so an ability, a player or an enemy cannot be named one way by one card and
 * another way by the next. */
export type RowCardLabels = SectionLabels & HostilityCardLabels;

/** One row's hover-card sections, routed by the DECLARED card kind — the
 * machine's `cardKind(groupBy, hostility)` — to the builder that delivers it.
 * Extracted from the view so the promise and the delivery can be tested
 * against each other (see rowCardSections.test.ts). A builder handed a row
 * it cannot decompose still answers null, and a declared "none" skips the
 * work outright. */
export const rowCardSectionsFor = ({
  cardKind,
  groupBy,
  row,
  level,
  players,
  pins,
  targetEntries,
  color,
  labels,
  card,
  keying,
}: {
  cardKind: CardKind;
  groupBy: Dimension;
  row: MetricRow;
  level: RowLevel;
  players: ComputedPlayerState[];
  pins: SelectorPins;
  targetEntries: TargetEntry[];
  color: string;
  labels: RowCardLabels;
  /** The metric's card (amount heading, figure, per-target flag) — consumed
   * by the skill-walk builders only. */
  card: MetricCard | undefined;
  /** The view's row keying, so a card folds exactly as the row it explains.
   * The skill-walk builder and the two party-DEALT folds need it — those list
   * abilities, which is the dimension the collapse moves things along. The
   * taken cards decompose enemy attacks, which it does not touch. */
  keying?: RowKeying;
}): CardSection[] | null => {
  switch (cardKind) {
    case "enemyDealt":
      return enemyDealtCardSectionsFor({ row, players, color, labels });
    case "enemyReceived":
      // The groups path keys this grouping's rows per enemy SPAWN
      // (`target:<segment>`), which the spawn builder decomposes — who dealt
      // to the spawn, with what. Type-keyed `enemy:` rows (the legacy
      // grammar) keep the type-level builder.
      if (spawnRowSegment(row.key) !== null) {
        return targetCardSectionsFor({ row, players, targetEntries, color, labels, keying });
      }
      return enemyReceivedCardSectionsFor({ row, players, color, labels, keying });
    case "taken":
      // The declared kind covers both taken groupings; which builder applies
      // is the grouping's row shape — victims at the source grouping,
      // drilled attacks at the ability grouping.
      return groupBy === "ability"
        ? takenAbilityCardSectionsFor({ row, players, source: pins.source, color, labels })
        : takenCardSectionsFor({ row, players, color, labels });
    case "skill":
      // A target-grouped row is a spawn, decomposed by its own builder; every
      // other skill-walk row goes through the level-based sections.
      if (spawnRowSegment(row.key) !== null) {
        return targetCardSectionsFor({ row, players, targetEntries, color, labels, keying });
      }
      return card ? cardSectionsFor({ row, level, players, pins, color, labels, card, keying }) : null;
    default:
      return null;
  }
};
