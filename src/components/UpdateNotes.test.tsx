import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/shell", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/api/shell";

import UpdateNotes from "./UpdateNotes";

// Explicit even though vitest's `globals: true` config restores
// testing-library's auto-cleanup — keeps this file safe on its own.
afterEach(cleanup);

// jsdom is missing these browser APIs; Mantine's components probe them.
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);

  window.ResizeObserver =
    window.ResizeObserver ||
    class implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

const renderNotes = (markdown: string) =>
  render(
    <MantineProvider>
      <UpdateNotes markdown={markdown} />
    </MantineProvider>
  );

describe("UpdateNotes", () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
  });

  it("renders dash bullets as list items", () => {
    const { container } = renderNotes("- First note\n- Second note");
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe("First note");
    expect(items[1].textContent).toBe("Second note");
  });

  it("renders headings and plain paragraphs", () => {
    const { container } = renderNotes("## What changed\nJust text.");
    expect(screen.getByText("What changed")).toBeTruthy();
    expect(screen.getByText("Just text.")).toBeTruthy();
    expect(container.querySelectorAll("li").length).toBe(0);
  });

  it("renders **bold** spans inside a line", () => {
    const { container } = renderNotes("- adds **big** damage");
    const bold = container.querySelector("li strong, li b");
    expect(bold?.textContent).toBe("big");
    expect(container.querySelector("li")?.textContent).toBe("adds big damage");
  });

  it("opens links in the system browser instead of navigating the webview", () => {
    renderNotes("- see [the docs](https://example.com/notes)");
    const link = screen.getByText("the docs");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://example.com/notes");
  });

  it("skips blank lines without producing empty elements", () => {
    const { container } = renderNotes("- one\n\n- two\n");
    expect(container.querySelectorAll("li").length).toBe(2);
  });
});
