import { useQueryState } from "nuqs";
import { useCallback, useMemo } from "react";

import { decodeState, encodeState, type AnalysisState } from "./state";

/** The analysis state held in the URL — the machine's only state store.
 * Mirrors useSelectorParams' replace-history behaviour. */
export const useAnalysisState = () => {
  const [metric, setMetric] = useQueryState("metric", { history: "replace" });
  const [side, setSide] = useQueryState("side", { history: "replace" });
  const [src, setSrc] = useQueryState("src", { history: "replace" });
  const [tgt, setTgt] = useQueryState("tgt", { history: "replace" });
  const [abil, setAbil] = useQueryState("abil", { history: "replace" });
  const [from, setFrom] = useQueryState("from", { history: "replace" });
  const [to, setTo] = useQueryState("to", { history: "replace" });
  const [by, setBy] = useQueryState("by", { history: "replace" });
  const [aura, setAuraParam] = useQueryState("aura", { history: "replace" });
  const [win, setWinParam] = useQueryState("win", { history: "replace" });

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
