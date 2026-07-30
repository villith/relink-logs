import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TokenField } from "./TokenField";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const TOKENS = ["app", "version"];

const renderField = (ui: ReactElement) => render(<MantineProvider>{ui}</MantineProvider>);

describe("TokenField", () => {
  it("renders each token as a chip and the rest as text", () => {
    const { container } = renderField(
      <TokenField label="Format" value="{app} v{version}" tokens={TOKENS} onChange={() => {}} />
    );
    const chips = [...container.querySelectorAll("[data-token]")];
    expect(chips.map((chip) => chip.getAttribute("data-token"))).toEqual(["app", "version"]);
  });

  it("marks a token outside the whitelist as unknown", () => {
    const { container } = renderField(
      <TokenField label="Format" value="{bogus}" tokens={TOKENS} onChange={() => {}} />
    );
    expect(container.querySelector("[data-token]")?.getAttribute("data-unknown")).toBe("true");
  });

  it("round-trips the template it was given", () => {
    const onChange = vi.fn();
    renderField(<TokenField label="Format" value="HP {app} ok" tokens={TOKENS} onChange={onChange} />);
    // Minus the chips' remove buttons, which are controls rather than content.
    // The authoritative round-trip is editor.getText(), covered in TokenNode.test.ts.
    const visible = screen.getByRole("textbox").cloneNode(true) as HTMLElement;
    visible.querySelectorAll(".token-chip-remove").forEach((button) => button.remove());
    expect(visible.textContent).toBe("HP {app} ok");
  });

  it("gives every chip a remove button", () => {
    const { container } = renderField(
      <TokenField label="Format" value="{app} v{version}" tokens={TOKENS} onChange={() => {}} />
    );
    expect(container.querySelectorAll(".token-chip .token-chip-remove")).toHaveLength(2);
  });
});
