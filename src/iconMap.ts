/**
 * Turns an `import.meta.glob` result into a filename → URL lookup.
 *
 * Every icon family in the app resolves the same way — the assets are named by
 * the game's own key, so the lookup is a straight basename match. The `glob`
 * call itself has to stay literal at each call site (Vite rewrites it at build
 * time and cannot see through a helper), but the map it feeds is identical
 * everywhere, so it lives here rather than being spelled out five times.
 */
export const iconsByName = (icons: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(icons).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".png".length), url]));
