---
name: understanding-the-analysis-view
description: Use when working on, discussing, reviewing or debugging the Relink Logs analysis view (the log viewer's Analysis mode) — pins, drilling, grouping, the table/timeline/events bodies, the chart and its windows, aura filters, hover cards — or when a request uses its vocabulary (source, target, ability, friendlies/enemies, buffs/debuffs, SBA window, Link Time, Break, damage cap, stun value, merge supplementary damage).
---

# Understanding the Analysis View

## Overview

The analysis view (`src/pages/logs/view/analysis/`) is the log viewer's Warcraft-Logs-style reader for one saved encounter. Its whole state is a URL, and one rule generates the UI:

**Three dimensions — source, ability, target — can each be pinned. The view groups its rows by the first dimension nobody has pinned. Clicking a row pins that dimension, which advances the grouping to the next free one. That is "drilling in".**

Everything else — which chart is drawn, which columns the table has, which hover card explains a row, which filters are offered — is *declared* per metric in `machine/capabilities.ts` and *resolved* by `machine/resolve.ts`. The view file itself decides almost nothing.

`AnalysisView.tsx` is the frame; the bodies below it swap. Use this skill's vocabulary verbatim when talking to the developer — the terms below are the ones the UI, the code and the developer all use.

## Vocabulary

### The three axes

- **Dimension** — one of `source`, `ability`, `target`. The only three axes there are (`machine/state.ts`, `DIMENSIONS`).
- **Pin** — a dimension fixed to one value. Pins live in the URL (`src`, `abil`, `tgt`), and are set by clicking a row or choosing from a selector. "Pin the source", "clear the ability pin".
- **Source** — the acting end of an event, and the view's top-level "who is this page about". Its selector is the **actor bar**, the topmost row, above the side toggle and the metric tabs. A value is an *actor index* in the current side's source universe: a player index on the friendly side, an enemy **spawn segment** on the enemy side (`universeOf`). On the buff/debuff tabs the friendly side reads Source as the effect's **holder**, and the enemy side reads it as the **caster** (`narrowedByPins`).
- **Target** — the receiving end. At most ONE (WCL's target axis), selected in the **pin bar** below the metric tabs. On the friendly side a target is an enemy **spawn**, never an actor id: the game reissues a dead boss's actor index to the next spawn, so an id-keyed pin fuses two enemies.
- **Ability** — one axis carrying three grammars, all in `abil`:
  - a friendly ability row key (`skill:…`, possibly a **skill-group** key ending `@<child>`),
  - an enemy attack on the Damage Taken tab (`taken:` + `{enemyType, actionId}` JSON),
  - a **status pin** (`status:<effect>:<cause>:<class>`) on the aura tabs.
  `isStatusPin` is what tells the third apart, and half a dozen consumers branch on it.

### Sides

- **Hostility** — the Friendlies/Enemies switch (`side=enemy`), sitting above the metric tabs. Not a filter: it **swaps which universe source and target draw from**, so changing it clears both actor pins. Stun and SBA have no enemy side (their toggle is disabled, not hidden).
- **Friendly / friendlies** — the party. Sources are players, targets are enemy spawns.
- **Enemy / enemies** — on Damage Done, "what each enemy dealt to the party"; on Damage Taken, "what the party dealt to each enemy". On the aura tabs it means enemy-held effects.

### Metrics (the tab row)

Six, declared in `CAPABILITIES`:

| Metric | Rows come from | Enemy side | Notes |
|---|---|---|---|
| **Damage Done** (`damage`) | group query | yes | the only metric recording supplementary damage |
| **Damage Taken** (`taken`) | group query | yes | empty on logs recorded before 2026-08-04 |
| **Stun** (`stun`) | derived meter state | no | no target dimension |
| **SBA** (`sba`) | derived meter state | no | no target dimension; per-ability split is local player only |
| **Buffs** (`buffs`) | status intervals | yes | polarity fixed, holders chosen by side |
| **Debuffs** (`debuffs`) | status intervals | yes | as above |

- **Data path** — which machinery produces rows: `groups` (the backend's `GroupQuery` aggregation), `derived` (the reconciled meter state — stun and SBA cannot be re-derived from a raw event walk), `intervals` (status windows). It decides far more than it looks: only the `groups` path gets aura filters, stacked group bands and a real "settled" moment after a fetch.
- **Buffs vs Debuffs** — polarity is the *game's own* harmful flag (`isHarmful`), not who holds the effect. Holder side is the hostility switch. The two axes are independent, which is why an enemy's own Bloodthirst is reachable under Buffs → Enemies rather than being misfiled as a debuff.

### Drilling

- **Drill / drill in** — pin the dimension the table is currently grouped by, so the table descends to the next free dimension. The canonical walk on Damage Done is source → ability → target.
- **Grouping (`groupBy`)** — the dimension the rows currently ARE. Derived: the first *supported, unpinned* dimension in the metric's `dimensionOrder`; with everything pinned it falls back to the last one (the one-row terminal, never a dead view).
- **Regroup / the "Done by …" strip** — the tabs between the pin bar and the chart that override the derived grouping (`by` in the URL). Any pin clears the override, so drilling resumes advancing.
- **Auto-drill** — when a pin leaves the table with exactly one row, the view pins that row too and keeps going while each new table has one row (`machine/useAutoDrill.ts`). Armed by a pin, never standing on its own — otherwise clearing the pin it applied would instantly re-apply it.
- **Terminal** — the deepest table, where all supported dimensions are pinned and the lone row is the pinned reading itself.

### The three bodies

The `tab` URL param switches the whole body below the frame. Everything above it — actor bar, side toggle, metric tabs, pin bar, regroup strip, chart, window strip, aura strips — is shared, which is why pins survive switching.

- **Table view** (the default; `tab` absent) — the metric's rows as bars with numeric columns. `MetricTable.tsx`.
- **Timeline view** (`tab=timeline`) — the SAME rows drawn against fight time, one **lane** per row. `timeline/`.
- **Events view** (`tab=events`) — the raw event stream, one row per event, with per-column filters and a jump-to-time box. `events/`.

Timeline vocabulary: a **lane** is a row's track; a **mark** is one drawn thing on it; a **cast** is a run of events sharing a cast identity; a lane's **shape** is `buckets` (a bar per run, ticks inside per hit), `icons` (same fold, carrying the ability's art) or `spans` (real uptime, for status rows).

### Rows

- **Row key** — the flat `player:` / `target:` / `actor:` / `enemy:` / `taken:` / `skill:` / `status:` / `source:` grammar in `rowKey.ts`. One author, parsed once (`rowRefOf`); every surface dispatches on the parsed union. A forgotten branch does not throw — it prints the raw key ("Normal:1000") or drops the icon, which looks like missing data rather than a bug.
- **Skill group** — several raw actions condensed into one ability row (`abilityRowKey`, `skillGroupFor`). A group key carries its **child character**, because Id's own kit and his dragonform's share group names.
- **Member skills** — what a group row expands into. The **expand caret** appears only at two or more children: a one-child expansion restates its parent.
- **Party slot / `colorSlot`** — which of the four player colours a row wears; `-1` means "no slot" (an enemy, a party-wide row, the SBA remainder).
- **`other` rollup** — the backend appends an `other` aggregate summing everything past `topN` (8) *without removing the rows it sums*. The table drops it; only the chart rolls the tail up. Never add it to a denominator.

### Filters and windows

Four independent narrowings. Keep them apart in conversation:

- **Window / scrub / zoom** — the committed chart range, as inclusive one-second bucket indexes (`from`/`to`). Set by dragging on the chart, cleared by double-clicking it or by the ✕ in the pin bar. It narrows every fetch, every table and the uptime denominators.
- **Battle windows** — spans of fight time the game was in a state, from the parser (`ChartWindow`): **SBA window** (a Skybound Art performance, chains merged), **Link Time window**, **Break window** (one enemy in Break; carries that enemy's actor index). Shaded on the chart and selectable as chips in the **Windows strip**. Several compose by **union** (windows of one kind never overlap, so intersecting would resolve to nothing). Selecting also zooms the chart to the selection's hull.
- **Source auras / target auras** — the aura filter strips between the chart and the body, one per actor pin. Each chip is an effect that pin's actor held; ticking chips restricts the fight to the time those effects were up. Several compose by **intersection** ("what did we do under the whole stack"). Each entry is anchored to the pin that produced it (`src:` / `tgt:`) and dies when that pin changes or clears. Damage Done and Damage Taken only.
- **Mask** — the aura ∩ battle-window intersection, in wire form. One mask feeds the group query, the reparse, the uptime tables and the excluded shading, so the plot and the numbers can never disagree. `undefined` means "no filter"; an empty array is a real mask that admits nothing.

### Chart

- **Band** — one stacked series (a player, an ability, an enemy). Capped at 8 (`GROUP_TOP_N`); the rest are marked `tail` and rolled up as **Other**, still switchable on from the legend.
- **Markers** — death lines and SBA cast lines drawn over the plot.
- **Smoothing** — the trailing moving-average window, offered on *rate* charts only. The SBA gauge is a level, not a rate, so smoothing is pinned off there — averaging would round off the discharge that is the reading.
- **Stacks** — the aura tabs' overlay: a pinned effect's per-holder stack depths.

### Tooltips

- **Tooltip / hover card** — the cursor-following panel: a table row's breakdown, a chart bucket's "At this moment" breakdown, a timeline mark's contents (`HoverCard.tsx`). Each section shows its **top five** entries and stays silent about the rest, WCL-style. Control hints are a different thing: the merge switch carries a Mantine `Tooltip`, and the disabled hostility toggle a native `title`.
- **Extended tooltip** — hold **Ctrl** while hovering: `useCtrlHeld` flips the card to `detailed`, lifting the five-entry cap so every entry shows. It works on the row cards, the chart tooltip and the timeline marks.
- **Cap card** — a separate card, on the Events tab's **Amount** cell: it explains one hit's **damage cap** (base cap from the ladder, the cap-ups that raised it, the consistency check). Always full — it has no Ctrl variant.

### Art

- **Character icon** — an actor's bust or an enemy's portrait. Its row draws the bar's own head *behind* it (`shape: "actor"`, head `point`).
- **Ability icon** — the game's diamond skill art. The bar is cut with a 45° **notch** so the diamond nests into it (`shape: "diamond"`, head `notch`).
- Every icon stands on a faint diamond ground; a row with no art still draws the empty box, which holds the name column's left edge steady. Rows genuinely without art: link attacks, echoes, DoT ticks, unnamed statuses, trash mobs.

### Game terms (GBFR)

- **SBA / Skybound Art** — the party's ultimate. The **SBA gauge** is stored in tenths of a percent. **SBA generation** is how much gauge a player built; it is attributed per skill only for the local player (a remote member's gauge is synced, not granted by a hit the hook can see), and what no skill or named cause explains lands in the **Unattributed** row.
- **Link Time** — the party-wide burst state a completed link-attack chain triggers.
- **Break** — the enemy stagger state; a **Break window** is one enemy sitting in it.
- **Stun value** — the per-hit stagger contribution the hook reads. Stun is recorded per player only (hence no enemy side and no target dimension); the table shows total and largest single hit.
- **Damage cap** — the game's per-hit ceiling. Base cap comes from a per-character **ladder** indexed by the move's **attack rate** (what community sheets call **MV**), then cap-up sources (sigil traits, overmastery, summon bonuses, mastery/collection, the DMG Cap trait) raise it. `events/cap*.ts` derives all of it; the Amount card shows the working.
- **Supplementary damage / echo** — the game's secondary damage tick attributed to a triggering hit. **Merge supplementary damage** ("Merge Sup DMG", the switch in the chart's control strip) makes an echo ride the skill that caused it; off, echoes stand on their own row. It is a *stored setting* (`merge_supplementary`), not a URL param — how someone reads damage should outlive the log they set it on. Merged figures are **landings** (an echo counted as part of the hit that caused it); unmerged are raw **events**. Only Damage Done records any, so the switch is disabled elsewhere.
- **Perfect Guard / Perfect Dodge** — defensive reactions; both appear as event kinds and as SBA gauge causes.
- **Spawn / segment** — one enemy instance, indexed into the response's `targetEntries`. The unit a target pin uses, because actor indexes are recycled.
- **Selection facts** — what the backend reports about the *unpinned* fight so the selectors keep offering what the other pins allow (the cascade).

### Around the view

- **Analysis view vs Classic view** — two readings of one saved log, swapped by the **view-mode toggle** in the top bar (Classic is the older meter-shaped page). "The analysis view" always means this one; "classic" means the other.
- **Log / encounter / quest** — a log is one saved encounter; the **quest summary** strip under the top bar names the quest, whether it was **Cleared**, the **IGT** (the game's own in-game timer) and, on Conflux runs, the room.
- **Overlay / meter** — the transparent always-on-top window that shows the *live* fight. It is a different window and a different page (`src/pages/Meter`); nothing in the analysis view is live.
- **Streamer mode / display names** — settings that change how players are NAMED everywhere in the view. A row that renders as an icon with no name is usually a naming-source problem, not a row problem.

## Working in this code

- Read `machine/capabilities.ts` first, then `machine/resolve.ts`. A question of the form "why does this tab show/hide/disable X" is nearly always answered by a declaration there, not by a branch in the view.
- Adding behaviour to the view usually means a new declaration or a new transition (`machine/transitions.ts`), not a new ternary in `AnalysisView.tsx`.
- The table and the timeline share `RowPresentation`, and the timeline and events share `StreamContext` (`model/bodyContext.ts`). Two bodies must draw one row identically — never resolve a name, an icon or a colour a second time.
- For the file-by-file map, the fetch/staleness rules and the traps that have actually bitten, read `code-map.md` in this skill's directory.

## Common misreadings

| Assumption | Reality |
|---|---|
| "Source means the player" | Source means the *acting end*. On the enemy side it is an enemy spawn; on the aura tabs' enemy side it is the caster. |
| "The grouping is a setting" | It is derived from which dimensions are pinned. `by` is only an override, and any pin clears it. |
| "Hostility filters the rows" | It swaps the universes of both actor pins, and clears them. |
| "Auras and battle windows are the same filter" | Different strips, different composition: auras intersect, battle windows union. |
| "The rows on screen answer the current grouping" | On the groups path they answer the *previous* one until the fetch lands (`answeredGroups`). Anything reading rows to make a decision must check that first. |
| "Merge Sup DMG is in the URL" | It is a stored setting; the URL carries no `supp` param any more. |
| "An enemy type row can be pinned" | Type rows merge same-type spawns and cannot choose one, so they are leaves. The hover card decomposes them instead. |
| "Clicking any row pins something" | `pinOnClick: null` is common — enemy types, enemy attacks on the taken tab, SBA causes, the unattributed remainder. |
