import { useOptimisticSearchParams } from "nuqs/adapters/react-router/v6";

/** The live URL query string, leading "?" and all, or "" when there is none.
 *
 * NOT `useLocation().search`. nuqs defaults to `shallow: true`, and its
 * react-router adapter serves a shallow update by calling `history.replaceState`
 * directly, reaching for `navigate()` only when `shallow` is false. The address
 * bar is therefore correct while react-router's own location object — a snapshot
 * that changes only when react-router itself navigates — keeps answering with
 * whatever search string was there at mount. For a view whose pins are all
 * shallow writes, that is the empty string, forever.
 *
 * nuqs's own hook is the one source that follows all of it: its adapter emits
 * every internal update (optimistically, ahead of the throttled URL write) and
 * patches the History API to catch Link navigations and outside writes. Called
 * with no arguments it watches every key, not just this view's pins.
 *
 * The encoding is `URLSearchParams`', so a character nuqs leaves literal in the
 * address bar for readability (a comma in `tgt`) reads percent-encoded here.
 * The two decode identically. */
export const useUrlQueryString = (): string => {
  const query = useOptimisticSearchParams().toString();
  return query === "" ? "" : `?${query}`;
};

