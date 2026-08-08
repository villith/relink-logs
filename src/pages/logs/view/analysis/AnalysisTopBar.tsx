import { Alert, Box, Button } from "@mantine/core";
import { Warning } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { useBackTo } from "@/hooks/useBackTo";
import { ViewModeToggle } from "@/pages/logs/view/ViewModeToggle";

/** The row above everything the Analysis view draws: the way off the log, the
 * standing caveat about the view itself, and the way to the other reading of
 * the same log.
 *
 * Neither control belongs in the selector bar below, because neither SELECTS
 * anything — one leaves the screen and the other replaces the whole body — so
 * they sit outside what they would otherwise appear to narrow. The same two
 * controls, in the same two corners, as Classic's own header row: a reader who
 * switches views must not have to look for Back in a new place.
 *
 * The warning sits BETWEEN them, spoken outright rather than hidden under an
 * icon's tooltip. A caveat that only appears on hover is one most readers never
 * meet, and this is the row that also offers the way out of the beta — so the
 * warning and the control that answers it are read together.
 *
 * Padded like `ActorBar`, since the view is full-bleed and nothing else holds
 * its children off the window edge. */
export const AnalysisTopBar = () => {
  const { t } = useTranslation();
  // "Up", not "back" — the destination the link that opened the log declared,
  // falling back to the quest list. See `useBackTo` for why this is not a
  // history walk.
  const goBack = useBackTo();

  return (
    <Box style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
      <Button size="xs" variant="default" onClick={goBack} style={{ flex: "none" }}>
        {t("ui.back-btn")}
      </Button>
      {/* Takes the slack so the switch stays pinned right, and shrinks before
          it wraps: this is a caveat, not the page. */}
      <Alert
        variant="light"
        color="yellow"
        icon={<Warning size={18} />}
        style={{ flex: 1, minWidth: 0, padding: "6px 10px" }}
        styles={{ body: { gap: 0 }, message: { fontSize: "var(--mantine-font-size-xs)", lineHeight: 1.35 } }}
      >
        {t("ui.logs.view-mode.beta-warning")}
      </Alert>
      <Box style={{ flex: "none" }}>
        <ViewModeToggle />
      </Box>
    </Box>
  );
};
