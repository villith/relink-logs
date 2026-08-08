import { useEffect, useState } from "react";

/** Whether the Ctrl key is held RIGHT NOW.
 *
 * The hover cards' detail modifier: a card reads this to decide whether to
 * show its full contents or the summary it shows at rest (see `HoverCardBody`).
 *
 * Four things this gets right that a naive listener would not:
 *
 * - **It observes; it never intercepts.** Both listeners are passive and
 *   neither calls `preventDefault` — `blockBrowserShortcuts` (src/utils.ts)
 *   already claims Ctrl+J/P/U in the CAPTURE phase, and a second handler
 *   fighting it over the same chords is how a modifier read turns into a
 *   swallowed shortcut.
 * - **It reads the modifier FLAG, not the Control key.** Every keyboard event
 *   carries `ctrlKey`, so Ctrl+Shift and "some other key pressed while Ctrl is
 *   already down" both read correctly, whatever order the two went down in.
 *   Watching for `key === "Control"` would miss all of that.
 * - **It commits only on CHANGE.** Holding a key fires `keydown` at the OS
 *   repeat rate; a `setState` per event would re-render the open card — and
 *   the card is inside `CursorCard`, which re-renders on every cursor frame
 *   already — tens of times a second for no new information.
 * - **It clears on blur.** Alt+Tab away mid-hold and the `keyup` is delivered
 *   to the window that took focus, never to this one. Without this the flag
 *   stays stuck true and the next card opens detailed with nothing held. */
export const useCtrlHeld = (): boolean => {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    // `setHeld`'s updater form rather than a comparison against `held`: this
    // effect deliberately has no dependency on the value it sets, so it can
    // subscribe once for the hook's whole life instead of resubscribing on
    // every press. React bails out of a re-render when the updater returns
    // the identical value, which is what makes the repeat keydowns free.
    const sync = (event: KeyboardEvent) =>
      setHeld((previous) => (previous === event.ctrlKey ? previous : event.ctrlKey));
    const clear = () => setHeld((previous) => (previous ? false : previous));

    window.addEventListener("keydown", sync, { passive: true });
    window.addEventListener("keyup", sync, { passive: true });
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  return held;
};
