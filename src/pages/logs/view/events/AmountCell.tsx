import { Box, Text } from "@mantine/core";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import { Figure } from "@/components/ui/Figure";
import { Label } from "@/components/ui/Label";
import type { CharacterType } from "@/types";
import { translateTraitId } from "@/utils";

import { HOVER_PANEL_CLASS } from "../analysis/HoverCard";
import {
  PREDICTED_CAP_DENYLIST,
  capCardRows,
  predictedCapRows,
  selectCapUp,
  type CapContext,
  type CapHit,
  type CapRow,
  type PlayerCapUp,
} from "./capBreakdown";
import { deriveChannelBreakdown, deriveChannelTotal, type CapConditions } from "./capFactors";
import { capBucketOf, classifyOffGrid, type CapBucket, type GridKStates } from "./capGridStates";
import { capConsistent, gameLadderBase, isSummonClass, ladderCurveFor } from "./capLadder";
import {
  capClassOf,
  deriveConditionalSources,
  deriveRecordComponents,
  dmgCapTraitValue,
  type CapLoadout,
} from "./capSources";

/** Whether the cap breakdown card is drawn. The card's tests `skipIf` this
 * same switch, so turning it off parks the card and its coverage together.
 * Mirrors `SHOWS_JUMP_BAR` in `EventsTab`: a named, greppable switch, and the
 * memo below short-circuits on it so a hidden card costs nothing per rendered
 * row. */
export const SHOWS_CAP_CARD = true;

const format = (row: CapRow, locale: string, t: (key: string) => string): string => {
  switch (row.kind) {
    case "count": {
      const count = row.value.toLocaleString(locale);
      return row.approx === true ? `≈ ${count}` : count;
    }
    case "rate":
      return row.value.toLocaleString(locale, { maximumFractionDigits: 2 });
    case "percent": {
      const percent = `${row.value.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
      // A conditional's value is a potential, not a measurement.
      return row.variant === "conditional" ? `≤ ${percent}` : percent;
    }
    case "multiplier":
      return `x${row.value.toLocaleString(locale, { minimumFractionDigits: 3 })}`;
    case "verdict":
      // 2 is the ease: the game's own multiplier passing between the actor's
      // grid states, neither a pass nor a failure.
      if (row.value === 2) return `⇄ ${t("ui.logs.cap-verdict-transition")}`;
      return row.value === 1 ? "✓" : "✗";
  }
};

/** The cap facts the caller resolved for the acting player, bundled so the
 * cell's prop list stays readable. All optional: each absent fact degrades the
 * card by exactly the rows that needed it. */
export type AmountCellCapFacts = {
  /** The acting player's cap-up totals, or undefined when the log predates the
   * capture. */
  playerCapUp?: PlayerCapUp;
  /** The acting player's stored loadout, which the itemized rows are
   * reconstructed from. Undefined leaves the whole total unaccounted rather
   * than claiming the loadout contributed nothing. */
  loadout?: CapLoadout;
  /** The acting player's character — the key the base-cap ladder is looked up
   * by. Undefined (an old log, an unnamed actor) drops the independent base
   * and the card falls back to the captured record as its total. */
  characterType?: CharacterType;
  /** What the hit knew about the moment it landed (see `EventRow
   * .capConditions`) — what the channel derivation resolves board nodes
   * against. Undefined leaves the channel underived, never zero. */
  conditions?: CapConditions;
  /** The acting player's observed on-grid K sets per attack-class bucket
   * (`capGridStates`), which refine a failed grid check into the transition
   * verdict. Undefined keeps a failed check at ✗. */
  gridStates?: ReadonlyMap<CapBucket, GridKStates>;
};

/** The Amount cell. A damage row's amount is the END of a calculation the log
 * already records the inputs to, so hovering it explains itself.
 *
 * Rows with nothing to explain render the bare number and open no card at all:
 * a non-damage row has no cap, and a damage row from a log predating the
 * capture yields only the `damage` row, which would restate the cell. An empty
 * or one-row card would imply the data is missing rather than inapplicable. */
export const AmountCell = ({
  amount,
  capHit,
  predictable,
  playerCapUp,
  loadout,
  characterType,
  conditions,
  gridStates,
  width,
  connector,
  share,
}: {
  amount: number | null;
  capHit: CapHit | null;
  /** Whether this row's hit KIND would locally have carried cap fields
   * (`capPredictableKey`) — the gate that lets a capless hit open the
   * predicted card instead of no card. */
  predictable?: boolean;
  /** The column's width: a raw px number on its own, or the events table's
   * density calc when that table places it. */
  width: number | string;
  /** The elbow marking a row that hangs from the one above it, drawn before the
   * digits. A slot rather than the caller's own wrapper, because the cell is
   * one grid cell — the connector, the number and the share are its contents,
   * and only the number opens the card. */
  connector?: ReactNode;
  /** An echo's share of the hit that caused it, drawn after the digits. */
  share?: ReactNode;
} & AmountCellCapFacts) => {
  const { t, i18n } = useTranslation();
  const { rows, predicted } = useMemo((): { rows: CapRow[]; predicted: boolean } => {
    const NONE = { rows: [] as CapRow[], predicted: false };
    // The virtualized events table remounts this cell continuously while
    // scrolling; a hidden card must not pay for ladder curves and record
    // decomposition on every one of them.
    if (!SHOWS_CAP_CARD || capHit === null) return NONE;
    const capClass = capClassOf(capHit.class_flags);
    const curve = ladderCurveFor(characterType, capHit.class_flags);

    if (capHit.damage_cap === null && predictable === true) {
      // No captured cap on a hit kind the cap builder locally always stamps —
      // a REMOTE hit. Predict from the store, the ladder and the loadout, or
      // show nothing: every gate below is a term the formula needs, and a
      // substituted term would be a guess wearing a formula's clothes.
      if (capHit.attack_rate === null || curve === null) return NONE;
      const record = selectCapUp(playerCapUp, capHit.class_flags);
      if (record === null || loadout === undefined) return NONE;
      if (typeof characterType !== "string" || PREDICTED_CAP_DENYLIST.has(characterType)) return NONE;
      const predictedBase = gameLadderBase(curve, capHit.attack_rate);
      if (predictedBase <= 0) return NONE;
      const channel = deriveChannelBreakdown(loadout, capClass, conditions ?? {});
      return {
        predicted: true,
        rows: predictedCapRows(capHit, {
          summonClass: isSummonClass(capHit.class_flags),
          ladderBase: predictedBase,
          record,
          dmgCapTrait: dmgCapTraitValue(loadout, capClass),
          channelActive: channel.active,
          channelUnresolved: channel.unresolved,
          recordComponents: deriveRecordComponents(loadout, capClass),
          conditional: deriveConditionalSources(loadout, capClass),
        }),
      };
    }

    // The independent base, from the game's own shipped ladder. Zero means the
    // curve had nothing to say (no curve for this character, no rate) — the
    // card then falls back to the captured record as its total.
    const ladderBase = curve !== null && capHit.attack_rate !== null ? gameLadderBase(curve, capHit.attack_rate) : 0;
    const hasLadder = ladderBase > 0 && capHit.damage_cap !== null && capHit.damage_cap > 0;
    // The derived per-hit channel: one aggregate row here, itemized in the
    // debug panel. Zero renders nothing — an underived channel stays part of
    // the unaccounted remainder rather than reading as "nothing applied".
    const channel = conditions === undefined ? 0 : deriveChannelTotal(loadout, capClass, conditions);
    // The grid check, refined on failure by the actor's own observed states:
    // a K strictly inside their bracket (or on the settling tail) is the
    // game's own ease, not a formula violation.
    const verdict = (() => {
      if (!hasLadder) return null;
      if (capConsistent(capHit.damage_cap!, ladderBase)) return "pass" as const;
      const bucket = capBucketOf(capHit.class_flags);
      const kFloat = (100 * capHit.damage_cap!) / ladderBase;
      return classifyOffGrid(kFloat, bucket === null ? undefined : gridStates?.get(bucket)) ?? ("fail" as const);
    })();
    const context: CapContext = {
      ladderBase: hasLadder ? ladderBase : null,
      verdict,
      record: selectCapUp(playerCapUp, capHit.class_flags),
      recordComponents: deriveRecordComponents(loadout, capClass),
      dmgCapTrait: dmgCapTraitValue(loadout, capClass),
      conditional: deriveConditionalSources(loadout, capClass),
      ...(channel > 0 ? { channel: [{ key: "channel", labelKey: "ui.logs.cap-term-channel", value: channel }] } : {}),
    };
    return { rows: capCardRows(capHit, context), predicted: false };
  }, [capHit, predictable, playerCapUp, loadout, characterType, conditions, gridStates]);
  // A card needs more than the one row that restates the cell.
  const shows = rows.length > 1;

  // Memoized because `CursorCard` re-renders on every committed cursor frame
  // and only its own position should change; see its `content` prop.
  const content = useMemo(
    () => (
      <Box className="px-[9px] py-1.5">
        {predicted && (
          // The one card that is a MODEL's reading rather than the game's: the
          // title is what keeps it from ever being mistaken for the measured
          // card, whose rows it otherwise shares.
          <Box className="mb-1 border-b border-white/15 pb-1" data-cap-row="predicted-title">
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              {t("ui.logs.cap-predicted-title")}
            </Text>
          </Box>
        )}
        {rows.map((row) => (
          <Box
            key={row.key}
            className="flex items-baseline justify-between gap-4"
            data-cap-row={row.key}
            // A sub-row itemizes the row above it; the indent is what says so.
            style={row.variant === undefined ? undefined : { paddingLeft: 10 }}
          >
            <Label>{row.traitId === undefined ? t(row.labelKey) : translateTraitId(row.traitId)}</Label>
            <Text className="text-sm text-white" style={{ fontVariantNumeric: "tabular-nums" }}>
              {format(row, i18n.language, t)}
            </Text>
          </Box>
        ))}
      </Box>
    ),
    [rows, predicted, t, i18n.language]
  );

  const cell = (
    <Text size="xs" ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
      {amount === null ? "" : amount.toLocaleString(i18n.language)}
    </Text>
  );

  return (
    // The grid cell itself, `data-cell` and all: one component owns the whole
    // Amount column, so the hover target cannot drift away from the number it
    // explains. `relative` because the connector is positioned against it.
    <Figure
      data-cell="amount"
      role="gridcell"
      className="relative flex shrink-0 items-center justify-end"
      style={{ width }}
    >
      {connector}
      {shows ? (
        // The same surface as the metric and aura cards (`HOVER_PANEL_CLASS`):
        // one view must not teach two kinds of tooltip. Sized to its content
        // rather than to the metric card's width floor — six label/value pairs
        // do not need it.
        //
        // Grows LEFT: Amount is the rightmost column, so there is no room to
        // its right and the default placement would only park the card against
        // the window edge.
        <CursorCard
          content={content}
          testId="cap-card"
          className={HOVER_PANEL_CLASS}
          placement="top-left"
          style={{ maxWidth: 280 }}
        >
          {cell}
        </CursorCard>
      ) : (
        cell
      )}
      {share}
    </Figure>
  );
};
