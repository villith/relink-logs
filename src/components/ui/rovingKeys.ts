import type { KeyboardEvent } from "react";

/** The keydown handler for a row of options driven by a roving tabindex — the
 * shared `PillGroup`, and the tablists built on top of it (the metric switcher,
 * the regroup strip).
 *
 * ArrowRight steps forward, ArrowLeft back, and only those two keys are
 * consumed: anything else falls through to the browser, so Tab still leaves the
 * row and the shortcut keys above still reach the page. Consumed means
 * `preventDefault`, which is what stops the arrows scrolling the panel under a
 * control that has just handled them.
 *
 * Spelled once rather than inlined at each row: three groups implementing the
 * same ARIA keyboard contract three times is how one of them ends up answering
 * Home/End (or not) differently from its siblings. What a step MEANS is still
 * each row's own business — the pills and tablists move the selection, the
 * regroup strip moves focus past disabled dimensions — so only the key contract
 * lives here.
 */
export const onArrowKeys =
  <T extends Element>(step: (delta: 1 | -1, event: KeyboardEvent<T>) => void) =>
  (event: KeyboardEvent<T>) => {
    if (event.key === "ArrowRight") step(1, event);
    else if (event.key === "ArrowLeft") step(-1, event);
    else return;
    event.preventDefault();
  };
