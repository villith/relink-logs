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

  // The class is the point of the extraction: it carries the table's height,
  // padding and hover, which is what the timeline's lanes were missing.
  it("wears the row class", () => {
    const { container } = renderRow();
    expect(container.querySelector(".analysis-row")).toBeTruthy();
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
    const row = clickable.querySelector(".analysis-row")!;
    expect(row.getAttribute("tabindex")).toBe("0");

    fireEvent.click(screen.getByText("Rage III"));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(row, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(3);

    const { container: inert } = renderRow();
    expect(inert.querySelector(".analysis-row")!.getAttribute("tabindex")).toBeNull();
  });

  it("marks a pinnable row so it takes the pointer cursor", () => {
    const { container } = renderRow({ onClick: () => {} });
    expect(container.querySelector(".analysis-row-pinnable")).toBeTruthy();
  });

  it("fixes the name cell only when asked", () => {
    const { container: fixed } = renderRow({ nameFixed: true });
    expect(fixed.querySelector(".analysis-name-fixed")).toBeTruthy();
    const { container: fluid } = renderRow();
    expect(fluid.querySelector(".analysis-name-fixed")).toBeNull();
  });

  // CursorCard clones the row element to attach its own hover handlers, so a
  // row that swallowed them would leave the table's hover card unopenable.
  it("forwards the hover handlers a cloning card attaches", () => {
    const onMouseEnter = vi.fn();
    const { container } = renderRow({ onMouseEnter });
    fireEvent.mouseOver(container.querySelector(".analysis-row")!);
    expect(onMouseEnter).toHaveBeenCalled();
  });
});
