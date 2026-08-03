/** Validate a stored roll count against a tool's own bounds.
 *
 * Both roll-based tools persist a count and both have to defend against the
 * same three things, so the predicate lives here rather than being written out
 * per tool: a value outside 1..`max` came from a hand-edited settings.db, an
 * older shape, or a lowered `max`, and the tool's default is the safe answer.
 * 0 is what the input holds while the user has cleared the field and is never
 * persisted — treated as absent here too, or the tool reopens with an empty
 * field, a disabled action, and no auto-run.
 */
export const sanitizeRollCount = (value: unknown, max: number, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
