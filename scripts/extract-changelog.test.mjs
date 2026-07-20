import { describe, expect, it } from "vitest";

import { extractSection } from "./extract-changelog.mjs";

const CHANGELOG = `# Changelog

Intro text that is not part of any release.

## 1.10.0

- New Toolbox tool
- Bug fix

## 1.9.6 (2026-07-15)

- Older note

## 1.9.5

- Oldest note
`;

describe("extractSection", () => {
  it("returns the body of the requested version's section", () => {
    expect(extractSection(CHANGELOG, "1.10.0")).toBe("- New Toolbox tool\n- Bug fix");
  });

  it("stops at the next section heading", () => {
    expect(extractSection(CHANGELOG, "1.9.6")).toBe("- Older note");
  });

  it("reads the last section to end of file", () => {
    expect(extractSection(CHANGELOG, "1.9.5")).toBe("- Oldest note");
  });

  it("returns null for a version with no section", () => {
    expect(extractSection(CHANGELOG, "1.11.0")).toBeNull();
  });

  it("does not match a version that is a prefix of another", () => {
    expect(extractSection(CHANGELOG, "1.9")).toBeNull();
    expect(extractSection(CHANGELOG, "1.10.0.1")).toBeNull();
  });

  it("does not let a prerelease heading stand in for the release", () => {
    const withRc = "## 1.10.0-rc.1\n\n- Prerelease only\n\n## 1.10.0\n\n- Real notes\n";
    expect(extractSection(withRc, "1.10.0")).toBe("- Real notes");
  });

  it("escapes regex metacharacters in the version", () => {
    expect(extractSection("## 1.2.0+1\n\n- Build note\n", "1.2.0+1")).toBe("- Build note");
  });
});
