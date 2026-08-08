import { useSyncExternalStore } from "react";

/** The single shared read of the modifier, and everyone waiting on it.
 *
 * ONE subscription for the whole app rather than one per hook call. The
 * timeline wraps every mark in a `HoverCard`, so a busy fight mounts thousands
 * of them — a listener per card would put thousands of handlers on `window`,
 * every one of them invoked on every keystroke anywhere in the app. */
let ctrlHeld = false;
const listeners = new Set<() => void>();

/** Commits only on CHANGE. Holding a key fires `keydown` at the OS repeat
 * rate, and waking every card tens of times a second says nothing new. */
const commit = (next: boolean) => {
  if (next === ctrlHeld) return;
  ctrlHeld = next;
  for (const notify of listeners) notify();
};

const sync = (event: KeyboardEvent) => commit(event.ctrlKey);
const clear = () => commit(false);

const subscribe = (notify: () => void): (() => void) => {
  if (listeners.size === 0) {
    window.addEventListener("keydown", sync, { passive: true });
    window.addEventListener("keyup", sync, { passive: true });
    window.addEventListener("blur", clear);
  }
  listeners.add(notify);

  return () => {
    listeners.delete(notify);
    if (listeners.size > 0) return;
    window.removeEventListener("keydown", sync);
    window.removeEventListener("keyup", sync);
    window.removeEventListener("blur", clear);
    // Nothing is watching any more, so a release that happens now goes
    // unheard — the next subscriber must not inherit a hold that already
    // ended, for the same reason `blur` clears.
    ctrlHeld = false;
  };
};

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
 *   repeat rate; a state commit per event would re-render the open card — and
 *   the card is inside `CursorCard`, which re-renders on every cursor frame
 *   already — tens of times a second for no new information.
 * - **It clears on blur.** Alt+Tab away mid-hold and the `keyup` is delivered
 *   to the window that took focus, never to this one. Without this the flag
 *   stays stuck true and the next card opens detailed with nothing held.
 * - **It subscribes ONCE, however many cards read it.** See `subscribe`. */
export const useCtrlHeld = (): boolean => useSyncExternalStore(subscribe, () => ctrlHeld);
