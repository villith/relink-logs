import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EventRowsTable, KIND_COLORS } from "./EventsTab";
import { EVENT_KINDS, type EventRow } from "./eventRows";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const ROWS: EventRow[] = [
  {
    timeMs: 1500,
    kind: "damage",
    sourceIndex: 0,
    targetIndex: 9,
    targetSpace: "spawn",
    abilityKey: "Normal:100",
    statusKey: null,
    statusId: null,
    detailKey: null,
    amount: 18204,
    capHit: { damage: 18204, damage_cap: 1_000_000, base_damage: 4_000_000, attack_rate: 2.5 },
  },
  {
    timeMs: 41880,
    kind: "death",
    sourceIndex: 1,
    targetIndex: null,
    targetSpace: "actor",
    abilityKey: null,
    statusKey: null,
    statusId: null,
    detailKey: "ui.logs.events-died",
    amount: null,
    capHit: null,
  },
  {
    timeMs: 4000,
    kind: "status",
    sourceIndex: 3,
    targetIndex: 1,
    targetSpace: "actor",
    abilityKey: null,
    statusKey: "status:77:210:4242",
    statusId: 77,
    detailKey: null,
    amount: 2,
    capHit: null,
  },
];

/** Indexes 0 and 1 stand in for the party; anything else is an enemy spawn, so
 * the two branches of the one actor resolver are both exercised. */
const LABELS = {
  actor: (index: number, _atMs: number, space: string) =>
    index < 2
      ? { name: `player-${index}`, iconUrl: `/pl${index}.png`, color: "#36B37E" }
      : { name: `enemy-${index}-${space}`, color: "#F06595" },
  ability: (key: string) => ({ name: `skill(${key})`, iconUrl: "/skill.png" }),
  status: (key: string) => ({ name: `effect(${key})`, iconUrl: "/effect.png" }),
};

const renderTable = (rows = ROWS, startIndex = 0) =>
  render(
    <MantineProvider>
      <EventRowsTable rows={rows} rowHeight={22} startIndex={startIndex} totalRows={rows.length} labels={LABELS} />
    </MantineProvider>
  );

describe("EventRowsTable", () => {
  it("renders every column header", () => {
    renderTable();
    expect(screen.getByText("ui.logs.events-time")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-source")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-ability")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-target")).toBeTruthy();
    expect(screen.getByText("ui.logs.events-amount")).toBeTruthy();
  });

  it("formats the timestamp to the millisecond", () => {
    renderTable();
    expect(screen.getByText("00:01.500")).toBeTruthy();
  });

  it("resolves indexes to display names rather than printing raw ids", () => {
    renderTable();
    expect(screen.getByText("player-0")).toBeTruthy();
    expect(screen.getByText("skill(Normal:100)")).toBeTruthy();
  });

  // The two capture paths key spawns differently, so the resolver has to be
  // told which space a row's number is in — see `ActorSpace`.
  it("passes the row's index space to the target resolver", () => {
    renderTable([ROWS[0]]);
    expect(screen.getByText("enemy-9-spawn")).toBeTruthy();
  });

  // An effect is not an ability: it resolves through the `status:` grammar the
  // buffs tables pin, so one effect reads the same in both.
  it("names an effect row through the status resolver", () => {
    renderTable([ROWS[2]]);
    expect(screen.getByText("effect(status:77:210:4242)")).toBeTruthy();
  });

  // Named by the effect alone, an apply and its matching remove were the same
  // effect on the same holder in the same colour — nothing to tell them apart.
  it("qualifies an effect row with whether it landed or ended", () => {
    const removal: EventRow = { ...ROWS[2], detailKey: "ui.logs.events-status-removed", amount: null };
    const { container } = renderTable([{ ...ROWS[2], detailKey: "ui.logs.events-status-applied" }]);
    expect(container.querySelector('[data-cell="ability"]')?.textContent).toContain("ui.logs.events-status-applied");

    const other = renderTable([removal]);
    expect(other.container.querySelector('[data-cell="ability"]')?.textContent).toContain(
      "ui.logs.events-status-removed"
    );
  });

  // Only an effect row carries both. A damage row's descriptor is null, and a
  // death row's descriptor IS its name — appending it would say it twice.
  it("does not repeat a descriptor that is already the name", () => {
    const { container } = renderTable([ROWS[1]]);
    expect(container.querySelector('[data-cell="ability"]')?.textContent).toBe("ui.logs.events-died");
  });

  it("shows a detail line where a row has neither an ability nor an effect", () => {
    renderTable([ROWS[1]]);
    expect(screen.getByText("ui.logs.events-died")).toBeTruthy();
  });

  it("shows the art the view resolved for each column", () => {
    const { container } = renderTable([ROWS[0]]);
    const sources = container.querySelectorAll<HTMLImageElement>('[data-cell="source"] img');
    expect(sources[0]?.getAttribute("src")).toBe("/pl0.png");
    expect(container.querySelector<HTMLImageElement>('[data-cell="ability"] img')?.src).toContain("/skill.png");
  });

  // `undefined` art is the common case — trash mobs have no portrait, and bare
  // kinds are not ability casts — so a cell without one renders its name alone.
  it("renders a cell with no art as its name alone", () => {
    const { container } = renderTable([ROWS[0]]);
    expect(container.querySelector('[data-cell="target"] img')).toBeNull();
  });

  // Only the ACTORS take a colour of their own. The player and the enemy get
  // different ones, which is the whole point — friendly from hostile at a
  // glance — and neither is the row's own kind colour.
  it("colours each actor in its own colour", () => {
    const { container } = renderTable([ROWS[0]]);
    const source = container.querySelector<HTMLElement>('[data-cell="source"] .mantine-Text-root');
    const target = container.querySelector<HTMLElement>('[data-cell="target"] .mantine-Text-root');
    expect(source?.style.color).toBe("rgb(54, 179, 126)");
    expect(target?.style.color).toBe("rgb(240, 101, 149)");
  });

  // The rest of the row is not an actor and has no colour to take: the ability
  // and the amount stay on the row's kind colour, which is what still says what
  // sort of event it is.
  it("leaves the non-actor cells uncoloured", () => {
    const { container } = renderTable([ROWS[0]]);
    const ability = container.querySelector<HTMLElement>('[data-cell="ability"] .mantine-Text-root');
    expect(ability?.style.color).toBe("");
  });

  // The two columns ask the same question. Resolved separately, an enemy in the
  // source column rendered as a bare number while the same enemy in the target
  // column had a name.
  it("resolves both ends of a row through the one actor resolver", () => {
    const enemyHit: EventRow = { ...ROWS[0], sourceIndex: 9, targetIndex: 0, targetSpace: "actor" };
    const { container } = renderTable([enemyHit]);
    expect(container.querySelector('[data-cell="source"]')?.textContent).toBe("enemy-9-actor");
    expect(container.querySelector('[data-cell="target"]')?.textContent).toBe("player-0");
  });

  it("leaves absent fields blank rather than zero", () => {
    // A death has no target and no amount; rendering "0" would read as data.
    const { container } = renderTable([ROWS[1]]);
    expect(container.querySelector('[data-cell="amount"]')?.textContent).toBe("");
    expect(container.querySelector('[data-cell="target"]')?.textContent).toBe("");
  });

  it("gives every kind its own colour", () => {
    for (const kind of EVENT_KINDS) expect(KIND_COLORS[kind]).toBeDefined();
    expect(new Set(Object.values(KIND_COLORS)).size).toBe(EVENT_KINDS.length);
  });

  it("positions rows by absolute index so scrolling stays aligned", () => {
    const { container } = renderTable(ROWS, 100);
    const first = container.querySelector<HTMLElement>("[data-event-row]");
    expect(first?.style.top).toBe("2200px");
  });

  it("sizes the spacer by the WHOLE filtered list, not the rendered slice", () => {
    // The scrollbar's length comes from this. Sized by the slice, scrolling would
    // stop a few rows in and the rest of the fight would be unreachable.
    const { container } = render(
      <MantineProvider>
        <EventRowsTable rows={ROWS} rowHeight={22} startIndex={100} totalRows={1000} labels={LABELS} />
      </MantineProvider>
    );
    expect(container.querySelector<HTMLElement>("[data-event-body]")?.style.height).toBe("22000px");
  });
});
