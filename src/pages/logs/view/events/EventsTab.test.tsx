import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
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
    capHit: { damage: 18204, damage_cap: 1_000_000, base_damage: 4_000_000, attack_rate: 2.5, class_flags: 0x1 },
    capConditions: null,
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
    capConditions: null,
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
    capConditions: null,
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
    const source = container.querySelector<HTMLElement>('[data-cell="source"] [data-name]');
    const target = container.querySelector<HTMLElement>('[data-cell="target"] [data-name]');
    expect(source?.style.color).toBe("rgb(54, 179, 126)");
    expect(target?.style.color).toBe("rgb(240, 101, 149)");
  });

  // The rest of the row is not an actor and has no colour to take: the ability
  // and the amount stay on the row's kind colour, which is what still says what
  // sort of event it is.
  it("leaves the non-actor cells uncoloured", () => {
    const { container } = renderTable([ROWS[0]]);
    const ability = container.querySelector<HTMLElement>('[data-cell="ability"] [data-name]');
    expect(ability?.style.color).toBe("");
  });

  // The stream is a body of the analysis view, so it draws its rows through the
  // same shell the metric table and the timeline lanes do — one height, one
  // hover, one focus ring. It used to hand-roll all three a size smaller.
  it("draws its rows through the shared analysis row shell", () => {
    const { container } = renderTable([ROWS[0]]);
    const row = container.querySelector<HTMLElement>("[data-event-row]");
    expect(row?.getAttribute("role")).toBe("row");
    expect(row?.className).toContain("h-row");
  });

  it("highlights the whole row under the pointer", () => {
    const { container } = renderTable([ROWS[0]]);
    const row = container.querySelector<HTMLElement>("[data-event-row]");
    // The ring comes from the shared shell; the fill is the stream's own —
    // these rows carry no magnitude bar behind them, so the ring alone reads
    // thinner here than it does on a table row.
    expect(row?.className).toContain("hover:outline");
    expect(row?.className).toContain("hover:bg-raised");
  });

  it("draws its art at the table's own icon size", () => {
    const { container } = renderTable([ROWS[0]]);
    expect(container.querySelector('[data-cell="source"] img')?.className).toMatch(/\bsize-icon\b/);
  });

  // The heads name the columns you filter FROM, so they are doing real work now
  // — the caption voice's default 10px was too quiet to read at a glance.
  it("gives the column heads a size the eye can actually read", () => {
    const { container } = renderTable([ROWS[0]]);
    const head = container.querySelector("[data-head-label]");
    expect(head?.className).toContain("text-sm");
    expect(head?.className).not.toContain("text-label");
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
    expect(echo).toBe("└─ui.logs.events-echo-delta(ms=151)");
    expect(echo).not.toContain("00:05.151");
  });

  // One elbow per cell that carries the child's own data. Drawn on the ability
  // alone, the nesting was legible in the middle of the row and invisible at
  // either end — which is where the two numbers the pairing rests on live.
  it("marks every cell the child owns with the same elbow", () => {
    const { container } = renderTable([TRIGGER, ECHO]);
    for (const column of ["time", "ability", "amount"]) {
      expect(cellsOf(container, column)[1].startsWith("└─")).toBe(true);
    }
  });

  // The two columns that name an ACTOR are not the child's own: an echo has the
  // same source and the same target as the hit that caused it, so an elbow
  // there would claim a subordination that is not there.
  it("leaves the actor columns unmarked", () => {
    const { container } = renderTable([TRIGGER, ECHO]);
    expect(cellsOf(container, "source")[1]).toBe("player-0");
    expect(cellsOf(container, "target")[1]).toBe("enemy-9-spawn");
  });

  // Nothing is actually hidden: the stamp the column gave up is on the hover,
  // along with the share the whole pairing rests on.
  it("keeps the real timestamp and the share on the hover", () => {
    const { container } = renderTable([ECHO]);
    const title = container.querySelector('[data-cell="time"] [title]')?.getAttribute("title") ?? "";
    expect(title).toContain("ui.logs.events-echo-delta-title");
    expect(title).toContain("time=00:05.151");
    expect(title).toContain("percent=60.0");
  });

  it("prints the echo's share of its trigger beside the amount", () => {
    const { container } = renderTable([ECHO]);
    expect(cellsOf(container, "amount")[0]).toBe("└─92,700ui.logs.events-echo-share(percent=60.0)");
  });

  // A trigger with no amount gives no share to read; "0.0%" would read as a
  // measurement rather than the absence of one.
  it("prints no percentage where there is no share to measure", () => {
    const { container } = renderTable([{ ...ECHO, parent: { deltaMs: 151, sharePercent: 0 } }]);
    expect(cellsOf(container, "amount")[0]).toBe("└─92,700");
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

/** The same hit, from a nominated player — for the cases that need more than
 * one source in the stream. */
const hitBy = (timeMs: number, sourceIndex: number, actionId: number, damage: number): LogEvent => [
  timeMs,
  {
    DamageEvent: {
      source: { index: sourceIndex, actor_type: 0, parent_index: sourceIndex, parent_actor_type: 0 },
      target: { index: 9, actor_type: 0, parent_index: 9, parent_actor_type: 0 },
      damage,
      flags: 0,
      action_id: { Normal: actionId },
    },
  },
];

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
    // Two rows at the analysis view's own row height — the stream draws through
    // the same `AnalysisRow` the metric table does, so the virtualiser's number
    // has to be that shell's height and not one of its own.
    const { container } = renderTab(ECHO_PIN);
    expect(container.querySelector<HTMLElement>("[data-event-body]")?.style.height).toBe("60px");
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

/** A long enough stream to scroll: sixty hits a second apart, alternating
 * between two abilities, so a jump has somewhere to go. */
const LONG = Array.from({ length: 60 }, (_, index) => hit(index * 1_000, index % 2 === 0 ? 100 : 200, 1_000 + index));

const tops = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-event-row]")].map((row) => row.style.top);

const jumpInput = () => screen.getByLabelText("ui.logs.events-jump-label");

const commit = (text: string) => {
  fireEvent.change(jumpInput(), { target: { value: text } });
  fireEvent.keyDown(jumpInput(), { key: "Enter" });
};

describe("EventsTab, jump to a time", () => {
  it("scrolls the list to the first row at or past a typed time", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    // Row 40 is far below the first screenful, so it is not even rendered yet.
    expect(tops(container)).not.toContain("1200px");

    commit("0:40");
    expect(tops(container)).toContain("1200px");
  });

  it("marks the row it landed on, so the eye finds it without hunting", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    commit("0:40");
    expect(container.querySelector<HTMLElement>("[data-jump-current]")?.style.top).toBe("1200px");
  });

  it("moves the mark when a second time is typed", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    commit("0:40");
    commit("0:20");
    const marked = [...container.querySelectorAll<HTMLElement>("[data-jump-current]")].map((row) => row.style.top);
    expect(marked).toEqual(["600px"]);
  });

  // A jump that lands where the eye already was looks like nothing happened at
  // all. The mark replays per landing, which is what makes the arrival visible.
  it("replays its arrival mark on every landing", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    commit("0:40");
    const first = container.querySelector("[data-arrival]")?.getAttribute("data-arrival");

    commit("0:41");
    expect(container.querySelector("[data-arrival]")?.getAttribute("data-arrival")).not.toBe(first);
  });

  // A time names a MOMENT, not an ability — tinting the name of whatever
  // happened to be there would say the ability was what was searched for.
  it("leaves the ability name alone on the row it landed on", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    commit("0:40");
    const current = container.querySelector<HTMLElement>("[data-jump-current]");
    expect(current?.querySelector('[data-cell="ability"] [data-name]')?.className).not.toContain("text-accent");
  });

  // An ability name is a NAME, not a control. Making it clickable put a second,
  // undiscoverable way to jump on every row of the table.
  it("leaves ability names as plain text", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    expect(container.querySelector('[data-cell="ability"] button')).toBeNull();
  });

  it("says nothing landed when the text names no time", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    commit("no such thing");
    expect(container.querySelector("[data-jump-none]")?.textContent).toBe("ui.logs.events-jump-none");
    expect(container.querySelector("[data-jump-current]")).toBeNull();
  });

  // Past the end of the fight there is nothing to scroll to — the view stays
  // where it was rather than being pinned to the last row.
  it("says nothing landed for a time past the last event", () => {
    page = { events: LONG, total: LONG.length, suppPairs: {} };
    const { container } = renderTab();
    commit("9:00");
    expect(container.querySelector("[data-jump-none]")?.textContent).toBe("ui.logs.events-jump-none");
    expect(container.querySelector("[data-jump-current]")).toBeNull();
  });
});

/** Three hits across two abilities, so the ability column has more than one
 * value to narrow to and one of them keeps more than a single row. */
const MIXED = [hit(1_000, 100, 500), hit(2_000, 200, 600), hit(3_000, 100, 700)];

const openFilter = (container: HTMLElement, column: string) => {
  fireEvent.click(container.querySelector<HTMLElement>(`[data-column-filter="${column}"]`) as HTMLElement);
};

/** Mantine puts unrecognised props on the checkbox INPUT rather than its
 * wrapper, so the marked node may be either — take whichever is really there. */
const tick = (container: HTMLElement, label: string) => {
  const marked = container.querySelector<HTMLElement>(`[data-filter-option="${label}"]`);
  const input = marked instanceof HTMLInputElement ? marked : marked?.querySelector("input");
  fireEvent.click(input as HTMLInputElement);
};

describe("EventsTab, column filters", () => {
  it("offers a filter on the source, ability and target columns", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    expect(container.querySelectorAll("[data-column-filter]").length).toBe(3);
    for (const column of ["source", "ability", "target"]) {
      expect(container.querySelector(`[data-column-filter="${column}"]`)).not.toBeNull();
    }
  });

  // Time is a moment and amount is a measurement — neither is a value you tick
  // off a list, so neither grows a funnel.
  it("offers no filter on the time or amount columns", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    expect(container.querySelector('[data-column-filter="time"]')).toBeNull();
    expect(container.querySelector('[data-column-filter="amount"]')).toBeNull();
  });

  // Building a column's values walks the whole stream, so the menu only does it
  // once opened — a closed funnel must cost nothing.
  it("builds a column's values only once its menu is opened", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    expect(container.querySelector("[data-filter-option]")).toBeNull();

    openFilter(container, "ability");
    expect(container.querySelectorAll("[data-filter-option]").length).toBe(2);
  });

  it("narrows the rows to a ticked value", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    expect(container.querySelectorAll("[data-event-row]").length).toBe(3);

    openFilter(container, "ability");
    tick(container, "skill(Normal:100)");
    expect(cellsOf(container, "ability")).toEqual(["skill(Normal:100)", "skill(Normal:100)"]);
  });

  it("counts the filtered rows rather than the whole stream", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    openFilter(container, "ability");
    tick(container, "skill(Normal:100)");
    expect(screen.getByText("ui.logs.events-count(shown=2,total=3)")).toBeTruthy();
  });

  it("lights the funnel of a column that is narrowing something", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    openFilter(container, "ability");
    tick(container, "skill(Normal:100)");
    expect(container.querySelector('[data-column-filter="ability"]')?.className).toContain("text-accent");
    expect(container.querySelector('[data-column-filter="source"]')?.className).not.toContain("text-accent");
  });

  // Ticking one value must not delete the other boxes from the menu that was
  // just used to tick it — the list comes from the rows the OTHER filters left.
  it("keeps a column's other values offered after one of them is ticked", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    openFilter(container, "ability");
    tick(container, "skill(Normal:100)");
    expect(container.querySelectorAll("[data-filter-option]").length).toBe(2);
  });

  it("gives every filtered row back when the filter is cleared", () => {
    page = { events: MIXED, total: MIXED.length, suppPairs: {} };
    const { container } = renderTab();
    openFilter(container, "ability");
    tick(container, "skill(Normal:100)");

    fireEvent.click(container.querySelector<HTMLElement>("[data-filter-clear]") as HTMLElement);
    expect(container.querySelectorAll("[data-event-row]").length).toBe(3);
  });
});

/** One ability used by both players and one used by only the second, so
 * narrowing the source really does change what the ability column would keep. */
const TWO_SOURCES: LogEvent[] = [hitBy(1_000, 0, 100, 500), hitBy(2_000, 1, 100, 600), hitBy(3_000, 1, 200, 700)];

const countOf = (container: HTMLElement, label: string) =>
  container.querySelector(`[data-filter-count="${label}"]`)?.textContent;

describe("EventsTab, column filter counts", () => {
  it("counts every row of the stream when nothing else is narrowed", () => {
    page = { events: TWO_SOURCES, total: TWO_SOURCES.length, suppPairs: {} };
    const { container } = renderTab();
    openFilter(container, "ability");
    expect(countOf(container, "skill(Normal:100)")).toBe("ui.logs.events-filter-option-count(count=2)");
    expect(countOf(container, "skill(Normal:200)")).toBe("ui.logs.events-filter-option-count(count=1)");
  });

  // The number beside a value has to answer "how many would I get", and once
  // another column is narrowing, the stream's own total is not that answer.
  it("recounts a column against what the other columns left", () => {
    page = { events: TWO_SOURCES, total: TWO_SOURCES.length, suppPairs: {} };
    const { container } = renderTab();
    openFilter(container, "source");
    tick(container, "player-1");
    fireEvent.click(container.querySelector<HTMLElement>('[data-column-filter="source"]') as HTMLElement);

    openFilter(container, "ability");
    // Player 1 used Normal:100 once, not twice.
    expect(countOf(container, "skill(Normal:100)")).toBe("ui.logs.events-filter-option-count(count=1)");
    expect(countOf(container, "skill(Normal:200)")).toBe("ui.logs.events-filter-option-count(count=1)");
  });

  // A column must NOT count against its own ticks, or ticking one value would
  // zero every other box in the very menu you were about to tick them in.
  it("leaves a column's own counts alone when that column is the one ticked", () => {
    page = { events: TWO_SOURCES, total: TWO_SOURCES.length, suppPairs: {} };
    const { container } = renderTab();
    openFilter(container, "ability");
    tick(container, "skill(Normal:100)");
    expect(countOf(container, "skill(Normal:100)")).toBe("ui.logs.events-filter-option-count(count=2)");
    expect(countOf(container, "skill(Normal:200)")).toBe("ui.logs.events-filter-option-count(count=1)");
  });
});
