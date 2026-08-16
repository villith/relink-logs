import { Box } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { PaneSources } from "@/stores/useAnalysisPanesStore";

import { PinSelect } from "./PinSelect";

import "./analysis.css";

export type ActorBarProps = {
  /** One entry per pane, in pane order — its source universe, its pin and the
   * pane's own handler for changing it. */
  panes: PaneSources[];
  /** Rendered at the row's right edge. The compare control rides here rather
   * than in a strip of its own: this row is what says which logs and which
   * actors the page is about, so it is the row that opens a second log. Kept as
   * an opaque node so this bar stays ignorant of what that control is. */
  trailing?: ReactNode;
};

/** The actor pins — the view's topmost row, and a SHARED control.
 *
 * Above the side toggle and the metric tabs, unlike the other two pins: WHO the
 * page is about outranks which side and which metric, and it is the only pin the
 * Events view and the table view read the same way. The target and ability pins
 * stay below the metric tabs, where they narrow whatever that metric is showing
 * (see PinBar).
 *
 * ONE selector per log, side by side, rather than one per pane down in the panes.
 * A comparison is two fights read against each other, so the question this row
 * answers — "who am I looking at" — is asked once and answered once per log; two
 * logs rarely share a party, so the two selectors hold different values and
 * neither can stand in for the other. With a single log open this is exactly the
 * one-selector row the view has always had.
 *
 * The panes still OWN their pins: each entry carries that pane's own handler
 * (see `PaneSources`), because pinning a source is a machine transition and the
 * bar must not be a second spelling of it. */
export const ActorBar = ({ panes, trailing }: ActorBarProps) => {
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
          // Keyed by INDEX, like the panes themselves: two panes may carry one
          // log, so nothing about the log is a key.
          key={paneIndex}
          minWidth={240}
          // Capped: with one log this row is otherwise empty, so an uncapped
          // selector would stretch the whole way to the metric tabs — a 700px
          // control holding one player's name.
          maxWidth={420}
          data={pane.options}
          value={pane.value === null ? null : String(pane.value)}
          placeholder={t("ui.logs.selector-all-friendlies")}
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
