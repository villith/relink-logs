/** How a status row's key is spelled: the effect, then the ability that caused
 * it, or the literal `unknown` where the hook could not attribute one. */
const STATUS_KEY = /^status:(\d+):(\d+|unknown)$/;

/** Display name for a `status:<effect>:<cause>` row key.
 *
 * Reads as `Attack Up (Signo Drive)` — effect first so that two abilities
 * granting one effect sort next to each other, cause in parentheses because
 * they are nonetheless two separate rows.
 *
 * Both names are injected rather than looked up here, for the same reason
 * `abilityLabelFor` injects `skillName`: the lookups need i18n and the settings
 * store, and this stays a pure function. An effect with no name falls back to
 * its raw id — status.tbl is not extracted yet, so that is the shipping path
 * rather than a corner case, and it is better than a blank row.
 *
 * Anything that is not a status key is handed back untouched: a stale or
 * hand-edited pin, where showing it to the user is what explains the empty
 * table. */
export const statusLabelFor = (
  key: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
  names: { effect: (statusId: number) => string; cause: (abilityId: number | null) => string }
): string => {
  const parsed = STATUS_KEY.exec(key);
  if (!parsed) return key;

  const [, statusId, causeId] = parsed;
  const abilityId = causeId === "unknown" ? null : Number(causeId);

  return t("ui.logs.buff-label", {
    effect: names.effect(Number(statusId)) || t("ui.logs.buff-effect-unnamed", { id: statusId }),
    cause: names.cause(abilityId) || t("ui.logs.buff-cause-unknown"),
  });
};
