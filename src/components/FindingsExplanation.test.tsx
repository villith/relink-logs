import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { LegalityFinding } from "@/types";
import ui from "../../src-tauri/lang/en/ui.json";

import { FindingDetail } from "./FindingDetail";
import { FindingsExplanation } from "./LegalityMark";

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * The tooltips and the Cheat Audit page are supposed to explain a finding the
 * same way, and for a long time they did not: the audit page drew the gear with
 * its offending line marked, while the tooltip printed a rule label, a subject
 * and a sentence — no gear at all. They shared one function (`describeLimit`)
 * and nothing else, so the same accusation reached a reader in two shapes that
 * did not look like the same claim.
 *
 * Comparing the rendered text is the only assertion that actually catches that.
 * Sharing a component is easy to claim and easy to quietly undo.
 */
const summonFinding: LegalityFinding = {
  rule: "summonBonusSource",
  subject: { kind: "summon", index: 1 },
  observed: { kind: "summonBonusId", value: 0x2ea9ca80 },
  allowed: { kind: "summonIds", value: [1, 2] },
  odds: null,
  evidence: {
    kind: "summon",
    summonId: 0xe4b7dcf9,
    main: { id: 0xa1a8e39d, level: 15 },
    bonus: { id: 0x2ea9ca80, level: 9 },
  },
};

/** The rendered words, reading around Mantine's injected stylesheet — it lands
 * in `textContent` and would otherwise dominate every comparison here. Read
 * around rather than removed: the node is React's, and deleting it from under
 * the reconciler throws on the next render. */
const text = (node: React.ReactElement): string => {
  const { container } = render(<MantineProvider>{node}</MantineProvider>);
  return Array.from(container.children)
    .filter((child) => child.tagName !== "STYLE")
    .map((child) => child.textContent ?? "")
    .join("");
};

describe("FindingsExplanation", () => {
  beforeAll(async () => {
    await i18next.use(initReactI18next).init({ lng: "en", resources: { en: { translation: ui } } });
  });

  it("says exactly what the Cheat Audit page says about the same finding", () => {
    expect(text(<FindingsExplanation findings={[summonFinding]} />)).toBe(
      text(<FindingDetail finding={summonFinding} />)
    );
  });

  /** And it is not vacuous: the block really does carry the gear and the claim,
   * so an empty render could not pass the comparison above. */
  it("carries the gear and the limit, not just a heading", () => {
    const rendered = text(<FindingsExplanation findings={[summonFinding]} />);

    expect(rendered).toContain("wrong bonus id");
    expect(rendered).toContain("Lvl. 15");
  });

  /** A tooltip covering a whole build stacks one block per finding, so a reader
   * gets the same evidence for each that the audit page gives. */
  it("renders one block per finding", () => {
    const two = text(<FindingsExplanation findings={[summonFinding, summonFinding]} />);

    expect(two).toBe(text(<FindingDetail finding={summonFinding} />).repeat(2));
  });
});
