import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import type { LogSummary } from "@/types";

import { LogPicker } from "./LogPicker";

// `t` is called both ways here — with a fallback string and with interpolation
// values — so the mock has to tell the two apart. Returning the options object
// would hand React an object to render, which throws rather than failing an
// assertion.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, second?: unknown) => (typeof second === "string" ? second : key),
  }),
}));

// The name resolvers read i18next directly rather than through the hook above,
// and an uninitialised i18next answers `undefined` — which is a name the picker
// then has to sort by. The times and the date formatter stay real: they are
// what the row's second line is made of.
vi.mock("@/utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  translateQuestId: (id: number | null) => `quests:${id}`,
  translateCharacterType: (type: string) => `characters:${type}`,
}));

const log = (over: Partial<LogSummary> & { id: number }): LogSummary => ({
  time: 1_700_000_000,
  duration: 120_000,
  questId: 2657,
  questElapsedTime: 180,
  p1Name: "Rain",
  p1Type: "Pl1400",
  p2Name: null,
  p2Type: null,
  p3Name: null,
  p3Type: null,
  p4Name: null,
  p4Type: null,
  repeatGroup: null,
  ...over,
});

const renderPicker = (props: Partial<React.ComponentProps<typeof LogPicker>> = {}) =>
  render(
    <MantineProvider>
      <LogPicker logs={[log({ id: 1 })]} value={1} onChange={vi.fn()} {...props} />
    </MantineProvider>
  );

/** The picker turns Mantine's `keepMounted` OFF, so a closed dropdown is not in
 * the DOM at all and the control is the only button on screen. */
const target = () => screen.getByLabelText("ui.logs.picker-label");
const open = () => fireEvent.click(target());

/** The `#id` an option carries, read off its own element rather than out of the
 * row's text: the id sits right against the duration below it, so `#2` and
 * `02:00` read as `#202` once `textContent` has joined them. */
const idCell = (option: HTMLElement) => within(option).queryByText(/^#\d+$/);

/** The log options, told from the filter bar's own options by that `#id`. */
const logOptions = () => screen.queryAllByRole("option").filter((option) => idCell(option) !== null);
const logIds = () => logOptions().map((option) => (idCell(option)?.textContent ?? "").slice(1));

/** A filter's own input. By its LABEL rather than its placeholder: a party
 * filter drops the placeholder as soon as it holds a pill, and picking more
 * than one is the point of it. */
const filterInput = (label: string) => screen.getByLabelText(label);

/** Open a filter dropdown and pick one of its entries by label. */
const pickFilterEntry = (label: string, entryLabel: string) => {
  fireEvent.click(filterInput(label));
  const entry = screen.getAllByRole("option").find((option) => option.textContent === entryLabel);
  fireEvent.click(entry as HTMLElement);
};

/** Pick an entry and hand the bar its blur, which is what applies it: the
 * controls hold a draft until focus leaves them (see `draft`). */
const pickFilter = (label: string, entryLabel: string) => {
  pickFilterEntry(label, entryLabel);
  fireEvent.focusOut(filterInput(label));
};

/** The picked entries of a party filter, as their own elements — a filled slot
 * in the character filter, a pill in the player one. */
const partyEntries = () => Array.from(document.querySelectorAll("[data-party-entry]")) as HTMLElement[];

/** jsdom implements no layout, so the method the browser scrolls the selected
 * option into view with is simply absent from the prototype. */
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMeterSettingsStore.setState({ streamer_mode: false });
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});

describe("LogPicker", () => {
  it("names the selected log on the closed control", () => {
    renderPicker();
    expect(within(target()).getByText(/#1/)).toBeTruthy();
  });

  // The second line: the run's two clocks and when it happened. Truncated onto
  // one line, this is what a reader could not see.
  it("carries the run's times and date on the control", () => {
    renderPicker({ logs: [log({ id: 1, duration: 120_000, questElapsedTime: 180 })], value: 1 });
    const text = target().textContent ?? "";
    expect(text).toContain("02:00");
    expect(text).toContain("03:00");
  });

  // Named by the same keys the quest list heads its columns with — two bare
  // clocks side by side say which is which only to someone who already knows.
  it("labels both clocks, each as a label rather than a word in a sentence", () => {
    renderPicker();
    const text = target().textContent ?? "";
    expect(text).toContain("ui.logs.duration:");
    expect(text).toContain("ui.logs.quest-elapsed-time:");
  });

  // The 1s placeholder the quest timer stored before it was read correctly.
  it("says nothing of an in-game time that was never recorded", () => {
    renderPicker({ logs: [log({ id: 1, questElapsedTime: 1 })], value: 1 });
    expect(target().textContent).not.toContain("00:01");
  });

  // A dash rather than an empty cell: the column holds its place down the
  // list, and a label standing alone reads as a value that failed to render.
  it("dashes the in-game time it does not have", () => {
    renderPicker({ logs: [log({ id: 1, questElapsedTime: null })], value: 1 });
    expect(target().textContent).toContain("—");
  });

  it("keeps its options out of reach until it is opened", () => {
    renderPicker();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  // The regression that made the whole view slow: Mantine's Combobox keeps its
  // dropdown mounted by default, so every log in the library sat in the DOM
  // behind a closed control — 17,708 nodes and 7,528 `<img>`s at 1,881 logs,
  // reconciled on every render of the view around it, per pane.
  it("puts nothing in the DOM for the logs it is not showing", () => {
    const { container } = renderPicker({ logs: Array.from({ length: 200 }, (_, i) => log({ id: i + 1 })), value: 1 });

    // The control and its own party art, and nothing else.
    expect(container.querySelectorAll("img").length).toBeLessThan(5);
  });

  // The cap is a rendering budget, and one that said nothing would read as a
  // library that ends at 100 runs.
  it("says how many runs it left behind the cap", () => {
    renderPicker({ logs: Array.from({ length: 130 }, (_, i) => log({ id: i + 1 })), value: 1 });
    open();

    expect(logOptions()).toHaveLength(100);
    expect(screen.getByText("ui.logs.picker-more")).toBeTruthy();
  });

  it("says nothing about a remainder when the whole library fits", () => {
    renderPicker();
    open();

    expect(screen.queryByText("ui.logs.picker-more")).toBeNull();
  });

  it("offers each run of a chain as its own option", () => {
    renderPicker({ logs: [log({ id: 10 }), log({ id: 11, repeatGroup: 10 })], value: 10 });
    open();
    expect(logIds()).toEqual(["10", "11"]);
  });

  // What the chain came to, not how many runs it holds: the run count is the
  // rows underneath, which the reader can already see.
  it("heads a chain with its best times and the span it was run over", () => {
    renderPicker({
      logs: [
        log({ id: 10, time: 1_700_000_000, duration: 400_000, questElapsedTime: 300 }),
        log({ id: 11, repeatGroup: 10, time: 1_700_003_000, duration: 300_000, questElapsedTime: 200 }),
      ],
      value: 10,
    });
    open();

    const header = screen.getByTestId("picker-chain-header");
    // The bests, one per clock — 300s and 200s, not the leading run's figures.
    expect(header.textContent).toContain("05:00");
    expect(header.textContent).toContain("03:20");
    // Both ends of the span, in the order they happened (see `formatRunSpan`).
    expect(header.textContent).toContain(" - ");
  });

  // The record shows on the run that set it, not only on the header — the
  // whole reason a chain is drawn open is to see WHICH run was the fast one.
  it("marks the run that set each of the chain's bests", () => {
    renderPicker({
      logs: [
        log({ id: 10, duration: 400_000, questElapsedTime: 200 }),
        log({ id: 11, repeatGroup: 10, duration: 300_000, questElapsedTime: 300 }),
      ],
      value: 10,
    });
    open();

    const bestsOf = (id: string) =>
      Array.from(
        (logOptions().find((option) => idCell(option)?.textContent === `#${id}`) as HTMLElement).querySelectorAll(
          "[data-best]"
        )
      ).map((cell) => cell.getAttribute("data-best"));

    expect(bestsOf("11")).toEqual(["duration"]);
    expect(bestsOf("10")).toEqual(["quest-elapsed-time"]);
  });

  // A lone run is nobody's record: there is nothing for it to be the best of.
  it("marks nothing on a run standing on its own", () => {
    const { container } = renderPicker({ logs: [log({ id: 10 })], value: 10 });
    open();
    expect(container.ownerDocument.querySelectorAll("[data-best]")).toHaveLength(0);
  });

  it("says nothing about how many runs a chain holds", () => {
    renderPicker({ logs: [log({ id: 10 }), log({ id: 11, repeatGroup: 10 })], value: 10 });
    open();
    // The header IS drawn and states the chain's best — a run count is the one
    // thing it must not add, so assert on what it renders rather than on a key
    // no component names.
    expect(screen.getAllByTestId("picker-chain-header").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\b2 runs?\b/)).toBeNull();
  });

  it("reports the chosen log's id", () => {
    const onChange = vi.fn();
    renderPicker({ logs: [log({ id: 10 }), log({ id: 11, repeatGroup: 10 })], value: 10, onChange });
    open();
    const option = logOptions().find((node) => node.textContent?.includes("#11"));
    fireEvent.click(option as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(11);
  });

  // A pane whose log is not in the library yet — the library load has not landed,
  // or the log was deleted from under a bookmarked URL — must still draw a
  // control that opens, rather than an empty box or a crash.
  it("stands in for a log the library does not carry", () => {
    renderPicker({ logs: [], value: 999 });
    expect(within(target()).getByText("#999")).toBeTruthy();
  });

  describe("the selected log", () => {
    it("marks the option the pane is already on", () => {
      renderPicker({ logs: [log({ id: 10 }), log({ id: 11 })], value: 11 });
      open();
      const marked = logOptions().filter((option) => option.getAttribute("data-selected-log") === "true");
      expect(marked.map((option) => (idCell(option)?.textContent ?? "").slice(1))).toEqual(["11"]);
    });

    // The list the open effect scrolls, and the option it looks for inside it:
    // the two halves of a query that fails silently if either name moves.
    it("keeps it inside the list the picker scrolls", () => {
      renderPicker({ logs: [log({ id: 10 }), log({ id: 11 })], value: 11 });
      open();

      const list = document.querySelector("[data-picker-options]");
      expect(list?.querySelector('[data-selected-log="true"]')).toBeTruthy();
    });

    // `scrollIntoView` scrolls EVERY scrollable ancestor, so opening the picker
    // scrolled the page behind it — from the top of the view, by a screenful.
    it("does not scroll the page to reach it", () => {
      renderPicker({ logs: [log({ id: 10 }), log({ id: 11 })], value: 11 });
      open();

      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  // The control is the pane's TITLE, so it is where the colour a log wears on
  // the compare overlay belongs: the column, its line and the rule marking where
  // its run ended then read as one thing.
  describe("the log's colour", () => {
    it("wears it as a gutter, and tints the id with it", () => {
      renderPicker({ logs: [log({ id: 10 })], value: 10, color: "#FF5630" });

      const control = target();
      expect(control.style.borderLeftColor).toBe("#FF5630");
      expect(within(control).getByText("#10").style.color).toBe("rgb(255, 86, 48)");
    });

    // A lone column has nothing to be told apart from, and a 3px rule declared
    // unconditionally would indent it against nothing.
    it("draws neither with one log open", () => {
      renderPicker({ logs: [log({ id: 10 })], value: 10 });

      const control = target();
      expect(control.style.borderLeftColor).toBe("");
      expect(within(control).getByText("#10").style.color).toBe("");
    });
  });

  describe("filtering", () => {
    const library = [
      log({ id: 1, questId: 2657, p1Type: "Pl1400", p1Name: "Rain" }),
      log({ id: 2, questId: 2619, p1Type: "Pl0700", p1Name: "Kahs" }),
    ];

    it("narrows to one quest", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilter("ui.logs.picker-quest-filter", "quests:2619");

      expect(logIds()).toEqual(["2"]);
    });

    it("stays open while a filter is being operated", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilter("ui.logs.picker-quest-filter", "quests:2619");

      expect(screen.queryByPlaceholderText("ui.logs.picker-quest-filter")).toBeTruthy();
    });

    it("narrows to a character", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilter("ui.logs.picker-character-filter", "characters:Pl0700");

      expect(logIds()).toEqual(["2"]);
    });

    it("narrows to a player", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilter("ui.logs.picker-player-filter", "Kahs");

      expect(logIds()).toEqual(["2"]);
    });

    it("says so when the filters match nothing", () => {
      renderPicker({ logs: [log({ id: 1, questId: 2657 })], value: 1 });
      open();
      // A quest nothing was recorded against cannot be picked, so narrow by a
      // character instead: the library's own quest is its only quest.
      pickFilter("ui.logs.picker-character-filter", "characters:Pl1400");
      pickFilter("ui.logs.picker-player-filter", "Rain");

      expect(logIds()).toEqual(["1"]);
    });

    // Names are what streamer mode exists to withhold, so the filter that
    // lists every player who ever grouped with you goes with them.
    it("offers no player filter in streamer mode", () => {
      useMeterSettingsStore.setState({ streamer_mode: true });
      renderPicker({ logs: library, value: 1 });
      open();

      expect(screen.queryByPlaceholderText("ui.logs.picker-player-filter")).toBeNull();
      expect(screen.queryByPlaceholderText("ui.logs.picker-character-filter")).toBeTruthy();
    });

    // The pick lands in the CONTROL; the list is narrowed when focus leaves the
    // bar. Applied on every tick, the list resized under the cursor still
    // picking — and this dropdown opens upward in the lower pane, so a list
    // that shortens takes the filter bar up with it.
    it("narrows only once focus has left the filter", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilterEntry("ui.logs.picker-quest-filter", "quests:2619");

      expect(logIds()).toEqual(["1", "2"]);

      fireEvent.focusOut(filterInput("ui.logs.picker-quest-filter"));
      expect(logIds()).toEqual(["2"]);
    });

    // Four slots in a party, so a fifth entry could only ever match nothing.
    it("takes no more than a party's worth", () => {
      const roster = ["Pl1400", "Pl0700", "Pl1000", "Pl1100", "Pl1200"];
      renderPicker({ logs: roster.map((type, index) => log({ id: index + 1, p1Type: type })), value: 1 });
      open();
      for (const type of roster.slice(0, 4)) pickFilterEntry("ui.logs.picker-character-filter", `characters:${type}`);

      expect(partyEntries()).toHaveLength(4);

      // The fifth is out of REACH rather than a click that quietly does
      // nothing: a full filter has nothing to offer, so it does not open.
      fireEvent.click(filterInput("ui.logs.picker-character-filter"));
      expect(screen.queryAllByRole("option").some((option) => option.textContent === "characters:Pl1200")).toBe(false);
    });

    // A party is recognised by its characters far faster than it is read, and
    // the slots are the only place the picked party is shown.
    it("shows a picked character as art, and a picked player as a name", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilter("ui.logs.picker-character-filter", "characters:Pl0700");
      pickFilter("ui.logs.picker-player-filter", "Kahs");

      const [character, player] = partyEntries();
      expect(character.querySelector("img")).toBeTruthy();
      // Named for the pointer, since the art no longer says it in words.
      expect(character.getAttribute("title")).toBe("characters:Pl0700");
      expect(character.textContent).not.toContain("characters:Pl0700");
      expect(player.textContent).toContain("Kahs");
    });

    // The field it used to carry is hidden (the four busts are the control, and
    // typing happens in the dropdown), so with nothing picked the control has
    // to say what it is in its own right.
    it("names what it filters while it holds nothing", () => {
      renderPicker({ logs: library, value: 1 });
      open();

      expect(screen.getByText("ui.logs.picker-character-filter")).toBeTruthy();

      pickFilter("ui.logs.picker-character-filter", "characters:Pl0700");
      expect(screen.queryByText("ui.logs.picker-character-filter")).toBeNull();
      expect(partyEntries()).toHaveLength(1);
    });

    // Clicking a bust takes it back out — the slots are the removal affordance,
    // so a filled filter needs no ✕ per character.
    it("gives a picked character back when its slot is clicked", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilter("ui.logs.picker-character-filter", "characters:Pl0700");

      fireEvent.click(partyEntries()[0]);
      expect(partyEntries()).toHaveLength(0);
    });

    it("keeps the narrowing when the dropdown is closed and opened again", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      pickFilter("ui.logs.picker-quest-filter", "quests:2619");
      fireEvent.click(target());
      open();

      expect(logIds()).toEqual(["2"]);
    });
  });

  describe("sorting", () => {
    const library = [
      log({ id: 1, time: 300, questElapsedTime: 300, duration: 100 }),
      log({ id: 2, time: 200, questElapsedTime: 100, duration: 300 }),
      log({ id: 3, time: 100, questElapsedTime: 200, duration: 200 }),
    ];

    it("opens newest first", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      expect(logIds()).toEqual(["1", "2", "3"]);
    });

    it("sorts by in-game time, fastest first", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      fireEvent.click(screen.getByText("ui.logs.quest-elapsed-time"));

      expect(logIds()).toEqual(["2", "3", "1"]);
    });

    // The quest list's own rule: picking the column you are already sorted by
    // turns it around.
    it("turns a sort around when its key is picked again", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      fireEvent.click(screen.getByText("ui.logs.quest-elapsed-time"));
      fireEvent.click(screen.getByText("ui.logs.quest-elapsed-time"));

      expect(logIds()).toEqual(["1", "3", "2"]);
    });

    // The caret is part of what sizes a chip, so all three carry one and the
    // two that are not sorting merely hide theirs. Drawn only on the sorting
    // key, picking a column shoved the chips beside it along.
    it("holds the direction caret's space on every key", () => {
      renderPicker({ logs: library, value: 1 });
      open();

      // The quest list's own column keys — the picker sorts by those columns
      // and is labelled from them, so there is no second set of sort strings.
      const carets = ["date", "duration", "quest-elapsed-time"].map((key) => {
        const chip = screen.getByText(`ui.logs.${key}`).closest("button") as HTMLElement;
        return chip.querySelector("[aria-hidden]");
      });

      expect(carets.filter(Boolean)).toHaveLength(3);
      expect(carets.filter((caret) => caret?.classList.contains("invisible"))).toHaveLength(2);
    });

    it("sorts by how long the run took", () => {
      renderPicker({ logs: library, value: 1 });
      open();
      fireEvent.click(screen.getByText("ui.logs.duration"));

      expect(logIds()).toEqual(["1", "3", "2"]);
    });
  });
});
