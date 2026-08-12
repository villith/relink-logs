import { invoke } from "@tauri-apps/api";
import { useEffect, useRef, useState } from "react";

import type { EventPage, LogEvent, PlayerCapUp } from "@/types";

/** How many events one fetch asks for.
 *
 * The whole stream in one call, not a sliding page: the kind and pin filters run
 * client-side, and filtering WITHIN a page would leave the scrollbar (sized by
 * the unfiltered total) disagreeing with the rows — turning the gauge ticks off
 * drops 29% of a log. A capped fetch-all keeps the filters honest.
 *
 * 50,000 is ~20x the average stored log (~2,100 events across a 721-log census).
 * A log past it is reported as truncated in the UI rather than silently cut. */
export const EVENT_FETCH_CAP = 50_000;

/** The raw event stream for `id`, with timestamps already rebased to the fight
 * start by the backend.
 *
 * Generation-counted for the same reason the analysis view's own fetches are:
 * the command is `#[tauri::command(async)]`, so a slow response can land after a
 * newer one and must drop itself. */
export const useEvents = (id: string | undefined) => {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [total, setTotal] = useState(0);
  // Keyed by slot key; empty for a log recorded before the cap-up capture, which
  // the card reads as "show the Stage-1 rows" rather than "the cap-up was zero".
  const [capUp, setCapUp] = useState<Record<string, PlayerCapUp>>({});
  const [suppPairs, setSuppPairs] = useState<Record<number, number>>({});
  const generation = useRef(0);

  useEffect(() => {
    if (!id) return;
    const mine = ++generation.current;

    invoke("fetch_encounter_events", { id: Number(id), offset: 0, count: EVENT_FETCH_CAP })
      .then((result) => {
        if (mine !== generation.current) return;
        const page = result as EventPage;
        setEvents(page.events);
        setTotal(page.total);
        setCapUp(page.capUp ?? {});
        setSuppPairs(page.suppPairs ?? {});
      })
      .catch(() => {
        // No toast: the analysis view already reports its own fetch failures for
        // this same log, and a second one for the same cause is just noise. The
        // empty state below the table is what the reader sees.
        if (mine !== generation.current) return;
        setEvents([]);
        setTotal(0);
        setCapUp({});
        setSuppPairs({});
      });
  }, [id]);

  return { events, total, capUp, suppPairs };
};
