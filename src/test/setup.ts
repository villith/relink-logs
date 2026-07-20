import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Explicit even though vitest's `globals: true` config restores
// testing-library's auto-cleanup — keeps behavior independent of it.
afterEach(cleanup);

// jsdom is missing these browser APIs; Mantine's components probe them.
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
