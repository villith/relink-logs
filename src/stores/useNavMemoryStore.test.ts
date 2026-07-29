import { beforeEach, describe, expect, it } from "vitest";

import { NAV_TAB_ROOTS, tabKeyForPath, targetFor, useNavMemoryStore } from "./useNavMemoryStore";

describe("tabKeyForPath", () => {
  it("files the list, a quest detail, and the conflux pages under the Logs tab", () => {
    for (const pathname of ["/logs", "/logs/123", "/logs/conflux", "/logs/conflux/run/5"]) {
      expect(tabKeyForPath(pathname), pathname).toBe("logs");
    }
  });

  it("files each of the other sections under its own tab", () => {
    expect(tabKeyForPath("/logs/toolbox/overmastery")).toBe("toolbox");
    expect(tabKeyForPath("/logs/settings/checklist")).toBe("settings");
    expect(tabKeyForPath("/logs/debug")).toBe("debug");
  });
});

describe("targetFor", () => {
  it("sends an inactive tab back to where it was last, search string included", () => {
    const locations = { logs: "/logs/123?tab=builds" };
    expect(targetFor(locations, "logs", "settings")).toBe("/logs/123?tab=builds");
  });

  it("sends a tab to its root when nothing has been visited under it yet", () => {
    expect(targetFor({}, "toolbox", "logs")).toBe(NAV_TAB_ROOTS.toolbox);
  });

  it("sends the active tab to its root so re-clicking it starts over", () => {
    const locations = { logs: "/logs/123" };
    expect(targetFor(locations, "logs", "logs")).toBe(NAV_TAB_ROOTS.logs);
  });
});

describe("useNavMemoryStore", () => {
  beforeEach(() => useNavMemoryStore.setState({ locations: {} }));

  it("remembers the last location visited under each tab", () => {
    const { remember } = useNavMemoryStore.getState();
    remember("/logs/123", "?tab=equipment");
    remember("/logs/settings/checklist", "");

    expect(useNavMemoryStore.getState().locations).toEqual({
      logs: "/logs/123?tab=equipment",
      settings: "/logs/settings/checklist",
    });
  });

  it("keeps only the latest location per tab", () => {
    const { remember } = useNavMemoryStore.getState();
    remember("/logs/123", "");
    remember("/logs", "");

    expect(useNavMemoryStore.getState().locations.logs).toBe("/logs");
  });
});
