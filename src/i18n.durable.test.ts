import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<[string, unknown?], Promise<unknown>>(() => Promise.resolve());
const registered: Record<string, (value: string | null) => void> = {};

vi.mock("@tauri-apps/api", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@/stores/durableStorage", () => ({
  durableStorage: {
    getItem: () => null,
    setItem: (key: string, value: string) => invokeMock("set_setting", { key, value }),
    removeItem: () => {},
  },
  registerDurableKey: (key: string, handler: (value: string | null) => void) => {
    registered[key] = handler;
  },
}));

const { mirrorLanguage, applyRemoteLanguage } = await import("./i18nDurable");

describe("language persistence", () => {
  it("mirrors a language change to the backend", () => {
    mirrorLanguage("jp");

    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "i18nextLng", value: "jp" });
  });

  it("applies a language that arrived from the backend", () => {
    const changeLanguage = vi.fn();
    (window as unknown as { i18n: unknown }).i18n = { language: "en", changeLanguage };

    applyRemoteLanguage("jp");

    expect(changeLanguage).toHaveBeenCalledWith("jp");
  });

  it("ignores a language it is already on", () => {
    const changeLanguage = vi.fn();
    (window as unknown as { i18n: unknown }).i18n = { language: "jp", changeLanguage };

    applyRemoteLanguage("jp");

    expect(changeLanguage).not.toHaveBeenCalled();
  });

  it("ignores a null value", () => {
    const changeLanguage = vi.fn();
    (window as unknown as { i18n: unknown }).i18n = { language: "en", changeLanguage };

    applyRemoteLanguage(null);

    expect(changeLanguage).not.toHaveBeenCalled();
  });
});
