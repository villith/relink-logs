import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoverCardBody } from "./HoverCard";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const BREAKDOWN = {
  title: "Narmaya",
  subtitle: "41.2k · 218 hits",
  byAbility: [
    { key: "Normal:100", label: "Genji Just Attack", value: 29700 },
    { key: "Normal:200", label: "Dawnfly", value: 6900 },
  ],
  byTarget: [{ key: "9", label: "Lucilius", value: 33400 }],
};

const renderBody = (props = {}) =>
  render(
    <MantineProvider>
      <HoverCardBody {...BREAKDOWN} {...props} />
    </MantineProvider>
  );

describe("HoverCardBody", () => {
  it("shows both halves at once", () => {
    renderBody();
    expect(screen.getByText("ui.logs.hover-by-ability")).toBeTruthy();
    expect(screen.getByText("ui.logs.hover-by-target")).toBeTruthy();
  });

  it("lists entries in each half", () => {
    renderBody();
    expect(screen.getByText("Genji Just Attack")).toBeTruthy();
    expect(screen.getByText("Lucilius")).toBeTruthy();
  });

  it("omits a half that has no entries", () => {
    // Live meters carry no target breakdown; an empty heading would read as
    // missing data rather than an absent dimension.
    renderBody({ byTarget: [] });
    expect(screen.queryByText("ui.logs.hover-by-target")).toBeNull();
    expect(screen.getByText("ui.logs.hover-by-ability")).toBeTruthy();
  });
});
