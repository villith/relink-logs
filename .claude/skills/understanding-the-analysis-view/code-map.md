# Analysis View — Code Map

Where things live, how data reaches the screen, and the traps that have actually
bitten. Read after the vocabulary in `SKILL.md`.

## The URL is the state

`machine/useAnalysisState.ts` decodes ten nuqs params into one `AnalysisState`
and writes them back. Every field degrades to its default on its own — one bad
value must not discard the others.

| Param | Field | Meaning |
|---|---|---|
| `metric` | `metric` | `damage` (default, omitted) / `taken` / `stun` / `sba` / `buffs` / `debuffs` |
| `side` | `hostility` | absent = `friendly`; `enemy` |
| `src` | `source` | actor index in the side's source universe |
| `tgt` | `target` | ONE spawn segment (a player index on the enemy side) |
| `abil` | `ability` | ability row key, `taken:` attack JSON, or `status:…` |
| `from` / `to` | `window` | committed scrub, inclusive bucket indexes (1 bucket = 1 s, `DPS_BUCKET_MS`) |
| `by` | `by` | explicit grouping override |
| `aura` | `aura[]` | comma list of `src:`/`tgt:` + status key; composes by **intersection** |
| `win` | `win[]` | comma list of `sba`/`link`/`break`, optional `:index`; composes by **union** |
| `tab` | — | `timeline` / `events`; absent = the table. Its own key, so pins survive a body switch. |

`aura` and `win` are gated per entry by `AURA_KEY` / `WIN_KEY` regexes. A
grammar those do not admit makes the whole filter silently inert — the aura
key's class segment was once added without updating the regex, and the chips
stopped selecting with no error anywhere.

## Layout

```
src/pages/logs/view/
  analysis/
    AnalysisView.tsx          the frame; wires every hook, swaps the body
    machine/                  the state machine — the view's brain
      state.ts                AnalysisState, the URL codec, the key grammars
      capabilities.ts         CAPABILITIES: what each metric can do
      resolve.ts              state + capabilities -> ViewSpec (grouping, columns, fetch)
      transitions.ts          pinRow, clearPin, setMetric, setHostility, regroup, toggles
      groupRows.ts            backend aggregates -> MetricRow[] (+ chart bands)
      answeredGroups.ts       which grouping the aggregates in hand actually answer
      useAnalysisState.ts     the URL binding
      autoDrill.ts / useAutoDrill.ts   the single-row auto-drill rule
      matrix.test.ts / wclParity.test.ts   whole-machine sweeps
    model/                    view-model hooks, one concern each
      useEncounterData.ts     the base load, the scoped fetch, generation guards
      useRowModel.tsx         rows + names + art + colours + cards
      useChartModel.ts        series, legend, markers, bands
      useActorIdentity.ts     every name/picture/colour an actor wears
      useEntityCells.ts       the one entity ladder the whole view resolves through
      useSelectorModel.ts     pick lists and the event stream's cells
      useFilterWindows.ts     masks (aura ∩ window) and the chip strips
      useStatusNaming.ts      effect naming + cause classification, one ladder
      bodyContext.ts          RowPresentation and StreamContext
    MetricTable.tsx, DpsChart.tsx, HoverCard.tsx, MetricBar.tsx,
    AnalysisRow.tsx, RowArt.tsx, ActorBar.tsx, PinBar.tsx, WindowStrip.tsx,
    AuraStrip.tsx, RegroupStrip.tsx, MetricTabs.tsx, HostilityToggle.tsx,
    CollapseSupplementaryToggle.tsx, QuestSummary.tsx, DebugBar.tsx
  timeline/                   lanes, marks, cast folding, lane shapes
  events/                     the raw stream, column filters, cap breakdown
  metrics/                    the six descriptors (rows, columns, cards)
  rowKey.ts                   THE row/band key grammar
  entity.ts                   EntityCell: name + art + colour, together
  abilitySkills.ts            skill grouping, echo keying, pin expansion
  statusUptime.ts             status keys, clipping, uptime maths
```

## Data flow

1. **Base load** — `fetch_encounter_state` with no pins. Owns the charts, the
   party and the quest metadata, which no pin changes. Carries the current group
   query too, so the groups path has rows on first paint.
2. **Scoped fetch** — everything the pins, the window, the grouping and the masks
   change. Sends `stateOnly`; keyed on the *request's JSON identity*, so a
   byte-identical request is never repeated.
3. **`ViewSpec`** — `resolveViewSpec(state, caps)` returns the grouping, the
   regroup tabs, the table's columns and empty state, the chart source, and the
   `GroupQuery` (or null). The view reads the spec, not the state, for anything
   presentational.
4. **Rows** — `groupRowsFor` on the groups path; the metric descriptor's `rows`
   on the derived and interval paths.
5. **Presentation** — `RowPresentation` goes to both the table and the timeline;
   `StreamContext` goes to both the timeline and events.

### Response ordering

`fetch_encounter_state` is `#[tauri::command(async)]`, so responses are NOT
ordered against their requests. Both fetches carry a generation counter and drop
themselves once superseded. The scoped fetch also *stamps its aggregates with
the grouping it asked for*, which is what `answeredGroups` reads.

**The staleness rule:** the requested grouping flips the instant a pin lands;
the aggregates that answer it arrive a fetch later. Chart derivations key off
`chartGroupBy` (what the data answers), never `spec.groupBy` (what was asked).
Anything new that reads rows to make a decision must do the same — that is
exactly what `useAutoDrill`'s `settled` input is for.

## Invariants

- **One namer, one illustrator, one colour.** Every surface resolves through
  `useEntityCells` / `entity.ts`. A second lookup is how a row comes to be named
  in the table and pictured differently in the chart above it.
- **One row keying.** `rowKeyingFor` is built once and passed down. The table,
  the bands and the timeline must agree about which row an echo sits on.
- **Cause ids are per-character.** `Normal(100)` is a different move on every
  character. Any map keyed by a bare action id attributes one player's hits to
  another (`causeIndexKey` exists for this reason).
- **Extremes and hits describe one population.** Under the landing model an
  extreme IS a whole landing; do not re-derive min/max from raw rows when
  reporting merged figures.
- **`other` is never in a denominator.** The backend appends it *without*
  removing the rows it sums.
- **Uptime denominators follow the window.** A scrubbed status table reports
  uptime within the window, not diluted across the whole fight.

## Traps

- **Spreading a presentation object into a component only type-checks the props
  it declares.** Renaming `rowName` to `renderName` on `MetricTable` did not
  fail the build — every row silently fell back to its raw label and drew
  "Normal:1100".
- **An unhandled key prefix does not throw.** It renders the raw key or drops
  the icon. Both look like missing data. Dispatch on `rowRefOf`'s parsed union
  so TypeScript names every surface that must answer for a new variant.
- **A status pin is not an ability pin.** It narrows nothing the backend knows
  about; sending it as an action filter empties the damage tables.
- **A stale index narrows, never widens.** A target pin or a `win:index` that no
  longer resolves selects nothing — the empty table is the honest answer.
- **Effects run on rows that may be stale.** See the response-ordering rule
  above.
- **Undefined CSS custom properties fail silently.** A dropped token layer once
  broke the view's sizing with a green build and green tests.

## Tests worth copying

- `machine/matrix.test.ts` and `machine/wclParity.test.ts` sweep the whole
  metric × side × pin space — the fastest way to check a machine change did not
  break a quadrant nobody clicks.
- `machine/groupRows.test.ts` covers the fold, the echo keying and the columns.
- Targeted runs only: `npx vitest run src/pages/logs/view/analysis/machine`.
  Full suites lock the machine; batch them.
