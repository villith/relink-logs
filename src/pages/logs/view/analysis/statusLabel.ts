import type { Hostility, LabelKind } from "../metrics/types";
import { isStatusPin } from "../statusUptime";

/** How a status row's key is spelled: the effect, then the ability that caused
 * it, or the literal `unknown` where the hook could not attribute one. */
const STATUS_KEY = /^status:(\d+):(\d+|unknown)$/;

/** What a status table's rows currently ARE, for labelling them and for naming
 * the column above them.
 *
 * The PIN decides whether they are effects or holders, exactly as `statusRows`
 * decides which rows to build; the HOSTILITY decides what a holder is — a
 * player on the friendly side, an enemy spawn on the enemy side. The tab
 * cannot: with the hostility switch either tab can show either side. */
export const statusRowKindFor = (pin: string | null, hostility: Hostility): LabelKind =>
  isStatusPin(pin) ? (hostility === "friendly" ? "player" : "target") : "status";

/** How a debuff holder row names the enemy that held the effect: the SPAWN it
 * belonged to, or the bare actor id when the segmenter never placed it. */
const TARGET_ROW = /^(target|actor):(\d+)$/;

/** Display name for a debuff holder row.
 *
 * Two spellings because there are two things to say. `target:<n>` indexes the
 * response's `targetEntries`, which is what carries an enemy's name and its
 * "#n" — the actor index cannot, because the game reissues a dead boss's index
 * to the next one. `actor:<id>` is the fallback for an enemy with no segment at
 * all (a phantom marker actor the segmenter skips): its window is real capture,
 * so the row stays, showing the only identity there is.
 *
 * `labelForTarget` is injected for the same reason `statusLabelFor` injects its
 * names — it needs i18n and the entries vector, and this stays pure. */
export const targetRowLabel = (label: string, labelForTarget: (segment: number) => string): string => {
  const parsed = TARGET_ROW.exec(label);
  if (!parsed) return label;

  const [, kind, id] = parsed;
  return kind === "target" ? labelForTarget(Number(id)) : id;
};

/** The hook's `+0x4c` cause discriminator, as displayed.
 *
 * The number itself, because it is what keeps two abilities granting one
 * effect on separate rows and no mapping from it to a skill name exists (see
 * the hook's status module: it is an effect-entry constant, not an action id).
 * All-ones is the game's own "no value", so it reads as unattributed instead
 * of as a nine-digit number the user can do nothing with. */
export const causeLabel = (id: number | null): string => (id === null || id === 0xffffffff ? "" : String(id));

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
