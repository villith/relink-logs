import classes from "../src-tauri/assets/status-classes.json";

type ClassTable = Record<string, { class: string; name: string }>;

/**
 * Display name for a status's RTTI class hash, or "" when there is none.
 *
 * The class names the MECHANISM that applied an effect —
 * `StatusPl1200UniqueBuffGuardpoint` is Vaseraga's guardpoint — which is the
 * only thing that can name a row whose cause is a sentinel: 9998 means no
 * activated action produced the effect, so there is no action id to look up.
 *
 * Two sources, override first: `ui.json`'s `causes.classes.<ClassName>` is
 * where a human improves a name, and the generated table is the mechanical
 * fallback. Keyed by CLASS NAME rather than by hash so the override stays
 * readable and survives a regeneration — the hash is derived from the name, so
 * a patch cannot change one without changing the other.
 *
 * The hash, never the vtable address, is what reaches a stored log: an old log
 * can therefore fail to resolve, but can never resolve to the WRONG class.
 * A miss is the ordinary case rather than a failure, so it answers "" and the
 * caller falls through to the next rung.
 *
 * `t` is injected for the same reason the other label lookups inject theirs:
 * it needs i18n, and this stays pure.
 */
export const statusClassName = (
  classHash: number | null,
  t: (key: string, vars?: Record<string, unknown>) => string,
  table: ClassTable = classes as ClassTable
): string => {
  if (classHash === null) return "";
  const entry = table[String(classHash)];
  if (entry === undefined) return "";
  return t(`causes.classes.${entry.class}`, { defaultValue: "" }) || entry.name;
};
