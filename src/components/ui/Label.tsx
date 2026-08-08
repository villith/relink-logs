import type { ElementType, ReactNode } from "react";

export type LabelProps = {
  children: ReactNode;
  /** The element to render. A column head is a `span`; a run of rows under a
   * heading is a real heading, and saying so is what puts it in the document
   * outline instead of leaving it as styled text. */
  as?: ElementType;
  className?: string;
  /** For a caption whose group already carries the accessible name — the
   * sighted reader's copy of it would otherwise be announced twice. */
  "aria-hidden"?: boolean;
};

/** Small tracked capitals in dimmed ink — the app's caption voice.
 *
 * One component for every such label: column heads, section subheaders, the
 * timeline's lane-group headings and the caption in front of a `PillGroup`.
 * These were four separate CSS rules saying the same thing, two of them
 * byte-identical, which is how one of them came to drift a letter-spacing. */
export const Label = ({ children, as: Component = "span", className, ...rest }: LabelProps) => (
  <Component
    {...rest}
    className={["text-label font-semibold uppercase tracking-[0.08em] text-ink-3", className].filter(Boolean).join(" ")}
  >
    {children}
  </Component>
);
