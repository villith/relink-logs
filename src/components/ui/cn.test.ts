import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("joins the classes it is given", () => {
    expect(cn("flex", "items-center")).toBe("flex items-center");
  });

  // The whole reason a caller passes an expression rather than a string: a
  // component's own state decides half of what it wears.
  it("drops the falsy branches of a conditional class", () => {
    expect(cn("flex", false && "hidden", null, undefined, "gap-2")).toBe("flex gap-2");
  });

  it("reads the object form clsx accepts", () => {
    expect(cn("flex", { "gap-2": true, hidden: false })).toBe("flex gap-2");
  });

  // The point of tailwind-merge over a plain join: a caller's override has to
  // WIN, not sit beside the default and lose to whichever the stylesheet
  // happened to order last.
  it("lets a later utility beat the one it conflicts with", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("keeps utilities that do not conflict", () => {
    expect(cn("text-ink-3", "font-semibold")).toBe("text-ink-3 font-semibold");
  });

  // These are the ones that matter here: the theme adds font sizes and spacing
  // steps that stock Tailwind has never heard of, and tailwind-merge only
  // dedupes scales it knows about. A `cn` that silently kept both halves of a
  // conflict would be a plain join wearing a merge's name.
  it("dedupes the theme's own font sizes against the stock ones", () => {
    expect(cn("text-label", "text-sm")).toBe("text-sm");
  });

  it("dedupes two of the theme's own font sizes", () => {
    expect(cn("text-md", "text-label")).toBe("text-label");
  });

  it("dedupes the theme's own spacing steps", () => {
    expect(cn("h-row", "h-8")).toBe("h-8");
    expect(cn("size-icon", "size-icon-xs")).toBe("size-icon-xs");
  });

  // A size and a colour are different properties and must both survive, even
  // though both are spelled `text-`.
  it("keeps a text colour alongside a text size", () => {
    expect(cn("text-sm", "text-ink-3")).toBe("text-sm text-ink-3");
    expect(cn("text-label", "text-accent")).toBe("text-label text-accent");
  });
});
