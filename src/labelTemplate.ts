/**
 * The token-template engine behind every customizable label — the meter's
 * player-name cell and the overlay header's segments.
 *
 * A template is literal text with `{token}` placeholders. Substitution is the
 * easy half; the collapse rules are what let ONE template cover both "names
 * shown" and "names hidden" without the user maintaining two strings.
 */

/** `{name}` — a leading letter then letters/digits, so `100%` and `{}` stay literal text. */
const TOKEN_PATTERN = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * Stands in for a token that resolved to empty, so the collapse rules can tell
 * "this bracket group follows a value that vanished" from "this bracket group
 * follows literal text". Stripped before the result is returned.
 *
 * Built with `String.fromCharCode` rather than written as a string escape: a
 * literal U+0000 in source is invisible and easy for tooling to mangle, and
 * NUL is the one character a template typed into a text input cannot contain.
 */
const EMPTY_MARK = String.fromCharCode(0);

export type TemplateTokens = Record<string, string>;

/**
 * Every `{token}` match in a template, in order.
 *
 * Walks a COPY of the pattern rather than TOKEN_PATTERN itself. `matchAll`
 * never writes `lastIndex` back to the regex it is given, but it does *read*
 * it — so one stray `.exec()` or `.test()` on the shared global elsewhere in
 * this module would leave it dirty and make the next walk silently start
 * mid-string, dropping every token before that offset with no error. Copying
 * the RegExp rather than its `.source` keeps whatever flags TOKEN_PATTERN
 * gains later; `.source` alone would quietly drop a `u` and stop matching
 * non-ASCII token names.
 *
 * Both walkers below go through here, so neither can drift from the other.
 */
const matchTokens = (template: string): RegExpMatchArray[] => [...template.matchAll(new RegExp(TOKEN_PATTERN))];

/** Every `{token}` name in a template, in order, including repeats. */
const tokenNames = (template: string): string[] => matchTokens(template).map((match) => match[1]);

/** One piece of a split template: literal text, or a `{token}` placeholder. */
export type TemplatePart = { type: "text"; value: string } | { type: "token"; name: string };

/**
 * Splits a template into its literal and token parts, in order.
 *
 * Deliberately whitelist-agnostic: an unrecognized name still comes back as a
 * token, so the editor can show it as a broken chip rather than the parser
 * quietly turning it back into text the user cannot see is wrong.
 *
 * Empty text runs are omitted, so `{a}{b}` yields two parts, not three.
 */
export const splitTemplate = (template: string): TemplatePart[] => {
  const parts: TemplatePart[] = [];
  let cursor = 0;

  for (const match of matchTokens(template)) {
    // `matchAll` always populates `index`; the assertion is only to satisfy
    // RegExpMatchArray's optional typing. Defaulting to 0 instead would be
    // actively harmful — the cursor would jump backwards and silently eat the
    // preceding text run rather than failing where we could see it.
    const start = match.index!;
    if (start > cursor) parts.push({ type: "text", value: template.slice(cursor, start) });
    parts.push({ type: "token", name: match[1] });
    cursor = start + match[0].length;
  }

  if (cursor < template.length) parts.push({ type: "text", value: template.slice(cursor) });
  return parts;
};

/**
 * Token names used in `template` that aren't in `allowed` — what the settings
 * editor warns about. Deduplicated, so a repeated typo is reported once.
 */
export const unknownTokens = (template: string, allowed: readonly string[]): string[] => [
  ...new Set(tokenNames(template).filter((name) => !allowed.includes(name))),
];

/**
 * Renders a template against its token values.
 *
 * A token missing from `tokens` is left LITERAL (`{typo}` renders as `{typo}`):
 * a token that silently vanished is how a broken label ships unnoticed. A token
 * that is present but empty triggers the collapse rules:
 *
 *   1. A bracket pair — `()` or `[]` — with no non-whitespace content is removed.
 *   2. A bracket group immediately after an emptied token loses its brackets,
 *      keeping its contents.
 *   3. Whitespace runs collapse to one space; the result is trimmed.
 *
 * Rule 2 is what reproduces the meter's long-standing streamer-mode behaviour:
 * `[{slot}] {name} ({character})` renders `[1] Scott (Cagliostro)` normally and
 * `[1] Cagliostro` — parentheses and all — once the name is hidden.
 *
 * Bracket groups are not nesting-aware; `({a} (b))` is not a supported shape.
 */
export const renderTemplate = (template: string, tokens: TemplateTokens): string => {
  const substituted = template.replace(TOKEN_PATTERN, (literal, name: string) => {
    const value = tokens[name];
    if (value === undefined) return literal;
    return value === "" ? EMPTY_MARK : value;
  });

  // Rule 2 runs before rule 1: unwrapping can leave a group whose contents are
  // themselves empty, which rule 1 then removes.
  const unwrapped = substituted
    .replace(new RegExp(`${EMPTY_MARK}\\s*\\(([^()]*)\\)`, "g"), `${EMPTY_MARK} $1`)
    .replace(new RegExp(`${EMPTY_MARK}\\s*\\[([^[\\]]*)\\]`, "g"), `${EMPTY_MARK} $1`);

  const pruned = unwrapped
    .replace(new RegExp(`\\(\\s*(?:${EMPTY_MARK}\\s*)*\\)`, "g"), "")
    .replace(new RegExp(`\\[\\s*(?:${EMPTY_MARK}\\s*)*\\]`, "g"), "");

  return pruned.split(EMPTY_MARK).join("").replace(/\s+/g, " ").trim();
};
