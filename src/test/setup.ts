import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The real module resolves the bundled JSON through Tauri's resource API at
// IMPORT time, so anything that transitively reaches it throws under jsdom.
// Mocked globally with the actual shipped table rather than a stub, so tests
// exercise the grouping the app really uses; a test wanting a fixed table still
// overrides this with its own `vi.mock`.
// Resolved by Vite against THIS file, not against `process.cwd()`, so the suite
// does not depend on vitest being launched from the repo root.
vi.mock("@/assets/skill-groups", async () => ({
  default: (await import("../../src-tauri/assets/skill-groups.json")).default,
}));

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
