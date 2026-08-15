import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { explainCapHit, type ExplainInput, type ExplainSection } from "@/pages/logs/view/events/capExplain";

// Keys pass through verbatim so a row can be addressed by the key it renders;
// interpolation params are appended so a reason inside a wrapper key stays
// findable ("cap-tt-not-counted cap-excl-other-class").
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${Object.values(params).join(" ")}`,
    i18n: { language: "en" },
  }),
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
    instance_snapshot: null,
  },
  characterType: "Pl0300",
};

const renderPanel = (over: Partial<ExplainInput> = {}) =>
  render(
    <MantineProvider>
      <CapDetailPanel sections={explainCapHit({ ...input, ...over })} />
    </MantineProvider>
  );

const renderSections = (sections: ExplainSection[]) =>
  render(
    <MantineProvider>
      <CapDetailPanel sections={sections} />
    </MantineProvider>
  );

const line = (key: string) => document.querySelector<HTMLElement>(`[data-cap-line="${key}"]`);
const lineText = (key: string) => line(key)?.textContent ?? "";
const hover = (element: Element) => fireEvent.mouseEnter(element, { clientX: 100, clientY: 100 });

describe("CapDetailPanel", () => {
  it("renders a section per stage of the derivation", () => {
    renderPanel();
    expect(document.querySelectorAll("[data-cap-section]")).toHaveLength(5);
  });

  it("formats each value kind its own way", () => {
    renderPanel();
    // A count is grouped, a percentage is signed, an f32 intermediate is raw.
    expect(lineText("result")).toContain("5,399");
    expect(lineText("game")).toContain("+2,728.99%");
    expect(lineText("span")).toContain("0.10000002384185791");
    expect(lineText("flags")).toContain("0x1");
  });

  it("keeps the formula out of the section body and serves it on hover", () => {
    renderPanel();
    const base = document.querySelector('[data-cap-section="base"]')!;
    expect(base.textContent).not.toContain("base = trunc(");

    hover(base.querySelector('[aria-label="ui.debug.cap-formula"]')!);
    const card = screen.getByTestId("cap-formula-card-base");
    expect(card.textContent).toContain("base = trunc(");
    expect(card.textContent).toContain("trunc( 4999 + (5999 - 4999) x (0.54 - 0.5) / (0.6 - 0.5) )");
  });

  it("keeps provenance out of the row and serves it on hover", () => {
    renderPanel();
    const row = line("rate")!;
    expect(row.textContent).not.toContain("event.attack_rate");

    hover(row);
    expect(screen.getByTestId("cap-line-card-rate").textContent).toContain("event.attack_rate");
  });

  it("gives a row a floor width instead of letting a long value bleed", () => {
    // jsdom does no layout, so the guarantee that CAN be asserted is the one
    // that produces it: the row claims a minimum width, and the value column
    // never wraps or shrinks.
    renderPanel();
    const row = line("span");
    expect(row?.style.minWidth).toBe(`${MIN_ROW_WIDTH}px`);

    const value = row?.children[1] as HTMLElement;
    expect(value.style.whiteSpace).toBe("nowrap");
    expect(value.style.flexShrink).toBe("0");
  });

  it("renders a missing fact as a dash, never as a zero", () => {
    // A zero here would read as "the cap-up record was zero", which is a
    // different and much more alarming claim than "we never captured it".
    renderPanel();
    expect(lineText("record")).toContain("—");
  });

  it("marks a rejected source and serves the reason on hover", () => {
    renderPanel({
      loadout: {
        sigils: [],
        summons: [],
        weaponState: null,
        weaponInfo: null,
        overmasteryInfo: { overmasteries: [{ id: 0x0b0e4311, flags: 1, value: 40 }] },
      },
    });
    const row = line("om-0-0b0e4311")!;
    // The reason is not inline any more — the row is marked and the hover card
    // carries the phrase.
    expect(row.dataset.capExcluded).toBe("other-class");
    expect(row.textContent).not.toContain("ui.debug.cap-excl-other-class");

    hover(row);
    expect(screen.getByTestId("cap-line-card-om-0-0b0e4311").textContent).toContain("ui.debug.cap-excl-other-class");
  });

  it("distinguishes 'ruled out' from 'could not be resolved' in the marker", () => {
    renderSections([
      {
        key: "s",
        titleKey: "t",
        formula: null,
        substituted: null,
        unavailableKey: null,
        lines: [
          {
            key: "off",
            name: { kind: "literal", value: "inactive" },
            value: { kind: "percent", value: 10 },
            excluded: "conditional",
          },
          {
            key: "open",
            name: { kind: "literal", value: "unknown" },
            value: { kind: "percent", value: 10 },
            excluded: "gate-unrecorded",
          },
        ],
      },
    ]);
    expect(line("off")!.querySelector('[aria-label="ui.debug.cap-marker-off"]')).toBeTruthy();
    expect(line("open")!.querySelector('[aria-label="ui.debug.cap-marker-unknown"]')).toBeTruthy();
  });

  it("names the missing fact when a section cannot be derived", () => {
    renderPanel({ characterType: undefined });
    expect(screen.getByText("ui.debug.cap-no-character")).toBeTruthy();
  });

  it("serves the standing post-cap caveat from the note icon", () => {
    renderPanel();
    const section = document.querySelector('[data-cap-section="postcap"]')!;
    expect(section.textContent).not.toContain("ui.debug.cap-postcap-note");

    hover(section.querySelector('[aria-label="ui.debug.cap-note"]')!);
    expect(screen.getByTestId("cap-note-card-postcap").textContent).toContain("ui.debug.cap-postcap-note");
  });
});
