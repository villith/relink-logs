import { version as APP_VERSION } from "../package.json";

/** When a feature's chip shows: between `from` and `until` (inclusive,
 * either side optional). */
export type NewWindow = { from?: string; until?: string };

/**
 * Features flagged with a "New" chip in the UI, mapped to the release window
 * that should show it. Entries can be staged before a release and expire
 * automatically once the app version leaves the window. When shipping a
 * feature worth calling out, add an entry here; when pruning one, delete its
 * chip usages too (ids are typed, so the compiler points at them).
 */
export const NEW_FEATURES = {
  toolbox: { from: "1.10.0", until: "1.10.2" },
  "overmastery-predictor": { from: "1.10.0", until: "1.10.2" },
} as const satisfies Record<string, NewWindow>;

export type NewFeatureId = keyof typeof NEW_FEATURES;

/** -1 / 0 / 1 numeric comparison of dotted version strings. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
};

/** True while `appVersion` is inside the feature's "new" window. */
export const isNewVersion = ({ from, until }: NewWindow, appVersion: string): boolean => {
  if (from !== undefined && compareVersions(appVersion, from) < 0) return false;
  return until === undefined || compareVersions(appVersion, until) <= 0;
};

/** True when the feature `id` should wear its "New" chip in this build. */
export const isNew = (id: NewFeatureId): boolean => isNewVersion(NEW_FEATURES[id], APP_VERSION);
