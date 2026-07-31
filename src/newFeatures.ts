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
  settings: { from: "1.12.5", until: "1.12.6" },
  toolbox: { from: "1.10.0", until: "1.12.0" },
  "overmastery-predictor": { from: "1.10.0", until: "1.12.0" },
  "transmarvel-wishlist": { from: "1.12.4", until: "1.12.5" },
  "checklist-settings": { from: "1.12.5", until: "1.12.6" },
  "build-audit": { from: "1.12.5", until: "1.12.7" },
  // The switch that lets the audit's verdicts appear anywhere but the audit
  // page. Chipped alongside `build-audit` and for the same span: it ships off,
  // so without a chip the feature is only discoverable by someone who already
  // went looking for it.
  "flagged-builds-setting": { from: "1.12.5", until: "1.12.7" },
} as const satisfies Record<string, NewWindow>;

export type NewFeatureId = keyof typeof NEW_FEATURES;

/** Numeric release parts, dropping any prerelease/build suffix: every build
 * between stable releases is `X.Y.Z-N`, and `Number("4-5")` is NaN — which
 * would poison every comparison below and silently hide all chips on exactly
 * the builds that ship a new feature first. RC N of X.Y.Z reads as X.Y.Z. */
const releaseParts = (version: string): number[] =>
  version
    .split(/[-+]/)[0]
    .split(".")
    .map((part) => Number(part) || 0);

/** -1 / 0 / 1 numeric comparison of dotted version strings. */
export const compareVersions = (a: string, b: string): number => {
  const pa = releaseParts(a);
  const pb = releaseParts(b);
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

/**
 * Every feature a header tab stands for: the section itself (`ownId`) plus the
 * entries reachable inside it. A collapsed section's tab is the only "New"
 * marker visible before opening it, so a newly shipped entry has to light the
 * tab up too — the section's own window expires long before the entries added
 * later do. Pass the sections already filtered for the platform.
 */
export const sectionNewIds = (ownId: NewFeatureId, sections: { newId?: NewFeatureId }[]): NewFeatureId[] => [
  ownId,
  ...sections.flatMap(({ newId }) => (newId ? [newId] : [])),
];
