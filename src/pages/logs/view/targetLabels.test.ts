import { describe, expect, it } from "vitest";

import type { EnemyType } from "@/types";
import { targetLabelKey } from "@/utils";

import { buildTargetLabels, type TargetLabelEntry } from "./targetLabels";

/** Stands in for `translateEnemyType`: "Em0003" names itself, and the two hashes
 * below deliberately share one display name, which the real enemy tables do 19
 * times over (Fotia, Anemos, the Goblin variants). */
const NAME = (type: EnemyType) => {
  if (typeof type !== "string") return `Unknown 0x${type.Unknown.toString(16)}`;
  if (type === "Em9001" || type === "Em9002") return "Goblin";
  return type;
};

const entry = (enemyType: EnemyType, instance: number, maxHp: number | null = 1000): TargetLabelEntry => ({
  enemyType,
  instance,
  maxHp,
});

const labelOf = (labels: Map<string, string>, e: TargetLabelEntry) =>
  labels.get(targetLabelKey(e.enemyType, e.instance));

describe("buildTargetLabels", () => {
  it("leaves a unique enemy unsuffixed", () => {
    const boss = entry("Em0003", 1);

    const labels = buildTargetLabels([boss], NAME);

    expect(labelOf(labels, boss)).toBe("Em0003");
  });

  it("numbers repeated spawns of one type in first-hit order", () => {
    const first = entry("Em0100", 1);
    const second = entry("Em0100", 2);

    const labels = buildTargetLabels([first, second], NAME);

    expect(labelOf(labels, first)).toBe("Em0100 #1");
    expect(labelOf(labels, second)).toBe("Em0100 #2");
  });

  it("suffixes a boss that is unique even while another type repeats", () => {
    const boss = entry("Em0003", 1);
    const adds = [entry("Em0100", 1), entry("Em0100", 2)];

    const labels = buildTargetLabels([boss, ...adds], NAME);

    expect(labelOf(labels, boss)).toBe("Em0003");
    expect(labelOf(labels, adds[0])).toBe("Em0100 #1");
  });

  it("numbers within the display name, so two type hashes sharing a name stay distinct", () => {
    // Both are "Goblin". Numbering per type would label both "#1", and the HP
    // chart keys its series by label — one pool's line would overwrite the other.
    const red = entry("Em9001", 1);
    const blue = entry("Em9002", 1);

    const labels = buildTargetLabels([red, blue], NAME);

    expect(labelOf(labels, red)).toBe("Goblin #1");
    expect(labelOf(labels, blue)).toBe("Goblin #2");
  });

  it("keys unknown types by hash rather than by their rendered name", () => {
    const one = entry({ Unknown: 0x11 }, 1);
    const two = entry({ Unknown: 0x22 }, 1);

    const labels = buildTargetLabels([one, two], NAME);

    expect(labelOf(labels, one)).toBe("Unknown 0x11");
    expect(labelOf(labels, two)).toBe("Unknown 0x22");
  });

  it("adds the pool size when one name spans different pools", () => {
    // Lucilius' swords: same name, 141m and 49m pools.
    const big = entry("Em5000", 1, 141_000_000);
    const small = entry("Em5000", 2, 49_000_000);

    const labels = buildTargetLabels([big, small], NAME);

    expect(labelOf(labels, big)).toBe("Em5000 #1 (141.0m)");
    expect(labelOf(labels, small)).toBe("Em5000 #2 (49.0m)");
  });

  it("omits the pool size when every spawn of the name shares one", () => {
    const first = entry("Em0100", 1, 5000);
    const second = entry("Em0100", 2, 5000);

    const labels = buildTargetLabels([first, second], NAME);

    expect(labelOf(labels, first)).toBe("Em0100 #1");
  });

  it("tolerates an unknown pool size", () => {
    const known = entry("Em0100", 1, 5000);
    const unknown = entry("Em0100", 2, null);

    const labels = buildTargetLabels([known, unknown], NAME);

    expect(labelOf(labels, unknown)).toBe("Em0100 #2");
  });
});
