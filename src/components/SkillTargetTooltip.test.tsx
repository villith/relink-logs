import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SkillTargetState } from "@/types";
import { SkillTargetTooltip } from "./SkillTargetTooltip";

const renderTooltip = (targets: SkillTargetState[]) =>
  render(
    <MantineProvider>
      <table>
        <tbody>
          <SkillTargetTooltip label="Zeta" targets={targets} showFullValues={false} color="#ff0000">
            <tr>
              <td>row content</td>
            </tr>
          </SkillTargetTooltip>
        </tbody>
      </table>
    </MantineProvider>
  );

describe("SkillTargetTooltip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    await i18next.init({
      lng: "en",
      resources: { en: { translation: { enemies: { Em1000: "Test Boss" } } } },
    });
  });

  it("renders children without any breakdown when there are no targets", () => {
    renderTooltip([]);

    expect(screen.getByText("row content")).toBeTruthy();
    expect(screen.queryByText("Test Boss")).toBeNull();
  });

  it("renders children without any breakdown when the total damage is zero", () => {
    renderTooltip([{ enemyType: "Em1000", hits: 0, totalDamage: 0 }]);

    expect(screen.getByText("row content")).toBeTruthy();
    expect(screen.queryByText("Test Boss")).toBeNull();
  });

  it("does not mount the breakdown until the row is hovered", () => {
    renderTooltip([{ enemyType: "Em1000", hits: 5, totalDamage: 1000 }]);

    // Lazy: the breakdown must be absent from the DOM before hover, so a page of
    // rows does not carry a hidden tooltip subtree each.
    expect(screen.queryByText("Test Boss")).toBeNull();

    fireEvent.mouseEnter(screen.getByText("row content").closest("tr")!);
    expect(screen.getByText("Test Boss")).toBeTruthy();

    fireEvent.mouseLeave(screen.getByText("row content").closest("tr")!);
    expect(screen.queryByText("Test Boss")).toBeNull();
  });

  it("measures the breakdown on the hover that mounts it, so it is visible right away", () => {
    // jsdom has no layout: hand the component a size so the measure-then-show
    // step has something to find.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 300,
      height: 120,
    } as DOMRect);

    renderTooltip([{ enemyType: "Em1000", hits: 5, totalDamage: 1000 }]);
    fireEvent.mouseEnter(screen.getByText("row content").closest("tr")!, { clientX: 400, clientY: 300 });

    const tooltip = screen.getByTestId("skill-target-tooltip");
    expect(tooltip.style.visibility).toBe("visible");
    // Grows up from the cursor: 300 - 6 (offset) - 120 (measured height).
    expect(tooltip.style.top).toBe("174px");
  });
});
