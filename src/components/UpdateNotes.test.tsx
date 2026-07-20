import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/shell", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/api/shell";

import UpdateNotes from "./UpdateNotes";

/** react-markdown is lazy-loaded, so the first paint is the Suspense
 * fallback — wait for the chunk to resolve before asserting. */
const renderNotes = async (markdown: string) => {
  const result = render(
    <MantineProvider>
      <UpdateNotes markdown={markdown} />
    </MantineProvider>
  );
  await waitFor(() => expect(result.container.querySelector("p, ul, h2")).toBeTruthy());
  return result;
};

describe("UpdateNotes", () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
  });

  it("renders dash bullets as list items", async () => {
    const { container } = await renderNotes("- First note\n- Second note");
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe("First note");
    expect(items[1].textContent).toBe("Second note");
  });

  it("renders headings and plain paragraphs", async () => {
    const { container } = await renderNotes("## What changed\nJust text.");
    expect(screen.getByText("What changed")).toBeTruthy();
    expect(screen.getByText("Just text.")).toBeTruthy();
    expect(container.querySelectorAll("li").length).toBe(0);
  });

  it("renders **bold** spans inside a line", async () => {
    const { container } = await renderNotes("- adds **big** damage");
    const bold = container.querySelector("li strong, li b");
    expect(bold?.textContent).toBe("big");
    expect(container.querySelector("li")?.textContent).toBe("adds big damage");
  });

  it("opens links in the system browser instead of navigating the webview", async () => {
    await renderNotes("- see [the docs](https://example.com/notes)");
    const link = screen.getByText("the docs");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://example.com/notes");
  });

  it("skips blank lines without producing empty elements", async () => {
    const { container } = await renderNotes("- one\n\n- two\n");
    expect(container.querySelectorAll("li").length).toBe(2);
  });
});
