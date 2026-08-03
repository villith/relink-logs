import { describe, expect, it } from "vitest";

import { labelSourceOptions, legendLabelFor } from "./legendLabel";

describe("legendLabelFor", () => {
  it("appends the character so two AI players are not colour-only", () => {
    // The table gives every row a rank and a name, but the legend has neither —
    // two entries both reading "AI" are separable by colour alone, and the
    // closest pair collapses to CIE76 dE 6.7 under simulated deuteranopia.
    expect(legendLabelFor("AI", "Siegfried", "{name}")).toBe("AI (Siegfried)");
  });

  it("leaves a template that already names the character alone", () => {
    expect(legendLabelFor("[2] AI (Siegfried)", "Siegfried", "[{slot}] {name} ({character})")).toBe(
      "[2] AI (Siegfried)"
    );
  });

  it("falls back to the character alone when the label is empty", () => {
    expect(legendLabelFor("", "Eugen", "{name}")).toBe("Eugen");
  });

  it("keeps the label unchanged when the character is unknown", () => {
    expect(legendLabelFor("Rain", "", "{name}")).toBe("Rain");
  });

  it("does not repeat a character the label already ends with", () => {
    // A custom template like "{character}" already says it.
    expect(legendLabelFor("Siegfried", "Siegfried", "{character}")).toBe("Siegfried");
  });
});

describe("labelSourceOptions", () => {
  const CHARACTERS: Record<string, string> = { "0": "Rackam", "2": "Siegfried", "3": "Eugen" };
  const label = (index: number) => (index === 0 ? "Player" : "AI");
  const character = (index: number) => CHARACTERS[String(index)] ?? "";

  it("tells two same-named players apart by character", () => {
    // The reported case: a template that omits the character renders both AI
    // players as the string "AI", and the dropdown carries no rank or colour to
    // separate them by.
    const labelled = labelSourceOptions([{ value: "2" }, { value: "3" }], label, character, "{name}");

    expect(labelled).toEqual([
      { value: "2", label: "AI (Siegfried)" },
      { value: "3", label: "AI (Eugen)" },
    ]);
  });

  it("leaves a template that already names the character alone", () => {
    const labelled = labelSourceOptions([{ value: "2" }], () => "AI (Siegfried)", character, "{name} ({character})");

    expect(labelled[0].label).toBe("AI (Siegfried)");
  });

  it("keeps a non-numeric value's label rather than mislabelling it", () => {
    // Sources are actor indexes, so this should not happen — but a bad value
    // must not silently resolve to whatever character index NaN lands on.
    const labelled = labelSourceOptions([{ value: "nonsense" }], () => "?", character, "{name}");

    expect(labelled[0]).toEqual({ value: "nonsense", label: "?" });
  });
});
