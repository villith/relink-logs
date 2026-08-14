import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AmountCell, SHOWS_CAP_CARD } from "./AmountCell";

// Same stand-in the rest of this folder's tests use: `t` returns the key, so an
// assertion names the key it means rather than a translation that can change.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const capHit = { damage: 1_500_000, damage_cap: 1_000_000, base_damage: 4_000_000, attack_rate: 2.5, class_flags: 0x1 };

const sigilOf = (traitId: number, level: number) => ({
  firstTraitId: traitId,
  firstTraitLevel: level,
  secondTraitId: 0,
  secondTraitLevel: 0,
  sigilId: 1,
  equippedCharacter: 0,
  sigilLevel: 1,
  acquisitionCount: 0,
  notificationEnum: 0,
});

const sigilLoadout = (traitId: number, level: number) => ({
  sigils: [sigilOf(traitId, level)],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
});

const renderCell = (props: Parameters<typeof AmountCell>[0]) =>
  render(
    <MantineProvider>
      <AmountCell {...props} />
    </MantineProvider>
  );

/** `fireEvent`, like `CursorCard`'s own tests: the card opens on `mouseEnter`
 * and `user-event` is not a dependency of this project. */
const hover = (text: string) => fireEvent.mouseEnter(screen.getByText(text), { clientX: 10, clientY: 10 });

describe("AmountCell", () => {
  it("renders the amount", () => {
    renderCell({ amount: 1_500_000, capHit, width: 78 });
    expect(screen.getByText("1,500,000")).toBeTruthy();
  });

  it("renders nothing for a row with no amount", () => {
    const { container } = renderCell({ amount: null, capHit: null, width: 78 });
    expect(container.querySelector('[data-cell="amount"]')?.textContent).toBe("");
  });

  // `skipIf` tests below assert the cap card's contents, and the card is
  // temporarily disabled in `AmountCell` (`SHOWS_CAP_CARD`). Gated on the
  // switch itself rather than `.skip`, so flipping it back restores the card
  // AND its coverage in the same edit.
  it.skipIf(!SHOWS_CAP_CARD)("shows the cap card on hover of a damage row", () => {
    renderCell({ amount: 1_500_000, capHit, width: 78 });
    hover("1,500,000");
    const card = screen.getByTestId("cap-card");
    expect(card.querySelector('[data-cap-row="cap"]')?.textContent).toContain("ui.logs.cap-logged");
    // Every derived row is present, so the card explains the hit rather than
    // restating the cell.
    expect(card.querySelectorAll("[data-cap-row]").length).toBe(6);
  });

  it("shows no card for a row that carries no cap fact", () => {
    renderCell({ amount: 12, capHit: null, width: 78 });
    hover("12");
    expect(screen.queryByTestId("cap-card")).toBeNull();
  });

  // The whole point of the card: the game's own total, and how much of it the
  // model can account for. With no loadout to reconstruct from, that is all of
  // it — the alternative, reporting zero unaccounted, would claim a
  // reconstruction that never ran.
  it.skipIf(!SHOWS_CAP_CARD)("shows the game's cap-up total and the unaccounted remainder", () => {
    renderCell({
      amount: 1_500_000,
      capHit,
      playerCapUp: { normal: 13.13, skill: 15.18, sba: 12.16 },
      width: 78,
    });
    hover("1,500,000");
    const card = screen.getByTestId("cap-card");
    expect(card.querySelector('[data-cap-row="capup"]')?.textContent).toContain("1,313%");
    expect(card.querySelector('[data-cap-row="unaccounted"]')?.textContent).toContain("1,313%");
    // 1,000,000 / 14.13
    expect(card.querySelector('[data-cap-row="basecap"]')?.textContent).toContain("70,771");
  });

  // A failed grid check refined by the actor's own observed states: a K
  // strictly inside their bracket renders the ease, and the remainder is the
  // easing gap rather than an unaccounted term.
  it.skipIf(!SHOWS_CAP_CARD)("renders a mid-ease hit as a state transition", async () => {
    const { gameLadderBase, ladderCurveFor } = await import("./capLadder");
    const base = gameLadderBase(ladderCurveFor("Pl1900", 0)!, 0.5);
    renderCell({
      amount: 1_500_000,
      capHit: { ...capHit, damage_cap: Math.trunc(base * 24.115), attack_rate: 0.5, class_flags: 0 },
      characterType: "Pl1900",
      gridStates: new Map([
        [
          "normal",
          new Map([
            [2401, 2],
            [2426, 1],
          ]),
        ],
      ]),
      width: 78,
    });
    hover("1,500,000");
    const card = screen.getByTestId("cap-card");
    expect(card.querySelector('[data-cap-row="verdict"]')?.textContent).toContain("ui.logs.cap-verdict-transition");
    expect(card.querySelector('[data-cap-row="unaccounted"]')?.textContent).toContain("ui.logs.cap-easing-gap");
  });

  // Selection is by the hit's OWN class. A Skybound Art must not be explained
  // with the Normal total, which is a different number entirely.
  it.skipIf(!SHOWS_CAP_CARD)("picks the cap-up matching the hit's attack class", () => {
    renderCell({
      amount: 1_500_000,
      capHit: { ...capHit, class_flags: 0x40000 },
      playerCapUp: { normal: 13.13, skill: 15.18, sba: 12.16 },
      width: 78,
    });
    hover("1,500,000");
    expect(screen.getByTestId("cap-card").querySelector('[data-cap-row="capup"]')?.textContent).toContain("1,216%");
  });

  // Without the ladder the record IS the total, and its components itemize it:
  // Fatebreaker L15 (+50%, fused into the record at load) shows as a sub-row
  // and comes off the record's own remainder.
  it.skipIf(!SHOWS_CAP_CARD)("itemizes the record's components and shrinks the unaccounted row", () => {
    renderCell({
      amount: 1_500_000,
      capHit,
      playerCapUp: { normal: 13.13, skill: 15.18, sba: 12.16 },
      loadout: sigilLoadout(0xd029fe08, 15),
      width: 78,
    });
    hover("1,500,000");
    const card = screen.getByTestId("cap-card");
    expect(card.querySelector('[data-cap-row="trait"]')?.textContent).toContain("50%");
    // 13.13 - 0.50
    expect(card.querySelector('[data-cap-row="unaccounted"]')?.textContent).toContain("1,263%");
  });

  // With the character known, the base comes from the game's own shipped
  // ladder, the total becomes per-hit (cap / base − 1), and the plain DMG Cap
  // trait — the one derived term the record does NOT contain — attributes
  // against it alongside the record.
  it.skipIf(!SHOWS_CAP_CARD)("uses the ladder base and the formula verdict when the character is known", () => {
    renderCell({
      amount: 152_737,
      capHit: { ...capHit, damage_cap: 152_737, attack_rate: 0.54 },
      playerCapUp: { normal: 13.13, skill: 15.18, sba: 12.16 },
      loadout: sigilLoadout(0xdc584f60, 65),
      characterType: "Pl0300",
      width: 78,
    });
    hover("152,737");
    const card = screen.getByTestId("cap-card");
    expect(card.querySelector('[data-cap-row="basecap"]')?.textContent).toContain("5,399");
    expect(card.querySelector('[data-cap-row="gamecapup"]')?.textContent).toContain("2,728.99%");
    expect(card.querySelector('[data-cap-row="verdict"]')?.textContent).toContain("✓");
    expect(card.querySelector('[data-cap-row="dmgcap"]')?.textContent).toContain("250%");
    // 27.2899… − 13.13 − 2.50
    expect(card.querySelector('[data-cap-row="unaccounted"]')?.textContent).toContain("1,165.99%");
  });

  it.skipIf(!SHOWS_CAP_CARD)("marks a conditional trait's row as a potential, outside the sum", () => {
    renderCell({
      amount: 152_737,
      capHit: { ...capHit, damage_cap: 152_737, attack_rate: 0.54 },
      playerCapUp: { normal: 13.13, skill: 15.18, sba: 12.16 },
      // Three Nova sigils: combined level 45, clamped to the table top (+500%).
      loadout: {
        ...sigilLoadout(0x1e1cecce, 15),
        sigils: [sigilOf(0x1e1cecce, 15), sigilOf(0x1e1cecce, 15), sigilOf(0x1e1cecce, 15)],
      },
      characterType: "Pl0300",
      width: 78,
    });
    hover("152,737");
    const card = screen.getByTestId("cap-card");
    expect(card.querySelector('[data-cap-row="conditional-1e1cecce"]')?.textContent).toContain("≤ 500%");
    // The potential does NOT shrink the remainder: 27.2899… − 13.13.
    expect(card.querySelector('[data-cap-row="unaccounted"]')?.textContent).toContain("1,415.99%");
  });

  // The per-hit channel: board cap nodes the conditions resolved. pl0300_000c
  // is "+15%, always" — active with no conditions at all — and it is NOT
  // inside the captured record (log 2573 reconciliation), so its derived
  // total attributes as its own row beside the record.
  it.skipIf(!SHOWS_CAP_CARD)("credits the derived channel total against the game total", () => {
    renderCell({
      amount: 152_737,
      capHit: { ...capHit, damage_cap: 152_737, attack_rate: 0.54 },
      playerCapUp: { normal: 13.13, skill: 15.18, sba: 12.16 },
      loadout: { ...sigilLoadout(0xd029fe08, 15), characterType: "Pl0300", skillboard: [0x0c] },
      characterType: "Pl0300",
      conditions: {},
      width: 78,
    });
    hover("152,737");
    const card = screen.getByTestId("cap-card");
    expect(card.querySelector('[data-cap-row="channel"]')?.textContent).toContain("15%");
    // 27.2899… − 13.13 − 0.15
    expect(card.querySelector('[data-cap-row="unaccounted"]')?.textContent).toContain("1,400.99%");
  });

  // A damage row from a log recorded before the cap capture carries the shape
  // with null members. `capCardRows` returns its lone `damage` row for that, and
  // a one-row card would only restate the number already in the cell.
  it("shows no card for a damage row whose log predates the cap fields", () => {
    const old = { damage: 12, damage_cap: null, base_damage: null, attack_rate: null, class_flags: null };
    renderCell({ amount: 12, capHit: old, width: 78 });
    hover("12");
    expect(screen.queryByTestId("cap-card")).toBeNull();
  });
});
