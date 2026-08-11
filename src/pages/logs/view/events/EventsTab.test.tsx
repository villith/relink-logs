import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LogEvent } from "@/types";

import { EventRowsTable, EventsTab, KIND_COLORS } from "./EventsTab";
import { EVENT_KINDS, type EventPins, type EventRow } from "./eventRows";
import type { NestedEventRow } from "./nestSupplementary";

/** The real `t` interpolates; a mock that returned the bare key could not tell
 * "+151ms" from an absolute stamp, which is the whole of what these rows say.
 * A call with no params still returns the key alone, so every older assertion
 * here reads as it did. */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined
        ? key
        : `${key}(${Object.entries(params)
            .map(([name, value]) => `${name}=${value}`)
            .join(",")})`,
    i18n: { language: "en" },
  }),
}));

/** What the stubbed fetch hands the tab. Reassigned per test; the factory below
 * only reads it at render time, long after this initialises. */
let page: { events: LogEvent[]; total: number; suppPairs: Record<number, number> } = {
  events: [],
  total: 0,
  suppPairs: {},
};
vi.mock("./useEvents", () => ({ useEvents: () => page }));

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

const renderTable = (rows: NestedEventRow[] = ROWS, startIndex = 0) =>
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

const TRIGGER: EventRow = {
  timeMs: 5_000,
  kind: "damage",
  sourceIndex: 0,
  targetIndex: 9,
  targetSpace: "spawn",
  abilityKey: "Normal:9001",
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: 154_500,
};

/** The echo, as `nestSupplementary` hands it over: still its own real `timeMs`,
 * plus the offset and the share it is drawn with. */
const ECHO: NestedEventRow = {
  ...TRIGGER,
  timeMs: 5_151,
  abilityKey: "SupplementaryDamage:9001",
  amount: 92_700,
  parent: { deltaMs: 151, sharePercent: 60 },
};

const cellsOf = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll(`[data-cell="${name}"]`)].map((cell) => cell.textContent ?? "");

describe("EventRowsTable, supplementary nesting", () => {
  it("draws the echo directly beneath the hit that caused it", () => {
    const { container } = renderTable([TRIGGER, ECHO]);
    expect(cellsOf(container, "ability")).toEqual(["skill(Normal:9001)", "└─skill(SupplementaryDamage:9001)"]);
  });

  // An echo lands 151ms after its trigger, which in a real fight is several rows
  // later — printed absolutely, the moved row would make the time column read
  // backwards, and an unsorted column is not scannable at all.
  it("shows the child's offset rather than an absolute stamp", () => {
    const { container } = renderTable([TRIGGER, ECHO]);
    const [trigger, echo] = cellsOf(container, "time");
    expect(trigger).toBe("00:05.000");
    expect(echo).toBe("ui.logs.events-echo-delta(ms=151)");
    expect(echo).not.toContain("00:05.151");
  });

  // Nothing is actually hidden: the stamp the column gave up is on the hover,
  // along with the share the whole pairing rests on.
  it("keeps the real timestamp and the share on the hover", () => {
    const { container } = renderTable([ECHO]);
    const title = container.querySelector('[data-cell="time"] span')?.getAttribute("title") ?? "";
    expect(title).toContain("ui.logs.events-echo-delta-title");
    expect(title).toContain("time=00:05.151");
    expect(title).toContain("percent=60.0");
  });

  it("prints the echo's share of its trigger beside the amount", () => {
    const { container } = renderTable([ECHO]);
    expect(cellsOf(container, "amount")[0]).toBe("92,700ui.logs.events-echo-share(percent=60.0)");
  });

  // A trigger with no amount gives no share to read; "0.0%" would read as a
  // measurement rather than the absence of one.
  it("prints no percentage where there is no share to measure", () => {
    const { container } = renderTable([{ ...ECHO, parent: { deltaMs: 151, sharePercent: 0 } }]);
    expect(cellsOf(container, "amount")[0]).toBe("92,700");
  });

  // A trigger pulled back past a filter is context, not a match.
  it("dims a re-admitted trigger and says why", () => {
    const { container } = renderTable([{ ...TRIGGER, context: true }, ECHO]);
    const [context, echo] = container.querySelectorAll<HTMLElement>("[data-event-row]");
    expect(context.style.opacity).toBe("0.45");
    expect(context.getAttribute("title")).toBe("ui.logs.events-echo-context-title");
    expect(echo.style.opacity).toBe("");
    expect(echo.getAttribute("title")).toBeNull();
  });

  // Every log without a paired echo — most of them — must render exactly as it
  // did before nesting existed.
  it("leaves an unpaired row untouched", () => {
    const { container } = renderTable([TRIGGER]);
    expect(cellsOf(container, "time")).toEqual(["00:05.000"]);
    expect(cellsOf(container, "ability")).toEqual(["skill(Normal:9001)"]);
    expect(cellsOf(container, "amount")).toEqual(["154,500"]);
    expect(container.querySelector<HTMLElement>("[data-event-row]")?.style.opacity).toBe("");
    expect(container.querySelector('[data-cell="time"] span')).toBeNull();
  });
});

const hit = (timeMs: number, actionId: number, damage: number, supplementary = false): LogEvent => [
  timeMs,
  {
    DamageEvent: {
      source: { index: 0, actor_type: 0, parent_index: 0, parent_actor_type: 0 },
      target: { index: 9, actor_type: 0, parent_index: 9, parent_actor_type: 0 },
      damage,
      flags: 0,
      action_id: supplementary ? { SupplementaryDamage: actionId } : { Normal: actionId },
    },
  },
];

const NO_PINS: EventPins = { source: null, targetSpans: [], abilityKeys: null };
/** Pinned to the echo's own ability, which its trigger cannot answer — so the
 * trigger only ever appears if its echo pulled it back in. */
const ECHO_PIN: EventPins = { ...NO_PINS, abilityKeys: new Set(["SupplementaryDamage:9001"]) };

const STREAM = {
  id: "1",
  metric: "damage" as const,
  hostility: "friendly" as const,
  probes: { isPartyMember: (index: number) => index < 2, isHarmful: () => false },
  pins: NO_PINS,
};

const renderTab = (pins: EventPins = NO_PINS) =>
  render(
    <MantineProvider>
      <EventsTab stream={{ ...STREAM, pins }} labels={LABELS} />
    </MantineProvider>
  );

describe("EventsTab", () => {
  const events = [hit(5_000, 9_001, 154_500), hit(5_151, 9_001, 92_700, true)];

  it("nests AFTER the filters, so a surviving echo pulls its trigger back in", () => {
    page = { events, total: events.length, suppPairs: { 1: 0 } };
    // A pin the trigger cannot answer: on its own merits it is filtered out.
    const { container } = renderTab(ECHO_PIN);
    expect(cellsOf(container, "ability")).toEqual(["skill(Normal:9001)", "└─skill(SupplementaryDamage:9001)"]);
    expect(container.querySelectorAll<HTMLElement>("[data-event-row]")[0].style.opacity).toBe("0.45");
  });

  // The spacer sizes the scrollbar. Sized by the FILTERED list while the NESTED
  // one is what renders, the re-admitted trigger would have no scroll of its own
  // and the last row of a long page would be unreachable.
  it("sizes the spacer by the nested list, context rows included", () => {
    page = { events, total: events.length, suppPairs: { 1: 0 } };
    const { container } = renderTab(ECHO_PIN);
    expect(container.querySelector<HTMLElement>("[data-event-body]")?.style.height).toBe("52px");
  });

  it("counts the matches rather than the context drawn around them", () => {
    page = { events, total: events.length, suppPairs: { 1: 0 } };
    renderTab(ECHO_PIN);
    expect(screen.getByText("ui.logs.events-count(shown=1,total=2)")).toBeTruthy();
  });

  it("renders a page with no pairs flat", () => {
    page = { events, total: events.length, suppPairs: {} };
    const { container } = renderTab();
    expect(cellsOf(container, "time")).toEqual(["00:05.000", "00:05.151"]);
    expect(container.querySelector('[data-cell="time"] span')).toBeNull();
  });
});
