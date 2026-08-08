import { describe, expect, it } from "vitest";

import { chartPlayerIndexes } from "./chartIndexes";

const PARTY = [0, 1, 2, 3];

describe("chartPlayerIndexes", () => {
  it("draws the whole party when nothing is pinned", () => {
    expect(chartPlayerIndexes({ party: PARTY, sourcePin: null, hostility: "friendly", overlaid: false })).toEqual(
      PARTY
    );
  });

  it("narrows to the pinned player", () => {
    // The table has narrowed to that player, and a plot still drawing the
    // whole party answers a question nobody asked of it.
    expect(chartPlayerIndexes({ party: PARTY, sourcePin: 2, hostility: "friendly", overlaid: false })).toEqual([2]);
  });

  it("keeps the whole party while something overlays the lines", () => {
    // An overlay REPLACES these series, so narrowing them decides nothing —
    // and the party set is what the overlay's own builders were given.
    expect(chartPlayerIndexes({ party: PARTY, sourcePin: 2, hostility: "friendly", overlaid: true })).toEqual(PARTY);
  });

  it("keeps the whole party when the pin is an enemy, not a player", () => {
    // On the enemy side a `source` pin is a SPAWN segment, in its own id
    // space. Filtering player indexes by it drops the whole party — or worse,
    // silently keeps whichever player's index happens to equal the segment.
    expect(chartPlayerIndexes({ party: PARTY, sourcePin: 2, hostility: "enemy", overlaid: false })).toEqual(PARTY);
  });

  it("keeps the whole party when the pin names no player in it", () => {
    // A pin can outlive the party it was set against — a bookmarked link, or
    // the scoped reparse dropping a member. An empty plot is worse than the
    // unnarrowed one, and says nothing about why it is empty.
    expect(chartPlayerIndexes({ party: PARTY, sourcePin: 9, hostility: "friendly", overlaid: false })).toEqual(PARTY);
  });
});
