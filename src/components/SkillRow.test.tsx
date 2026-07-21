import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { ComputedSkillState } from "@/types";
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
  cappedHits: 0,
  cappableHits: 0,
  overcapBaseSum: 0,
  overcapCapSum: 0,
  targets: [],
  percentage: 0,
  ...overrides,
});

const renderRow = (skill: ComputedSkillState) =>
  render(
    <MantineProvider>
      <table>
        <tbody>
          <SkillRow characterType="Pl0000" skill={skill} color="#ff0000" live />
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
    // total, min, max, avg, stun, cap%, %
    for (let i = 2; i <= 8; i++) {
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
    expect(cells[6].textContent).toBe("927");
    expect(cells[8].textContent).toBe("0%");
  });
});
