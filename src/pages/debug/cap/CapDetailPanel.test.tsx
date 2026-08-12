import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { explainCapHit, type ExplainInput } from "@/pages/logs/view/events/capExplain";

// Keys pass through verbatim so a row can be addressed by the key it renders.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { CapDetailPanel, MIN_ROW_WIDTH } from "./CapDetailPanel";

const input: ExplainInput = {
  hit: {
    damage: 152_737,
    damage_cap: 152_737,
    base_damage: 400_000,
    attack_rate: 0.54,
    class_flags: 0x1,
    flags: 0,
  },
  characterType: "Pl0300",
};

const renderPanel = (over: Partial<ExplainInput> = {}) =>
  render(
    <MantineProvider>
      <CapDetailPanel sections={explainCapHit({ ...input, ...over })} />
    </MantineProvider>
  );

const lineText = (key: string) => document.querySelector(`[data-cap-line="${key}"]`)?.textContent ?? "";

describe("CapDetailPanel", () => {
  it("renders a section per stage of the derivation", () => {
    renderPanel();
    expect(document.querySelectorAll("[data-cap-section]")).toHaveLength(5);
  });

  it("shows the substituted expression beside the symbolic one", () => {
    renderPanel();
    const base = document.querySelector('[data-cap-section="base"]')?.textContent ?? "";
    expect(base).toContain("base = trunc(");
    expect(base).toContain("trunc( 4999 + (5999 - 4999) x (0.54 - 0.5) / (0.6 - 0.5) )");
  });

  it("formats each value kind its own way", () => {
    renderPanel();
    // A count is grouped, a percentage is signed, an f32 intermediate is raw.
    expect(lineText("result")).toContain("5,399");
    expect(lineText("game")).toContain("+2,728.99%");
    expect(lineText("span")).toContain("0.10000002384185791");
    expect(lineText("flags")).toContain("0x1");
  });

  it("gives a row a floor width instead of letting a long value bleed", () => {
    // jsdom does no layout, so the guarantee that CAN be asserted is the one
    // that produces it: the row claims a minimum width, and the value column
    // never wraps or shrinks. Without both, `0.10000002384185791` overflowed
    // its 130px column and painted over the provenance column beside it.
    renderPanel();
    const row = document.querySelector<HTMLElement>('[data-cap-line="span"]');
    expect(row?.style.minWidth).toBe(`${MIN_ROW_WIDTH}px`);

    const value = row?.children[1] as HTMLElement;
    expect(value.style.whiteSpace).toBe("nowrap");
    expect(value.style.flexShrink).toBe("0");
  });

  it("sets identifiers in monospace and prose annotations in the body font", () => {
    // Why the provenance column overran twice: a 49-character sentence needs
    // about a third more width in monospace than in the body font, for no
    // legibility at all. Only literals wear the monospace face.
    renderPanel();
    const mono = (lineKey: string) =>
      (document.querySelector<HTMLElement>(`[data-cap-line="${lineKey}"]`)?.children[2] as HTMLElement).style
        .fontFamily;

    // `event.attack_rate` is a field path; the walk-arm annotation is a sentence.
    expect(mono("rate")).not.toBe("");
    expect(mono("branch")).toBe("");
  });

  it("wraps a long provenance instead of ellipsising it", () => {
    // This column is the whole point of the panel — an ellipsised provenance
    // answers nothing, so a second line is the right cost.
    renderPanel();
    const source = document.querySelector<HTMLElement>('[data-cap-line="branch"]')?.children[2] as HTMLElement;
    expect(source.style.overflowWrap).toBe("anywhere");
    expect(source.className).not.toContain("truncate");
  });

  it("renders a missing fact as a dash, never as a zero", () => {
    // A zero here would read as "the cap-up record was zero", which is a
    // different and much more alarming claim than "we never captured it".
    renderPanel();
    expect(lineText("record")).toContain("—");
  });

  it("keeps a rejected source visible with the reason it was rejected", () => {
    renderPanel({
      loadout: {
        sigils: [],
        summons: [],
        weaponState: null,
        weaponInfo: null,
        overmasteryInfo: { overmasteries: [{ id: 0x0b0e4311, flags: 1, value: 40 }] },
      },
    });
    expect(lineText("om-0-0b0e4311")).toContain("ui.debug.cap-excl-other-class");
  });

  it("names the missing fact when a section cannot be derived", () => {
    renderPanel({ characterType: undefined });
    expect(screen.getByText("ui.debug.cap-no-character")).toBeTruthy();
  });

  it("carries the standing caveat about the post-cap chain", () => {
    renderPanel();
    expect(screen.getByText("ui.debug.cap-postcap-note")).toBeTruthy();
  });
});
