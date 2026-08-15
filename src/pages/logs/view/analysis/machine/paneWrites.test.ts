import { describe, expect, it } from "vitest";

import { paneRemovalWrites, sharedControlWrites } from "./paneWrites";
import { setHostility, setMetric } from "./transitions";

/** A URL as a plain map, read the way the frame's bulk `useQueryStates` reads
 * one: an absent key is null, never undefined. */
const reader = (params: Record<string, string>) => (key: string) => params[key] ?? null;

describe("sharedControlWrites", () => {
  it("writes the shared field once, unsuffixed", () => {
    const writes = sharedControlWrites(2, reader({ metric: "damage" }), (state) => setMetric(state, "taken"));

    expect(writes.metric).toBe("taken");
    expect(writes).not.toHaveProperty("metric1");
  });

  // Both shared transitions clear PANE fields — a side swap invalidates every
  // pane's actor pins, not just the pane whose control was clicked. A control
  // that only rewrote pane 0 would leave pane 1 pinned to an actor from the
  // universe it just left.
  it("clears every pane's pins on a side swap, not just pane 0's", () => {
    const writes = sharedControlWrites(
      2,
      reader({ side: "friendly", src: "1", tgt: "2", src1: "3", tgt1: "4" }),
      (state) => setHostility(state, "enemy")
    );

    expect(writes.side).toBe("enemy");
    expect(writes.src).toBeNull();
    expect(writes.tgt).toBeNull();
    expect(writes.src1).toBeNull();
    expect(writes.tgt1).toBeNull();
  });

  it("leaves a pane field the transition kept where it was", () => {
    const writes = sharedControlWrites(2, reader({ metric: "damage", src: "1", src1: "3" }), (state) =>
      setMetric(state, "stun")
    );

    expect(writes.src).toBe("1");
    expect(writes.src1).toBe("3");
  });

  // Each pane decodes its OWN keys: a transition that reads a pin (setMetric
  // keeps an ability that crosses metrics) must see the pin of the pane it is
  // being applied to.
  it("applies the transition to each pane's own state", () => {
    const writes = sharedControlWrites(2, reader({ metric: "damage", by: "source", by1: "target" }), (state) =>
      setMetric(state, "taken")
    );

    // setMetric clears the grouping override wherever it was set.
    expect(writes.by).toBeNull();
    expect(writes.by1).toBeNull();
  });

  it("covers a single pane too, which is the view before anything is compared", () => {
    const writes = sharedControlWrites(1, reader({ metric: "damage" }), (state) => setMetric(state, "sba"));

    expect(writes.metric).toBe("sba");
    expect(Object.keys(writes).filter((key) => key.endsWith("1"))).toEqual([]);
  });
});

describe("paneRemovalWrites", () => {
  it("moves the pane above the removed one down onto its keys", () => {
    const writes = paneRemovalWrites(3, 1, reader({ src1: "1", src2: "2", aura2: "a" }));

    expect(writes.src1).toBe("2");
    expect(writes.aura1).toBe("a");
  });

  // nuqs keeps a param nothing reads, so an uncleared `src2` lies dormant and
  // revives on whatever log later occupies pane 2.
  it("clears the index left vacant at the top", () => {
    const writes = paneRemovalWrites(3, 1, reader({ src1: "1", src2: "2", aura2: "a" }));

    expect(writes.src2).toBeNull();
    expect(writes.aura2).toBeNull();
  });

  it("clears the removed pane's own keys when it was the last one", () => {
    const writes = paneRemovalWrites(2, 1, reader({ src1: "1", aura1: "a" }));

    expect(writes.src1).toBeNull();
    expect(writes.aura1).toBeNull();
  });

  // Pane 0's keys are the BARE ones — clearing them would wipe the pins of the
  // log still on screen.
  it("never touches pane 0's keys", () => {
    const writes = paneRemovalWrites(2, 1, reader({ src: "9", src1: "1" }));

    expect(writes).not.toHaveProperty("src");
  });

  it("refuses to remove pane 0, which is the page itself", () => {
    expect(paneRemovalWrites(2, 0, reader({ src: "9", src1: "1" }))).toEqual({});
  });

  it("writes nothing for a pane that is not there", () => {
    expect(paneRemovalWrites(2, 5, reader({ src1: "1" }))).toEqual({});
  });
});
