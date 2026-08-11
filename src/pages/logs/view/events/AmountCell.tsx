import { Box, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import { Label } from "@/components/ui/Label";
import type { CharacterType } from "@/types";
import { translateTraitId } from "@/utils";

import { HOVER_PANEL_CLASS } from "../analysis/HoverCard";
import { capCardRows, selectCapUp, type CapContext, type CapHit, type CapRow, type PlayerCapUp } from "./capBreakdown";
import { deriveChannelTotal, type CapConditions } from "./capFactors";
import { capConsistent, gameLadderBase, ladderCurveFor } from "./capLadder";
import {
  capClassOf,
  deriveConditionalSources,
  deriveRecordComponents,
  dmgCapTraitValue,
  type CapLoadout,
} from "./capSources";

const format = (row: CapRow, locale: string): string => {
  switch (row.kind) {
    case "count":
      return row.value.toLocaleString(locale);
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
  playerCapUp,
  loadout,
  characterType,
  conditions,
  width,
}: {
  amount: number | null;
  capHit: CapHit | null;
  width: number;
} & AmountCellCapFacts) => {
  const { t, i18n } = useTranslation();
  const rows = useMemo(() => {
    if (capHit === null) return [];
    const capClass = capClassOf(capHit.class_flags);
    // The independent base, from the game's own shipped ladder. Zero means the
    // curve had nothing to say (no curve for this character, no rate) — the
    // card then falls back to the captured record as its total.
    const curve = ladderCurveFor(characterType, capHit.class_flags);
    const ladderBase = curve !== null && capHit.attack_rate !== null ? gameLadderBase(curve, capHit.attack_rate) : 0;
    const hasLadder = ladderBase > 0 && capHit.damage_cap !== null && capHit.damage_cap > 0;
    // The derived per-hit channel: one aggregate row here, itemized in the
    // debug panel. Zero renders nothing — an underived channel stays part of
    // the unaccounted remainder rather than reading as "nothing applied".
    const channel = conditions === undefined ? 0 : deriveChannelTotal(loadout, capClass, conditions);
    const context: CapContext = {
      ladderBase: hasLadder ? ladderBase : null,
      consistent: hasLadder ? capConsistent(capHit.damage_cap!, ladderBase) : null,
      record: selectCapUp(playerCapUp, capHit.class_flags),
      recordComponents: deriveRecordComponents(loadout, capClass),
      dmgCapTrait: dmgCapTraitValue(loadout, capClass),
      conditional: deriveConditionalSources(loadout, capClass),
      ...(channel > 0 ? { channel: [{ key: "channel", labelKey: "ui.logs.cap-term-channel", value: channel }] } : {}),
    };
    return capCardRows(capHit, context);
  }, [capHit, playerCapUp, loadout, characterType, conditions]);
  const shows = rows.length > 1;

  // Memoized because `CursorCard` re-renders on every committed cursor frame
  // and only its own position should change; see its `content` prop.
  const content = useMemo(
    () => (
      <Box className="px-[9px] py-1.5">
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
              {format(row, i18n.language)}
            </Text>
          </Box>
        ))}
      </Box>
    ),
    [rows, t, i18n.language]
  );

  const cell = (
    <Text size="xs" ta="right" data-cell="amount" style={{ fontVariantNumeric: "tabular-nums" }}>
      {amount === null ? "" : amount.toLocaleString(i18n.language)}
    </Text>
  );

  return (
    <Box w={width}>
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
    </Box>
  );
};
