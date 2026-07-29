import { describe, expect, it } from "vitest";

import { familyKey, selectStale } from "./clean-target.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 29);

/** Build an entry the way the scanner would, `ageDays` days before NOW. */
const entry = (name, ageDays, { incremental = false } = {}) => ({
  name,
  path: `target/debug/x/${name}`,
  size: 1,
  mtimeMs: NOW - ageDays * DAY,
  family: familyKey(name, incremental),
});

const names = (entries) => entries.map((e) => e.name).sort();

describe("familyKey", () => {
  it("strips cargo's 16-hex metadata hash but keeps the extension", () => {
    expect(familyKey("gbfr_logs-83ea265c838ee276.pdb")).toBe("gbfr_logs.pdb");
    expect(familyKey("libgbfr_logs-83ea265c838ee276.rlib")).toBe("libgbfr_logs.rlib");
    expect(familyKey("gbfr_logs-83ea265c838ee276.d")).toBe("gbfr_logs.d");
  });

  it("groups by extension so a .pdb never displaces its .exe", () => {
    expect(familyKey("gbfr_logs-83ea265c838ee276.exe")).not.toBe(familyKey("gbfr_logs-83ea265c838ee276.pdb"));
  });

  it("handles hashed directories, which have no extension", () => {
    expect(familyKey("gbfr-logs-1234567890abcdef")).toBe("gbfr-logs");
  });

  it("reads rustc's base-36 incremental ids in incremental mode", () => {
    expect(familyKey("gbfr_logs-33hch5wqt4jxv", true)).toBe("gbfr_logs");
    expect(familyKey("build_script_build-0zlhgsm5hvm6a", true)).toBe("build_script_build");
  });

  it("returns null for anything without a hash, so it is never a deletion candidate", () => {
    expect(familyKey("hook.dll")).toBeNull();
    expect(familyKey("logs.db")).toBeNull();
    expect(familyKey("GBFR Logs.exe")).toBeNull();
    expect(familyKey("gbfr_logs-33hch5wqt4jxv")).toBeNull(); // base-36 id, non-incremental mode
  });
});

describe("selectStale", () => {
  it("keeps the newest `keep` generations of a family and drops the rest", () => {
    const entries = [
      entry("gbfr_logs-aaaaaaaaaaaaaaaa.pdb", 10),
      entry("gbfr_logs-bbbbbbbbbbbbbbbb.pdb", 20),
      entry("gbfr_logs-cccccccccccccccc.pdb", 30),
      entry("gbfr_logs-dddddddddddddddd.pdb", 40),
    ];
    expect(names(selectStale(entries, { keep: 2, minAgeMs: DAY, now: NOW }))).toEqual([
      "gbfr_logs-cccccccccccccccc.pdb",
      "gbfr_logs-dddddddddddddddd.pdb",
    ]);
  });

  it("never drops an entry younger than minAgeMs, even when it is outranked", () => {
    const entries = [
      entry("hook-aaaaaaaaaaaaaaaa.pdb", 0),
      entry("hook-bbbbbbbbbbbbbbbb.pdb", 0.1),
      entry("hook-cccccccccccccccc.pdb", 0.2),
      entry("hook-dddddddddddddddd.pdb", 0.3),
    ];
    expect(selectStale(entries, { keep: 1, minAgeMs: DAY, now: NOW })).toEqual([]);
  });

  it("ranks families independently", () => {
    const entries = [
      entry("gbfr_logs-aaaaaaaaaaaaaaaa.pdb", 10),
      entry("gbfr_logs-bbbbbbbbbbbbbbbb.pdb", 20),
      entry("hook-cccccccccccccccc.pdb", 10),
      entry("hook-dddddddddddddddd.pdb", 20),
    ];
    expect(names(selectStale(entries, { keep: 1, minAgeMs: DAY, now: NOW }))).toEqual([
      "gbfr_logs-bbbbbbbbbbbbbbbb.pdb",
      "hook-dddddddddddddddd.pdb",
    ]);
  });

  it("ignores unhashed entries entirely — hook.dll and logs.db must survive", () => {
    const entries = [entry("hook.dll", 400), entry("logs.db", 400), entry("gbfr_logs-aaaaaaaaaaaaaaaa.pdb", 400)];
    expect(names(selectStale(entries, { keep: 0, minAgeMs: DAY, now: NOW }))).toEqual([
      "gbfr_logs-aaaaaaaaaaaaaaaa.pdb",
    ]);
  });

  it("collapses the 400-generation incremental pile this repo actually accumulates", () => {
    const entries = Array.from({ length: 406 }, (_, i) =>
      entry(`gbfr_logs-${i.toString(36).padStart(13, "0")}`, i + 2, { incremental: true })
    );
    const stale = selectStale(entries, { keep: 3, minAgeMs: DAY, now: NOW });
    expect(stale).toHaveLength(403);
  });

  it("breaks mtime ties deterministically by name", () => {
    const entries = [entry("a_crate-bbbbbbbbbbbbbbbb.rlib", 10), entry("a_crate-aaaaaaaaaaaaaaaa.rlib", 10)];
    expect(names(selectStale(entries, { keep: 1, minAgeMs: DAY, now: NOW }))).toEqual([
      "a_crate-bbbbbbbbbbbbbbbb.rlib",
    ]);
  });
});
