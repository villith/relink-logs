import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import "./analysis.css";

/** How long a fetch may take before anything is drawn about it, in ms.
 *
 * A scoped fetch over a log already in memory usually lands inside this, and an
 * overlay that appeared and vanished in two frames would BE the flicker it is
 * here to remove — one more thing changing on screen per click, not one fewer.
 * Long enough to hide the fast case, short enough that a slow one does not feel
 * like a dropped click. */
const APPEAR_AFTER_MS = 180;

/** Whether to draw anything for a request that has been outstanding for a while.
 *
 * Delayed on the way IN and immediate on the way OUT: the wait is what needs
 * covering, and holding the cover past the answer would add a second wait of our
 * own on top of the one that just ended. */
const useSettleDelay = (pending: boolean): boolean => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pending) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), APPEAR_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return shown;
};

export type PaneLoadingProps = {
  /** Whether this pane has a fetch outstanding (see `useEncounterData`). */
  pending: boolean;
};

/** The wait, drawn OVER the pane rather than in place of it.
 *
 * A pin, a metric, a side or a regroup changes several things that each land on
 * their own schedule: the table's columns and empty state resolve from the URL
 * immediately, its rows keep answering the PREVIOUS grouping until the fetch
 * lands (see `answeredGroups`), and the plot follows the rows. Read one after
 * the other that is three repaints per click, which is what reads as flicker.
 *
 * So the previous reading stays painted, dimmed, under one spinner — the answer
 * you had until the answer you asked for arrives. Nothing is unmounted and
 * nothing collapses, so the page does not change height while you wait, which is
 * the part of a flicker that actually loses your place.
 *
 * It covers the pane's BODY and not its header: the picker up there is what
 * someone reaches for when a log is slow or unreadable, and an overlay across it
 * would take away the only way out.
 *
 * Deliberately NOT Mantine's `LoadingOverlay`: it brings its own surface colour,
 * its own z-index scale and a `Loader` sized off the theme, none of which are
 * this view's tokens — the last three stock controls put here all had to come
 * back out for the same reason. */
export const PaneLoading = ({ pending }: PaneLoadingProps) => {
  const { t } = useTranslation();
  const shown = useSettleDelay(pending);
  if (!shown) return null;

  return (
    // Plain elements, not Mantine's `Box`: this draws two tokened rectangles and
    // needs none of the theme, and a `Box` here would demand a `MantineProvider`
    // in every tree that mounts it.
    //
    // `aria-busy` on the overlay itself, and a status role, so the wait is
    // announced once rather than as every row underneath changing.
    <div className="analysis-pane-loading" role="status" aria-busy aria-label={t("ui.logs.pane-loading")}>
      <div className="analysis-spinner" aria-hidden />
    </div>
  );
};
