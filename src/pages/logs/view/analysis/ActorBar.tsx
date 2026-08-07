import { Box } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PinSelect, type LabelledOption } from "./PinSelect";

import "./analysis.css";

export type ActorBarProps = {
  options: LabelledOption[];
  /** The pinned actor's index, or null for the whole party. */
  value: number | null;
  onChange: (index: number | null) => void;
  /** Rendered at the row's right edge. The top-level view switch rides here
   * rather than in a strip of its own: the actor is the one pin that survives
   * every view, so the row that carries it is the row that says which view is
   * showing. Kept as an opaque node so this bar stays ignorant of what the
   * views are. */
  trailing?: ReactNode;
};

/** The actor pin and the view switch — the view's topmost row.
 *
 * Above the side toggle and the metric tabs, unlike the other two pins: WHO the
 * page is about outranks which side and which metric, and it is the only pin
 * the Events view and the table view both read the same way. The target and
 * ability pins stay below the metric tabs, where they narrow whatever that
 * metric is showing (see PinBar). */
export const ActorBar = ({ options, value, onChange, trailing }: ActorBarProps) => {
  const { t } = useTranslation();

  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        borderBottom: "1px solid var(--an-line)",
        flexWrap: "wrap",
      }}
    >
      <PinSelect
        minWidth={240}
        // Capped: this row is otherwise empty, so an uncapped selector would
        // stretch the whole way to the view switch — a 700px control holding
        // one player's name.
        maxWidth={420}
        data={options}
        value={value === null ? null : String(value)}
        placeholder={t("ui.logs.selector-all-friendlies")}
        ariaLabel={t("ui.logs.selector-source")}
        onChange={(next) => onChange(next === null ? null : Number(next))}
      />
      {trailing !== undefined && (
        <Box style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>{trailing}</Box>
      )}
    </Box>
  );
};
