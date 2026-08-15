import { useQueryState } from "nuqs";
import { useCallback, useMemo } from "react";

import { paneParamName } from "./paneParams";
import { decodeState, encodeState, type AnalysisState } from "./state";

/** ONE PANE's analysis state, held in the URL — the machine's only state store.
 * Mirrors useSelectorParams' replace-history behaviour.
 *
 * `paneIndex` picks which pane's keys are read and written: pane 0 uses the
 * bare names every link written before compare existed already carries, later
 * panes suffix their index (see `paneParamName`). The SHARED fields — metric,
 * side, zoom, window filter — are unsuffixed for every pane, so all panes read
 * and write one of each.
 *
 * A pane's `paneIndex` must NOT change while it stays mounted. A caller
 * reindexing panes (closing pane 1 and shifting the rest down, say — pane 0 is
 * the log in the path and is never closed) has to remount the survivors —
 * `key={paneIndex}` on whatever renders this hook — rather than hand a live
 * pane a new index. nuqs's reconcile is a render-phase update: when a
 * `useQueryState` key changes, the render that observes the new key still reads
 * the internal state cached under the OLD key name, so it comes back
 * `undefined` for one render, then EMPTY for two more before the new key's real
 * value arrives (measured across a 2 -> 1 move: undefined, null, null, "7").
 * `decodeState` below defends against the undefined render, but a remount
 * avoids the whole window, which is the real fix. */
export const useAnalysisState = (paneIndex: number) => {
  const [metric, setMetric] = useQueryState("metric", { history: "replace" });
  const [side, setSide] = useQueryState("side", { history: "replace" });
  const [from, setFrom] = useQueryState("from", { history: "replace" });
  const [to, setTo] = useQueryState("to", { history: "replace" });
  const [win, setWinParam] = useQueryState("win", { history: "replace" });

  const [src, setSrc] = useQueryState(paneParamName("src", paneIndex), { history: "replace" });
  const [tgt, setTgt] = useQueryState(paneParamName("tgt", paneIndex), { history: "replace" });
  const [abil, setAbil] = useQueryState(paneParamName("abil", paneIndex), { history: "replace" });
  const [by, setBy] = useQueryState(paneParamName("by", paneIndex), { history: "replace" });
  const [aura, setAuraParam] = useQueryState(paneParamName("aura", paneIndex), { history: "replace" });

  const state = useMemo(
    // nuqs hands back `undefined` — not `null` — for one render after a key
    // CHANGES, because its reconcile is a render-phase update and this render
    // still reads the internal state keyed by the old name. `decodeState`'s
    // `raw.trim()`/`raw.split()` throw on undefined, and nuqs's own types
    // (`string | null`) hide it from tsc. Coalescing turns a crash into one
    // render of "no value", which the settled render then corrects.
    () =>
      decodeState({
        metric: metric ?? null,
        side: side ?? null,
        src: src ?? null,
        tgt: tgt ?? null,
        abil: abil ?? null,
        from: from ?? null,
        to: to ?? null,
        by: by ?? null,
        aura: aura ?? null,
        win: win ?? null,
      }),
    [metric, side, src, tgt, abil, from, to, by, aura, win]
  );

  // Every pane writes the shared fields, not just pane 0. The state object is
  // whole — a pane must be able to change the metric or the zoom, and those
  // are shared by definition — and the writes are idempotent because every
  // pane holds the same shared values. Verified with two panes mounted: pane
  // 1 writing its own pin leaves pane 0's pin untouched while pane 0 correctly
  // observes the shared change. Do NOT "optimise" non-zero panes to skip these
  // writes; that would make a pane unable to change the metric. The one real
  // hazard is two panes writing DIFFERENT shared values in one tick, where
  // last-writer-wins is arbitrary — which is why shared controls belong in the
  // frame with a single writer, not duplicated per pane.
  const setState = useCallback(
    (next: AnalysisState) => {
      const raw = encodeState(next);
      setMetric(raw.metric);
      setSide(raw.side);
      setSrc(raw.src);
      setTgt(raw.tgt);
      setAbil(raw.abil);
      setFrom(raw.from);
      setTo(raw.to);
      setBy(raw.by);
      setAuraParam(raw.aura);
      setWinParam(raw.win);
    },
    [setMetric, setSide, setSrc, setTgt, setAbil, setFrom, setTo, setBy, setAuraParam, setWinParam]
  );

  return [state, setState] as const;
};
