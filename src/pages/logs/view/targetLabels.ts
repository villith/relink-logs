import type { EnemyType, TargetEntry } from "@/types";
import { humanizeNumbers, targetLabelKey } from "@/utils";

/** What labelling needs of a spawn segment — the whole `TargetEntry` is
 * accepted, this only names the parts that are read. */
export type TargetLabelEntry = Pick<TargetEntry, "enemyType" | "instance" | "maxHp">;

/** Display labels for every target spawn segment, keyed by
 * `targetLabelKey(enemyType, instance)`.
 *
 * Shared by the quest view's HP-chart legend, its target filter and the analysis
 * view's target pin, so the three can never disagree on what one enemy is
 * called. The game names summon INSTANCES individually, but only the type is in
 * the data, hence the ordinals.
 *
 * The rules, in order:
 *
 * - A name occurring once in the fight is shown bare. A lone boss is "Bahamut",
 *   not "Bahamut #1" — the ordinal only earns its place when it separates
 *   something.
 * - Same-name entries (summon waves, sibling adds) each take an instance suffix
 *   so each keeps its own identity.
 * - When one name additionally spans different pool sizes (Lucilius' 141m vs 49m
 *   swords), the pool size is the only distinguisher we have, so show it.
 *
 * The "#n" counts within the NAME, not within the type hash. `entry.instance` is
 * per-type, and en/enemies.json has 19 display names shared by two or three
 * distinct type hashes (Fotia, Anemos, Edafos, Hydor, the Goblin variants —
 * exactly the summon-heavy fights this is for), so two such types would both be
 * "#1"; since the HP chart uses the label as its series key, one pool's line
 * would silently overwrite the other's. Entries arrive in first-hit order, so
 * the ordinals stay chronological.
 *
 * `enemyName` is injected rather than imported so this stays pure and testable;
 * callers pass `translateEnemyType` and re-derive on a language change. */
export const buildTargetLabels = (
  entries: TargetLabelEntry[],
  enemyName: (type: EnemyType) => string
): Map<string, string> => {
  // Named once per entry, not once per pass: `enemyName` is an i18n lookup and
  // the ordinals below need the same answer the counts were built from.
  const named = entries.map((entry) => ({ entry, name: enemyName(entry.enemyType) }));

  const byName = new Map<string, { count: number; maxes: Set<number> }>();
  for (const { entry, name } of named) {
    let seen = byName.get(name);
    if (!seen) {
      seen = { count: 0, maxes: new Set() };
      byName.set(name, seen);
    }
    seen.count += 1;
    if (entry.maxHp !== null) seen.maxes.add(entry.maxHp);
  }

  const ordinalsByName = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const { entry, name } of named) {
    const ordinal = (ordinalsByName.get(name) ?? 0) + 1;
    ordinalsByName.set(name, ordinal);

    const seen = byName.get(name);
    let label = name;
    if (seen && seen.count > 1) {
      label = `${name} #${ordinal}`;
      if (seen.maxes.size > 1 && entry.maxHp !== null) {
        const [max, maxUnit] = humanizeNumbers(entry.maxHp);
        label = `${label} (${max}${maxUnit})`;
      }
    }
    labels.set(targetLabelKey(entry.enemyType, entry.instance), label);
  }
  return labels;
};

