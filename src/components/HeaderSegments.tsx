import { renderTemplate, type TemplateTokens } from "@/labelTemplate";
import type { HeaderSegment } from "@/stores/useMeterSettingsStore";

/** The token whose segment carries the hook connection dot. */
const STATUS_TOKEN = "{status}";

export type HeaderSegmentsProps = {
  segments: HeaderSegment[];
  side: "left" | "right";
  tokens: TemplateTokens;
  /** Hook connection tone (`hook-ok` / `hook-warn` / …), applied to whichever
   * segment shows `{status}` — so the status dot follows the user's placement. */
  toneClass: string;
};

/**
 * The overlay header's templated pieces.
 *
 * Shared by the real titlebar and the settings preview so the two cannot
 * disagree about what a header looks like. A segment that renders to an empty
 * string is not rendered at all: that is what makes team damage appear only
 * once damage has landed, and boss HP only once a target has reported it,
 * without any per-section special-casing.
 *
 * `data-tauri-drag-region` must stay on each rendered div — Tauri only starts a
 * window drag when the mousedown target itself carries it, and it does not walk
 * up to ancestors.
 */
export const HeaderSegments = ({ segments, side, tokens, toneClass }: HeaderSegmentsProps) => (
  <>
    {segments
      .filter((segment) => segment.side === side)
      .map((segment) => ({ segment, text: renderTemplate(segment.template, tokens) }))
      .filter(({ text }) => text !== "")
      .map(({ segment, text }) => {
        // A status segment keeps the `encounter-status` class as well as the
        // tone: the connection dot is drawn by `.encounter-status.hook-*::before`,
        // so dropping the class would silently take the dot with it.
        const isStatus = segment.template.includes(STATUS_TOKEN);
        const classes = [
          "item",
          segment.hideWhenNarrow ? "hide-narrow" : "",
          isStatus ? "encounter-status" : "",
          isStatus ? toneClass : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div key={segment.id} data-tauri-drag-region className={classes}>
            {text}
          </div>
        );
      })}
  </>
);
