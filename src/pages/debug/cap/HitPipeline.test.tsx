import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExplainHit } from "@/pages/logs/view/events/capExplain";

// Keys pass through verbatim; interpolation params are appended so the bar
// label's numbers stay assertable.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key} ${Object.values(params).join(" ")}`,
    i18n: { language: "en" },
  }),
}));

import { HitPipeline } from "./HitPipeline";

const capped: ExplainHit = {
  damage: 183_284,
  damage_cap: 152_737,
  base_damage: 400_000,
  attack_rate: 0.54,
  class_flags: 0x1,
  flags: 0,
  instance_snapshot: null,
  record_snapshot: null,
};

const renderIt = (hit: ExplainHit) =>
  render(
    <MantineProvider>
      <HitPipeline hit={hit} />
    </MantineProvider>
  );

describe("HitPipeline", () => {
  it("shows the four stages in computation order", () => {
    renderIt(capped);
    expect(screen.getByTestId("cap-pipe-precap").textContent).toContain("400,000");
    expect(screen.getByTestId("cap-pipe-cap").textContent).toContain("152,737");
    // The multiplier divides by the clamp bound, not the raw precap:
    // 183,284 / 152,737 = 1.200.
    expect(screen.getByTestId("cap-pipe-postcap").textContent).toContain("x1.200");
    expect(screen.getByTestId("cap-pipe-final").textContent).toContain("183,284");
  });

  it("draws the clamp: fill to the cap, overrun past it, cap line between", () => {
    renderIt(capped);
    // Shared scale is max(precap, cap) = 400,000.
    expect(screen.getByTestId("cap-pipe-fill").style.width).toBe("38.18%");
    expect(screen.getByTestId("cap-pipe-overfill").style.width).toBe("61.82%");
    expect(screen.getByTestId("cap-pipe-capline").style.left).toContain("38.18%");
    expect(screen.getByTestId("cap-pipe-verdict").textContent).toBe("ui.debug.cap-pipe-capped");
    // x2.62 over cap: 400,000 / 152,737.
    expect(screen.getByTestId("cap-pipe-bar-label").textContent).toContain("2.62");
  });

  // Bug: this verdict used `precap >= cap`, contradicting the Rust authority
  // (`cap_detection::is_capped`), which is strict `>` — a hit exactly at cap
  // is not over it.
  it("reports uncapped when the pre-cap base sits exactly at the cap", () => {
    renderIt({ ...capped, base_damage: 152_737 }); // damage_cap is 152_737 too
    expect(screen.getByTestId("cap-pipe-verdict").textContent).toBe("ui.debug.cap-pipe-uncapped");
  });

  it("shows headroom instead of overrun for an uncapped hit", () => {
    renderIt({ ...capped, base_damage: 100_000, damage_cap: 200_000, damage: 100_000 });
    expect(screen.getByTestId("cap-pipe-fill").style.width).toBe("50.00%");
    expect(screen.queryByTestId("cap-pipe-overfill")).toBeNull();
    expect(screen.getByTestId("cap-pipe-verdict").textContent).toBe("ui.debug.cap-pipe-uncapped");
    expect(screen.getByTestId("cap-pipe-bar-label").textContent).toContain("50");
  });

  it("says 'no cap data' rather than guessing when the fields are missing", () => {
    renderIt({ ...capped, base_damage: null, damage_cap: null });
    expect(screen.getByTestId("cap-pipe-precap").textContent).toContain("—");
    expect(screen.getByTestId("cap-pipe-verdict").textContent).toBe("ui.debug.cap-pipe-unknown");
    // No bar: there is nothing truthful to draw it from.
    expect(screen.queryByTestId("cap-pipe-bar")).toBeNull();
  });

  it("serves each stage's provenance on hover", () => {
    renderIt(capped);
    fireEvent.mouseEnter(screen.getByTestId("cap-pipe-precap"), { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("cap-pipe-precap-card").textContent).toContain("ui.debug.cap-pipe-src-precap");
  });
});
