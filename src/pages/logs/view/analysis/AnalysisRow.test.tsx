import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnalysisRow } from "./AnalysisRow";

const renderRow = (over = {}) =>
  render(
    <MantineProvider>
      <AnalysisRow name="Rage III" {...over} />
    </MantineProvider>
  );

describe("AnalysisRow", () => {
  it("renders the name", () => {
    renderRow();
    expect(screen.getByText("Rage III")).toBeTruthy();
  });

  // role="row" is the stable contract the table and the timeline both rely on
  // to find the row shell — it carries the table's height, padding and hover.
  it("wears the row class", () => {
    const { container } = renderRow();
    expect(container.querySelector("[role='row']")).toBeTruthy();
  });

  it("renders leading and trailing slots around the name", () => {
    const { container } = renderRow({
      leading: <span data-testid="lead" />,
      trailing: <span data-testid="trail" />,
    });
    expect(container.querySelector("[data-testid='lead']")).toBeTruthy();
    expect(container.querySelector("[data-testid='trail']")).toBeTruthy();
  });

  // Never a <button>, however clickable. The row carries real <button>s inside
  // it — the band toggle and the expand caret — and a button may not contain
  // interactive content: the row used to be an UnstyledButton and the two
  // fought over focus and clicks. Focus and Enter/Space are done by hand
  // instead, which is what the element was giving for free.
  it("is a row, not a button, even when it can be clicked", () => {
    const { container } = renderRow({ onClick: () => {} });
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[role='row']")).toBeTruthy();
  });

  // A row that pins takes focus; one that does not must not, or every inert
  // lane becomes a tab stop that answers to Enter with nothing.
  it("takes focus and activates only when it can be clicked", () => {
    const onClick = vi.fn();
    const { container: clickable } = renderRow({ onClick });
    const row = clickable.querySelector("[role='row']")!;
    expect(row.getAttribute("tabindex")).toBe("0");

    fireEvent.click(screen.getByText("Rage III"));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(row, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(3);

    const { container: inert } = renderRow();
    expect(inert.querySelector("[role='row']")!.getAttribute("tabindex")).toBeNull();
  });

  // Pinnable is the same discriminator as focusability: a clickable row is a
  // tab stop (asserted above) and shows the pointer cursor; an inert one is
  // neither. The class that used to carry the pointer cursor is gone, so the
  // tab stop is what's left to assert here.
  it("marks a pinnable row so it takes the pointer cursor", () => {
    const { container } = renderRow({ onClick: () => {} });
    const row = container.querySelector("[role='row']")!;
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("fixes the name cell only when asked", () => {
    const { container: fixed } = renderRow({ nameFixed: true });
    const fixedClasses = fixed.querySelector("[role='gridcell']")!.className.split(" ");
    expect(fixedClasses).toContain("basis-name");
    expect(fixedClasses).not.toContain("flex-1");

    const { container: fluid } = renderRow();
    const fluidClasses = fluid.querySelector("[role='gridcell']")!.className.split(" ");
    expect(fluidClasses).toContain("flex-1");
    expect(fluidClasses).not.toContain("basis-name");
  });

  // CursorCard clones the row element to attach its own hover handlers, so a
  // row that swallowed them would leave the table's hover card unopenable.
  it("forwards the hover handlers a cloning card attaches", () => {
    const onMouseEnter = vi.fn();
    const { container } = renderRow({ onMouseEnter });
    fireEvent.mouseOver(container.querySelector("[role='row']")!);
    expect(onMouseEnter).toHaveBeenCalled();
  });
});
