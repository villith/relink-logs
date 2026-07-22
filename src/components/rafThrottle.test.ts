import { describe, expect, it, vi } from "vitest";

import { rafThrottle } from "./rafThrottle";

/** A manual animation-frame scheduler: `raf` queues callbacks, `flush` runs the
 * ones queued so far. Lets the throttle be tested without real timers. */
const makeScheduler = () => {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const raf = (cb: () => void) => {
    const handle = nextHandle++;
    callbacks.set(handle, cb);
    return handle;
  };
  const caf = (handle: number) => {
    callbacks.delete(handle);
  };
  const flush = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((cb) => cb());
  };
  return { raf, caf, flush };
};

describe("rafThrottle", () => {
  it("coalesces bursts of calls into a single invocation per frame with the latest args", () => {
    const { raf, caf, flush } = makeScheduler();
    const fn = vi.fn();
    const throttled = rafThrottle(fn, raf, caf);

    throttled(1);
    throttled(2);
    throttled(3);
    // Nothing runs until the frame does.
    expect(fn).not.toHaveBeenCalled();

    flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  it("schedules a fresh frame for calls made after the previous frame flushed", () => {
    const { raf, caf, flush } = makeScheduler();
    const fn = vi.fn();
    const throttled = rafThrottle(fn, raf, caf);

    throttled("a");
    flush();
    throttled("b");
    flush();

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "a");
    expect(fn).toHaveBeenNthCalledWith(2, "b");
  });

  it("cancel() drops a pending invocation", () => {
    const { raf, caf, flush } = makeScheduler();
    const fn = vi.fn();
    const throttled = rafThrottle(fn, raf, caf);

    throttled(1);
    throttled.cancel();
    flush();

    expect(fn).not.toHaveBeenCalled();
  });
});
