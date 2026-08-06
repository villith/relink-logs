/**
 * Turns an MSVC RTTI class name into display text for a status row's source.
 *
 * The binary's naming is inconsistent — `StatusPl1200UniqueBuffGuardpoint`
 * carries the prefix, `Pl0400ConcentrationEx` does not — so every affix is
 * stripped defensively rather than assumed present.
 *
 * Deliberately NOT lossy at the tail: `AttackBuff` stays "Attack Buff" rather
 * than becoming "Attack", because dropping it changes the claim. Awkward
 * results are fixed by a `ui.json` override, not by a cleverer rule here.
 */

/** Classes that name a mechanism nowhere — every status shares them, so they
 * carry no provenance. Recorded rather than omitted so "no distinguishing
 * class" stays a fact instead of a lookup miss. */
const NAMELESS = new Set(["StatusBase", "ExStatus", "Status", "StatusNode"]);

/** Leading actor code: pl/em/np/so/ba/we + four digits. */
const ACTOR_CODE = /^(?:Pl|Em|Np|So|Ba|We)\d{4}/;

/** Display text for a class name, or "" when nothing distinguishing is left. */
export const prettifyClassName = (className) => {
  let rest = className;
  if (rest.startsWith("Status")) rest = rest.slice("Status".length);
  rest = rest.replace(ACTOR_CODE, "");
  if (rest.startsWith("Unique")) rest = rest.slice("Unique".length);
  // Only a LEADING Buff is noise ("BuffGuardpoint"); a trailing one is meaning.
  if (rest.startsWith("Buff")) rest = rest.slice("Buff".length);
  return rest
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
};

/** Whether a class conveys no provenance and must never name a row. */
export const isNameless = (className) =>
  NAMELESS.has(className) || prettifyClassName(className) === "";
