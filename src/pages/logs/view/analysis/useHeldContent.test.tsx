import { render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useHeldContent } from "./useHeldContent";

/** A stand-in for the pane: it renders whatever reading it is given, and holds
 * the previous one while the new one is still loading. */
const Pane = ({ reading, holding }: { reading: ReactNode; holding: boolean }) => (
  <div data-testid="pane">{useHeldContent(reading, holding)}</div>
);

const shown = () => screen.getByTestId("pane").textContent;

describe("useHeldContent", () => {
  it("draws what it is given while settled", () => {
    render(<Pane reading="Stun" holding={false} />);
    expect(shown()).toBe("Stun");
  });

  /** THE STUN → DAMAGE TAKEN CASE. The tab flips instantly; the aggregates
   * answering it are a fetch away. Whatever the pane can compute in between is
   * not an answer to either question, so the previous one stays. */
  it("keeps the previous reading while the next one loads", () => {
    const { rerender } = render(<Pane reading="Stun" holding={false} />);
    rerender(<Pane reading="Damage Taken (empty)" holding />);

    expect(shown()).toBe("Stun");
  });

  it("changes once, when the new reading is ready", () => {
    const { rerender } = render(<Pane reading="Stun" holding={false} />);
    rerender(<Pane reading="Damage Taken (empty)" holding />);
    rerender(<Pane reading="Damage Taken" holding={false} />);

    expect(shown()).toBe("Damage Taken");
  });

  it("holds through as many renders as the wait takes", () => {
    const { rerender } = render(<Pane reading="Stun" holding={false} />);
    rerender(<Pane reading="A" holding />);
    rerender(<Pane reading="B" holding />);
    rerender(<Pane reading="C" holding />);

    expect(shown()).toBe("Stun");
  });

  // A log swap has nothing to hold — the pane store drops the previous fight on
  // purpose, and holding one log's figures under another's title is the failure
  // it exists to prevent. The caller signals that by passing `holding: false`
  // with nothing to draw, which clears what was held.
  it("forgets the held reading when the caller stops holding", () => {
    const { rerender } = render(<Pane reading="Stun" holding={false} />);
    rerender(<Pane reading={null} holding={false} />);
    rerender(<Pane reading="Damage Taken (empty)" holding />);

    expect(shown()).toBe("");
  });

  /** The held copy is last render's ELEMENT, not a snapshot of its DOM, so the
   * components inside keep their instances — and therefore their state, their
   * scroll positions and their own subscriptions — across the wait. A table
   * whose expanded rows collapsed every time a fetch went out would be its own
   * kind of flicker. */
  it("holds a picture without remounting what drew it", () => {
    const Counter = () => {
      const [mounts] = useState(() => ({ id: Math.random() }));
      return <span>{String(mounts.id)}</span>;
    };
    const { rerender } = render(<Pane reading={<Counter />} holding={false} />);
    const first = shown();

    rerender(<Pane reading={<Counter />} holding />);

    expect(shown()).toBe(first);
  });
});
