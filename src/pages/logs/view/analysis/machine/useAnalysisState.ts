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
 * The index is fixed for the lifetime of a pane component, so the hook count
 * here is stable however many panes are on screen. */
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
    () => decodeState({ metric, side, src, tgt, abil, from, to, by, aura, win }),
    [metric, side, src, tgt, abil, from, to, by, aura, win]
  );

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
