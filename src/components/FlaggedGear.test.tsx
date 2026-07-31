import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { LegalityFinding } from "@/types";

import { FlaggedGear, GearLine } from "./FlaggedGear";

/**
 * The invariant the whole shared-renderer refactor rests on: the Toolbox audit
 * page and the log view's gear tables must mark the SAME line for the same
 * finding. They used to disagree visibly — the audit page reddened the offending
 * line, the log view reddened the item's name — which told a reader "something
 * about this sigil is wrong" and left them to work out what.
 */
const line = (id: number, level: number): GearLine => ({ id, level, text: `Trait ${id}` });

const sigilLevelBreach: LegalityFinding = {
  rule: "sigilTraitLevel",
  subject: { kind: "sigil", index: 0 },
  observed: { kind: "level", value: 30 },
  allowed: { kind: "level", value: 15 },
  odds: null,
  evidence: null,
};

const renderGear = (props: Partial<Parameters<typeof FlaggedGear>[0]> = {}) =>
  render(
    <MantineProvider>
      <FlaggedGear
        name="Nazarbonju II"
        lines={[line(1, 30), line(2, 15)]}
        findings={[sigilLevelBreach]}
        explain="inline"
        {...props}
      />
    </MantineProvider>
  );

/** Mantine applies `c="red"` through a stylesheet layer that jsdom never
 * materialises, so the colour itself is unobservable here. `data-flagged` is
 * the same state said in the DOM, which is what makes this testable at all. */
const isMarked = (element: HTMLElement): boolean => element.dataset.flagged === "true";

describe("FlaggedGear", () => {
  beforeAll(async () => {
    // `initReactI18next` matters: the component reads `t` from `useTranslation`,
    // and without the React binding it renders raw keys rather than the string
    // this suite exists to check.
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation: { ui: { legality: { limit: { sigilTraitLevel: "max {{allowed}}" } } } } } },
    });
  });

  /** Red says WHICH line. The level-30 trait is the one the rule names, so it
   * takes the mark and the item's name is left alone. */
  it("marks the offending line rather than the item's name", () => {
    renderGear();

    expect(isMarked(screen.getByText("- Trait 1"))).toBe(true);
    expect(isMarked(screen.getByText("- Trait 2"))).toBe(false);
    expect(isMarked(screen.getByText("Nazarbonju II"))).toBe(false);
  });

  /** With nothing to pin the claim to, the name is the only thing left that can
   * carry it — a claim with no visible mark at all is worse than a broad one. */
  it("falls back to the name when no line can be marked", () => {
    renderGear({ lines: [] });

    expect(isMarked(screen.getByText("Nazarbonju II"))).toBe(true);
  });

  /** The audit page has a wide pane and prints the limit beside the line. */
  it("prints the limit beside the line when asked to explain inline", () => {
    renderGear();

    expect(screen.getByText("max 15")).toBeTruthy();
  });

  /** The log view stacks four players across a table and has nowhere to put it,
   * so the same words go in the tooltip instead of wrapping the column. */
  it("keeps the limit out of the column when explaining by tooltip", () => {
    renderGear({ explain: "tooltip" });

    expect(screen.queryByText("max 15")).toBeNull();
    // Still marked, though: the highlighting is what the two surfaces share.
    expect(isMarked(screen.getByText("- Trait 1"))).toBe(true);
  });

  /** A clean item renders exactly as it did before there were any rules. */
  it("marks nothing when there are no findings", () => {
    renderGear({ findings: [] });

    expect(isMarked(screen.getByText("Nazarbonju II"))).toBe(false);
    expect(isMarked(screen.getByText("- Trait 1"))).toBe(false);
  });
});
