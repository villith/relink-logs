import { MantineProvider } from "@mantine/core";
import { Flask } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));

import NavRailLayout from "./NavRailLayout";

const STORAGE_KEY = "test-menu-collapsed";

/**
 * The rail's markup as it is on the very first render, before any effect runs.
 *
 * `renderToStaticMarkup` is the only way to see that: testing-library's
 * `render` flushes passive effects before it returns, which is exactly the
 * frame the flash lives in. This is not a claim that the app server-renders —
 * it does not.
 */
const firstRender = () =>
  renderToStaticMarkup(
    <MantineProvider>
      <MemoryRouter initialEntries={["/tools/a"]}>
        <NavRailLayout
          sections={[{ to: "/tools/a", labelKey: "ui.a", labelFallback: "Tool A", icon: Flask }]}
          storageKey={STORAGE_KEY}
        />
      </MemoryRouter>
    </MantineProvider>
  );

/** The rail's own inline style, which carries the width — the whole of what the
 * flash looked like. Mantine turns the numeric `w` prop into rem, so 56 reads
 * as 3.5rem and 300 as 18.75rem.
 *
 * Read as the raw attribute rather than through `.style.width`: jsdom's CSSOM
 * drops any value it cannot parse, and Mantine's width is a `calc()` over a CSS
 * variable. Selector matched unspaced, which is how React serializes it. */
const railStyle = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("div[style*='position:sticky']")?.getAttribute("style") ?? "";
};

const COLLAPSED = "3.5rem";
const EXPANDED = "18.75rem";

describe("NavRailLayout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // The rail is remounted on every switch between the Toolbox and Settings
  // pages, so a first render that ignores the stored flag means watching it
  // snap shut each time.
  it("renders collapsed on the first render when storage says collapsed", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const html = firstRender();
    expect(railStyle(html)).toContain(COLLAPSED);
    expect(html).toContain("Expand menu");
  });

  it("renders expanded on the first render when storage says expanded", () => {
    localStorage.setItem(STORAGE_KEY, "false");
    const html = firstRender();
    expect(railStyle(html)).toContain(EXPANDED);
    expect(html).toContain("Collapse menu");
  });

  it("defaults to expanded with nothing stored", () => {
    expect(railStyle(firstRender())).toContain(EXPANDED);
  });
});
