import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnimatedHeight } from "./AnimatedHeight";

describe("AnimatedHeight", () => {
  it("renders its children", () => {
    render(
      <AnimatedHeight>
        <p>inside</p>
      </AnimatedHeight>
    );

    expect(screen.getByText("inside")).toBeTruthy();
  });

  it("leaves the box unsized where nothing can be measured", () => {
    // jsdom lays nothing out, so every box measures zero. Committing that
    // would collapse the panel to a 0px window over its own content — with
    // `overflow: hidden`, an invisible card in every test that renders one.
    // Unmeasurable means "let it size itself", which is also the honest
    // behaviour on the first frame in a real browser.
    const { container } = render(
      <AnimatedHeight>
        <p>inside</p>
      </AnimatedHeight>
    );

    expect(container.firstElementChild).toBeInstanceOf(HTMLElement);
    expect((container.firstElementChild as HTMLElement).style.height).toBe("");
  });
});
