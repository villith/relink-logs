import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AmountCell } from "./AmountCell";

// Same stand-in the rest of this folder's tests use: `t` returns the key, so an
// assertion names the key it means rather than a translation that can change.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const capHit = { damage: 1_500_000, damage_cap: 1_000_000, base_damage: 4_000_000, attack_rate: 2.5, class_flags: 0x1 };

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

  it("shows the cap card on hover of a damage row", () => {
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
  // model can account for. With no source derived yet, that is all of it.
  it("shows the game's cap-up total and the unaccounted remainder", () => {
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

  // Selection is by the hit's OWN class. A Skybound Art must not be explained
  // with the Normal total, which is a different number entirely.
  it("picks the cap-up matching the hit's attack class", () => {
    renderCell({
      amount: 1_500_000,
      capHit: { ...capHit, class_flags: 0x40000 },
      playerCapUp: { normal: 13.13, skill: 15.18, sba: 12.16 },
      width: 78,
    });
    hover("1,500,000");
    expect(screen.getByTestId("cap-card").querySelector('[data-cap-row="capup"]')?.textContent).toContain("1,216%");
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
