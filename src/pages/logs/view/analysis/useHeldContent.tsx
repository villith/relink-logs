import { useRef, type ReactNode } from "react";

/** The last content rendered while the view was settled, kept on screen while it
 * is not.
 *
 * A metric, side, pin or regroup change asks a NEW question, and the answer is a
 * fetch away. What was drawn before is a real answer to a real question; what
 * can be drawn in the meantime is not an answer to either. So the previous
 * render stays put until the new one is ready, and the view changes once.
 *
 * This works because a React element is an immutable description: re-rendering
 * last render's element produces last render's output, whatever the component
 * has computed since. The children keep their instances — their state, their
 * scroll positions and their own subscriptions all survive — so this holds a
 * picture, not a frozen tree.
 *
 * The caller must make the held copy INERT while it is held (see
 * `.analysis-pane-held`): its handlers close over the state that produced it, so
 * clicking a row in it would pin against a reading that is no longer on screen.
 */
export const useHeldContent = (content: ReactNode, holding: boolean): ReactNode => {
  // Written during render, which is safe here for the one reason it usually is
  // not: nothing else reads it, the write is idempotent, and a discarded render
  // can only ever have stored content equivalent to the one that replaces it.
  const held = useRef<ReactNode>(content);
  if (!holding) held.current = content;
  return held.current;
};
