import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** Where a Back button goes when the link that opened the screen named nothing. */
export const DEFAULT_BACK_TO = "/logs";

/** Route state a link attaches to say where the screen it opens should go back to. */
export type BackToState = { backTo?: string };

/** Route state is ours, but it outlives the code that wrote it, and a value that
 * is not an absolute in-app path would navigate somewhere strange. */
const asDestination = (state: unknown): string | null => {
  const backTo = (state as BackToState | null)?.backTo;
  return typeof backTo === "string" && backTo.startsWith("/") ? backTo : null;
};

/**
 * A screen's Back button, answering "up" rather than "back".
 *
 * The quest detail used to walk history — right for the reader who followed a
 * link into it, wrong for everyone else. The header's per-tab memory restores
 * the Logs tab to the last quest detail open under it, so clicking *Logs*
 * could land on a detail whose history-back was the Toolbox or Settings tab
 * the reader had just left. Back would then throw them out of the tab they had
 * only just clicked into.
 *
 * So the destination is declared by the link that opens the screen, as
 * `state={{ backTo: "..." }}`, and defaults to the quest list. Per-tab memory
 * stores only `pathname + search`, so a restored detail carries no state and
 * takes the default — which is exactly the case that was broken.
 *
 * Keyboard/browser Back still walks real history. The two gestures differ on a
 * restored detail, and that is right: a button on a screen means "up", a
 * browser control means "back".
 */
export const useBackTo = (fallback: string = DEFAULT_BACK_TO) => {
  const navigate = useNavigate();
  const { state } = useLocation();
  const target = asDestination(state) ?? fallback;
  return useCallback(() => navigate(target), [navigate, target]);
};
