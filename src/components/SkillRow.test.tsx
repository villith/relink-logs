import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { ComputedSkillState, DEFAULT_SKILL_COLUMNS, SkillColumns } from "@/types";
import { SkillRow } from "./SkillRow";

const makeSkill = (overrides: Partial<ComputedSkillState>): ComputedSkillState => ({
  actionType: "PerfectGuard",
  childCharacterType: "Pl0000",
  hits: 0,
  minDamage: null,
  maxDamage: null,
  totalDamage: 0,
  totalStunValue: 0,
  maxStunValue: 0,
  stunEligibleHits: 0,
  cappedHits: 0,
  cappableHits: 0,
  overcapBaseSum: 0,
  overcapCapSum: 0,
  targets: [],
  percentage: 0,
  ...overrides,
});

const renderRow = (skill: ComputedSkillState, columns: SkillColumns[] = DEFAULT_SKILL_COLUMNS) =>
  render(
    <MantineProvider>
      <table>
        <tbody>
          <SkillRow characterType="Pl0000" skill={skill} color="#ff0000" columns={columns} live />
        </tbody>
      </table>
    </MantineProvider>
  );

describe("SkillRow", () => {
  beforeAll(async () => {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            skills: {
              default: {
                "perfect-guard": "Perfect Guard",
                "perfect-guard-quickening": "Perfect Guard (Quickening)",
              },
            },
          },
        },
      },
    });
  });

  /** The Quickening row tracks only that the guard happened: hits render, and
   * every value column (total, min, max, avg, stun, cap%, %) shows a dash. */
  it("renders a Perfect Guard (Quickening) row as hits plus dashes", () => {
    const { container } = renderRow(makeSkill({ actionType: "PerfectGuardQuickening", hits: 1 }));

    const cells = container.querySelectorAll("td");
    expect(cells[0].textContent).toBe("Perfect Guard (Quickening)");
    expect(cells[1].textContent).toBe("1");
    // total, min, max, avg, stun, stun-hits, stun/hit, cap%, %
    for (let i = 2; i <= 10; i++) {
      expect(cells[i].textContent).toBe("-");
    }
  });

  /** Regression: the generic Perfect Guard row keeps its normal rendering
   * (hits + stun value, zero total damage). */
  it("keeps normal value rendering for other rows", () => {
    const { container } = renderRow(makeSkill({ actionType: "PerfectGuard", hits: 2, totalStunValue: 927 }));

    const cells = container.querySelectorAll("td");
    expect(cells[0].textContent).toBe("Perfect Guard");
    expect(cells[1].textContent).toBe("2");
    expect(cells[2].textContent).toBe("0");
    expect(cells[6].textContent).toBe("927"); // total stun value
    expect(cells[7].textContent).toBe(""); // stun hits: none stunned (stunEligibleHits 0)
    expect(cells[8].textContent).toBe(""); // stun/hit: blank with no eligible hits
    expect(cells[10].textContent).toBe("0%"); // damage %
  });

  /** The opt-in stun-hit columns: the count of stunning hits, and the average
   * stun per stunning hit (totalStunValue / stunEligibleHits). */
  it("renders the stun-hit count and stun-per-hit average", () => {
    const { container } = renderRow(
      makeSkill({ actionType: "PerfectGuard", hits: 10, totalStunValue: 200, stunEligibleHits: 8 }),
      [SkillColumns.StunEligibleHits, SkillColumns.StunPerEligibleHit]
    );

    const cells = container.querySelectorAll("td");
    expect(cells[0].textContent).toBe("Perfect Guard");
    expect(cells[1].textContent).toBe("8"); // stun hits
    expect(cells[2].textContent).toBe("25"); // 200 / 8 = 25 stun per hit
  });

  /** A skill that never stunned (all hits hit a stunned/immune target) leaves
   * both stun columns blank rather than showing a misleading 0. */
  it("leaves the stun-hit columns blank when nothing stunned", () => {
    const { container } = renderRow(
      makeSkill({ actionType: "PerfectGuard", hits: 10, totalStunValue: 0, stunEligibleHits: 0 }),
      [SkillColumns.StunEligibleHits, SkillColumns.StunPerEligibleHit]
    );

    const cells = container.querySelectorAll("td");
    expect(cells[1].textContent).toBe("");
    expect(cells[2].textContent).toBe("");
  });
});
