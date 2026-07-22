/** Wraps `fn` so a burst of calls collapses to a single call on the next
 * animation frame, carrying the most recent arguments. Used to keep
 * cursor-following work (which fires per `mousemove` — up to ~1000/sec on
 * high-polling-rate mice) down to at most one reposition per frame.
 *
 * `raf`/`caf` are injectable so the coalescing can be tested deterministically;
 * they default to the real animation-frame scheduler. */
export function rafThrottle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  raf: (cb: () => void) => number = requestAnimationFrame,
  caf: (handle: number) => void = cancelAnimationFrame
): ((...args: Args) => void) & { cancel: () => void } {
  let handle: number | null = null;
  let lastArgs: Args | null = null;

  const throttled = (...args: Args) => {
    lastArgs = args;
    if (handle === null) {
      handle = raf(() => {
        handle = null;
        if (lastArgs) fn(...lastArgs);
      });
    }
  };

  throttled.cancel = () => {
    if (handle !== null) {
      caf(handle);
      handle = null;
    }
    lastArgs = null;
  };

  return throttled;
}
