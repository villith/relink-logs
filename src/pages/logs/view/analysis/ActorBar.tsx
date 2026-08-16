import { Box } from "@mantine/core";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { PaneSources } from "@/stores/useAnalysisPanesStore";

import type { Hostility } from "../metrics/types";

import { PinSelect } from "./PinSelect";
import { selectorPlaceholderKey } from "./machine/resolve";

import "./analysis.css";

export type ActorBarProps = {
  /** One entry per pane, in pane order — its source universe, its pin and the
   * pane's own handler for changing it. Empty is a real state: while comparing,
   * the panes draw their own and this row keeps only its trailing control. */
  panes: PaneSources[];
  /** Which side is showing. Not a filter over these lists — it decides which
   * POPULATION the source dimension draws from at all, so it is what this row's
   * placeholder is named from (see `selectorPlaceholderKey`). */
  hostility: Hostility;
  /** Rendered at the row's right edge. The compare control rides here rather
   * than in a strip of its own: this row is what says which logs and which
   * actors the page is about, so it is the row that opens a second log. Kept as
   * an opaque node so this bar stays ignorant of what that control is. */
  trailing?: ReactNode;
};

/** The actor pins — the row that says WHO the page is about.
 *
 * Above the side toggle and the metric tabs, unlike the other two pins: WHO the
 * page is about outranks which side and which metric, and it is the only pin the
 * Events view and the table view read the same way. The target and ability pins
 * stay below the metric tabs, where they narrow whatever that metric is showing
 * (see PinBar).
 *
 * Two callers, one component: the FRAME draws it at the top of the view with a
 * single log open, and each PANE draws its own (one entry, under its log picker)
 * while comparing. The frame's row stays either way — emptied of selectors it
 * still carries the control that opens and closes the comparison.
 *
 * The panes always OWN their pins: each entry carries that pane's own handler
 * (see `PaneSources`), because pinning a source is a machine transition and the
 * bar must not be a second spelling of it. */
export const ActorBar = ({ panes, hostility, trailing }: ActorBarProps) => {
  const { t } = useTranslation();

  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        borderBottom: "1px solid var(--color-line)",
        flexWrap: "wrap",
      }}
    >
      {panes.map((pane, paneIndex) => (
        <PinSelect
          // Two panes may carry one log, so nothing about the log is a key.
          key={paneIndex}
          minWidth={240}
          // Capped, or an uncapped selector stretches the whole way to the
          // metric tabs to hold one player's name.
          maxWidth={420}
          data={pane.options}
          value={pane.value === null ? null : String(pane.value)}
          // Who fills the source dimension swaps with the side (`universeOf`),
          // so the placeholder does too; the `aria-label` names the role and
          // stays put.
          placeholder={t(selectorPlaceholderKey("source", hostility))}
          ariaLabel={t("ui.logs.selector-source")}
          onChange={(next) => pane.onChange(next === null ? null : Number(next))}
        />
      ))}
      {trailing !== undefined && (
        <Box style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>{trailing}</Box>
      )}
    </Box>
  );
};
