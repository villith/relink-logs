import { Box, UnstyledButton } from "@mantine/core";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/components/ui/cn";

import { actionStamp, entryRows, formatReport, type ActionEntry, type ReportLine } from "./machine/actionLog";
import type { ActionLog } from "./machine/useActionLog";

/** Monospace, wrapping and selectable: the whole purpose of a readout line is to
 * be read exactly and pasted into a bug report. Several lines are single
 * unbroken tokens, so `anywhere` is the only break that keeps a long pin set or
 * a whole group query inside the panel. */
const LINE_CLASS = "min-w-0 flex-1 select-text font-mono text-xs leading-[1.6] text-ink-3 [overflow-wrap:anywhere]";

/** The label column, wide enough for the longest label any row uses and fixed
 * so the values line up down the panel the way they do in the pasted report. */
const LABEL_CLASS = "mr-1.5 inline-block w-14 flex-none text-accent";

export type DebugBarProps = {
  /** The URL query string exactly as it stands, leading "?" and all. */
  search: string;
  /** The resolved state block — what the machine made of that URL. */
  readout: ReportLine[];
  /** Every step the user took to get here, this mount. */
  actions: ActionLog;
};

/** How long the button says "copied" before going back to offering the copy. */
const COPIED_MS = 1200;

/** A button that puts one string on the clipboard and confirms on itself. */
const CopyButton = ({ label, value, ariaLabel }: { label: string; value: string; ariaLabel?: string }) => {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  // Cleared on unmount as well as on the timer: the bar unmounts the moment the
  // view switches bodies, and a setState after that is a React warning.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <UnstyledButton
      className={cn(
        "flex-none cursor-pointer rounded-[3px] border bg-panel px-1.5 text-label uppercase leading-[1.7] tracking-[0.06em]",
        // Confirmation lives on the button itself — a toast for a dev readout
        // would be louder than the thing it reports.
        copied ? "border-accent text-accent" : "border-line text-ink-3 hover:border-line-strong hover:text-ink-2"
      )}
      aria-label={ariaLabel}
      onClick={() => {
        // Fire-and-forget. The clipboard is unavailable in a few contexts (an
        // insecure origin, a denied permission), and a dev readout must not
        // throw an unhandled rejection at the app over it — the button simply
        // never confirms.
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? t("ui.debug.copied") : label}
    </UnstyledButton>
  );
};

/** One `label   value` readout row. */
const ReadoutRow = ({ label, value }: ReportLine) => (
  <div className={LINE_CLASS}>
    <span className={LABEL_CLASS}>{label}</span>
    <span>{value}</span>
  </div>
);

/** One recorded step: its number and stamp, then a row per field that moved.
 *
 * The step's own query is deliberately NOT drawn. It is in the pasted report,
 * where a replay needs it; on screen it would triple the height of the trail
 * with strings that differ from their neighbour in one character. */
const ActionRow = ({ entry }: { entry: ActionEntry }) => (
  <div className="flex gap-2 font-mono text-xs leading-[1.6] text-ink-3">
    <span className="w-6 flex-none select-text text-right text-ink-2">{entry.seq}</span>
    <span className="w-12 flex-none select-text">{actionStamp(entry.atMs)}</span>
    <div className="min-w-0 flex-1 select-text [overflow-wrap:anywhere]">
      {entryRows(entry).map((row, index) => (
        <div key={index}>
          <span className={LABEL_CLASS}>{row.label}</span>
          <span>{row.value}</span>
        </div>
      ))}
    </div>
  </div>
);

/** The recorded trail, collapsed behind its own count.
 *
 * Collapsed by default because it grows without bound during a session, and a
 * panel that pushes the table down the page on every dev run is a panel that
 * gets switched off for good. The count is always visible, so there is still a
 * sign that anything was recorded. */
const ActionTrail = ({ actions }: { actions: ActionLog }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Caret = open ? CaretDown : CaretRight;

  return (
    <>
      <UnstyledButton
        className="flex cursor-pointer items-center gap-1 text-label uppercase leading-[1.7] tracking-[0.06em] text-ink-3 hover:text-ink-2"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
      >
        <Caret size={12} />
        <span>{t("ui.debug.analysis-actions")}</span>
        <span className="font-mono text-ink-2">{actions.entries.length}</span>
      </UnstyledButton>

      {open && (
        // Bounded and scrolled: the trail is the one part of this panel with no
        // ceiling on its height.
        <div className="mt-1 max-h-40 overflow-y-auto">
          {actions.dropped > 0 && (
            // Stated rather than left implicit: a truncated trail reading as a
            // complete one sends the reader hunting in the wrong steps.
            <div className="font-mono text-xs leading-[1.6] text-ink-3">
              {t("ui.debug.analysis-actions-dropped", { count: actions.dropped })}
            </div>
          )}
          {actions.entries.length === 0 ? (
            <div className="font-mono text-xs leading-[1.6] text-ink-3">{t("ui.debug.analysis-actions-empty")}</div>
          ) : (
            actions.entries.map((entry) => <ActionRow key={entry.seq} entry={entry} />)
          )}
        </div>
      )}
    </>
  );
};

/** Dev-only readout of what the view is currently asking for, and of how the
 * user got it to ask.
 *
 * The pins live in the URL, so the query string IS the view's state — but what
 * the machine RESOLVED those pins into (the grouping, the group query it sent,
 * whether the rows have caught up with it) is what tells a chart drawing the
 * wrong fight apart from one drawing the right fight. The trail below adds the
 * part no snapshot holds: the order the user did things in, which is usually
 * the difference between a bug and a state nobody can reproduce.
 *
 * Everything is printed verbatim and left selectable, and one button pastes the
 * lot as a single report.
 *
 * Guarded by `import.meta.env.DEV` at the call site, the same way the Debug tab
 * is: a release build never renders it. */
export const DebugBar = ({ search, readout, actions }: DebugBarProps) => {
  const { t } = useTranslation();

  return (
    <Box className="border-t border-line bg-plot px-4 pb-2 pt-1.5">
      {/* The query keeps a copy button of its own: it is the one line that goes
          back into an address bar on its own, and hand-selecting a line that
          wraps at `anywhere` is how half a pin set ends up in a report. */}
      <div className="flex items-start gap-2">
        <ReadoutRow
          label={t("ui.debug.analysis-query")}
          // The COPY is the raw value, never the displayed one: an empty query
          // shows "(none)", and a report pasting that back would be pasting a
          // word this component invented.
          value={search === "" ? t("ui.debug.analysis-query-empty") : search}
        />
        <CopyButton label={t("ui.debug.copy")} value={search} ariaLabel={t("ui.debug.copy-query")} />
      </div>

      {readout.map((line) => (
        <ReadoutRow key={line.label} label={line.label} value={line.value} />
      ))}

      <div className="mt-1.5 flex items-start justify-between gap-2 border-t border-line pt-1.5">
        <ActionTrail actions={actions} />
        {/* Built from the props rather than from what is on screen, so a report
            taken while the trail is collapsed still carries all of it. */}
        <CopyButton
          label={t("ui.debug.copy-report")}
          value={formatReport({ query: search, readout, entries: actions.entries, dropped: actions.dropped })}
        />
      </div>
    </Box>
  );
};
