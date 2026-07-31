/**
 * The token-template engine behind every customizable label — the meter's
 * player-name cell and the overlay header's segments.
 *
 * A template is literal text with `{token}` placeholders. Substitution is the
 * easy half; the collapse rules are what let ONE template cover both "names
 * shown" and "names hidden" without the user maintaining two strings.
 */

/**
 * A token name: a leading letter then letters/digits, so `100%` and `{}` stay
 * literal text.
 *
 * The ONE definition of the grammar. The chip editor needs the same shape in
 * two more forms — anchored for validation, and brace-wrapped for its input
 * rule — and a name any of them disagreed about would not survive the
 * chip → stored string → reparse round trip.
 *
 * MUST contain no capturing group. Every consumer wraps it in exactly one and
 * reads `match[1]` for the name, so a `(…)` added here — widening the grammar
 * as `"([a-zA-Z]|_)[a-zA-Z0-9]*"` rather than `"(?:…)"` — would silently make
 * group 1 the inner alternation and every token render as its first letter.
 */
export const TOKEN_NAME_SOURCE = "[a-zA-Z][a-zA-Z0-9]*";

/** `{name}`, as the renderer scans for it. */
const TOKEN_PATTERN = new RegExp(`\\{(${TOKEN_NAME_SOURCE})\\}`, "g");

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

/**
 * Prefixes a token that resolved to a real value, the mirror of EMPTY_MARK.
 *
 * Without it the collapse rules cannot tell a surviving VALUE from the literal
 * text around it once substitution has happened — `HP 45.2% (x / y)` and
 * `HP 45.2% ( / )` are the same string to a regex unless the values are marked.
 * That distinction is the whole of rule 1 below. Stripped with EMPTY_MARK.
 */
const VALUE_MARK = String.fromCharCode(1);

/**
 * Wraps the index of a token that renders as a React node rather than text, so
 * `renderTemplateNodes` can find it again after the string engine has run.
 *
 * Distinct from EMPTY_MARK and VALUE_MARK because it has to survive alongside
 * them: a node token is a *present* value as far as the collapse rules are
 * concerned, and marking it as one is the whole trick — the rules then treat an
 * icon exactly as they treat a name, with no second implementation.
 */
const NODE_MARK = String.fromCharCode(2);

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
 * Every token name used across a group of templates, deduplicated.
 *
 * What the settings palette needs to grey out a token that is already placed:
 * the overlay header is one header split into segments, so a token spent in any
 * one of them is spent for all of them. Takes the whole group rather than one
 * template precisely so the caller cannot forget a field.
 */
export const usedTokens = (templates: readonly string[]): string[] => [
  ...new Set(templates.flatMap((template) => tokenNames(template))),
];

/**
 * Drops every bracket group of one kind that has lost all its values.
 *
 * "Lost all its values" means the group holds at least one emptied token and no
 * surviving one — its remaining text is punctuation that was only ever there to
 * separate values, so `({hpCurrent} / {hpMax})` goes rather than leaving `( / )`.
 * A group of pure literal text has no emptied token in it and is left alone; a
 * group that is genuinely blank (`()`) goes, as it always has.
 */
const dropEmptiedGroups = (text: string, pattern: RegExp): string =>
  text.replace(pattern, (group, content: string) => {
    if (content.includes(VALUE_MARK)) return group;
    return content.includes(EMPTY_MARK) || content.trim() === "" ? "" : group;
  });

/**
 * Hoisted rather than built per call: these close over module constants only,
 * and `renderTemplate` compiled FOUR of them on every call — five header
 * segments plus one per player row is ~9 calls a meter frame, so ~36 `RegExp`
 * constructions a frame that all produce the same five patterns.
 *
 * Safe to share despite `/g`: `String.replace` sets `lastIndex` to 0 before it
 * starts and `RegExpBuiltinExec` resets it to 0 on the terminating failed
 * match, so a shared pattern cannot carry state between calls even if a
 * replacer throws part-way. `String.matchAll` never writes `lastIndex` back —
 * but it does READ it, so NODE_SLOT is still walked through a copy below.
 */
const PAREN_INNER = "[^()]*";
const BRACKET_INNER = "[^[\\]]*";
const PAREN_GROUP = new RegExp(`\\((${PAREN_INNER})\\)`, "g");
const BRACKET_GROUP = new RegExp(`\\[(${BRACKET_INNER})\\]`, "g");
const EMPTY_THEN_PARENS = new RegExp(`${EMPTY_MARK}\\s*\\((${PAREN_INNER})\\)`, "g");
const EMPTY_THEN_BRACKETS = new RegExp(`${EMPTY_MARK}\\s*\\[(${BRACKET_INNER})\\]`, "g");
const WHITESPACE_RUN = /\s+/g;
// `\\d` matters: in a template literal `\d` collapses to a bare `d`, which
// silently makes this hunt for the letter rather than the index.
const NODE_SLOT = new RegExp(`${NODE_MARK}(\\d+)${NODE_MARK}`, "g");

/**
 * Renders a template against its token values.
 *
 * A token missing from `tokens` is left LITERAL (`{typo}` renders as `{typo}`):
 * a token that silently vanished is how a broken label ships unnoticed. A token
 * that is present but empty triggers the collapse rules:
 *
 *   1. A bracket group — `()` or `[]` — left with no surviving value is removed,
 *      punctuation and all.
 *   2. A bracket group immediately after an emptied token loses its brackets,
 *      keeping its contents.
 *   3. A template whose tokens ALL emptied renders as nothing, whatever literal
 *      text surrounds them.
 *   4. Whitespace runs collapse to one space; the result is trimmed.
 *
 * Rule 2 is what reproduces the meter's long-standing streamer-mode behaviour:
 * `[{slot}] {name} ({character})` renders `[1] Scott (Cagliostro)` normally and
 * `[1] Cagliostro` — parentheses and all — once the name is hidden.
 *
 * Rule 3 is the same idea one level up: literal text exists to decorate values,
 * so with every value gone there is nothing left to decorate. It is what keeps
 * the overlay's `{dps}/s` segment from reading `/s` before a fight starts.
 *
 * Bracket groups are not nesting-aware; `({a} (b))` is not a supported shape.
 */
export const renderTemplate = (template: string, tokens: TemplateTokens): string => {
  let known = 0;
  let emptied = 0;

  const substituted = template.replace(TOKEN_PATTERN, (literal, name: string) => {
    const value = tokens[name];
    // An unknown token stays literal, so it is neither known nor emptied: a
    // typo must keep its segment on screen where it can be seen and fixed.
    if (value === undefined) return literal;
    known += 1;
    if (value === "") {
      emptied += 1;
      return EMPTY_MARK;
    }
    return VALUE_MARK + value;
  });

  // Rule 3, before any collapsing: nothing survives, so nothing needs pruning.
  if (known > 0 && emptied === known) return "";

  // Rule 2 runs before rule 1: unwrapping can leave a group whose contents are
  // themselves empty, which rule 1 then removes.
  const unwrapped = substituted
    .replace(EMPTY_THEN_PARENS, `${EMPTY_MARK} $1`)
    .replace(EMPTY_THEN_BRACKETS, `${EMPTY_MARK} $1`);

  const pruned = [PAREN_GROUP, BRACKET_GROUP].reduce(dropEmptiedGroups, unwrapped);

  return pruned.split(EMPTY_MARK).join("").split(VALUE_MARK).join("").replace(WHITESPACE_RUN, " ").trim();
};

/** One piece of a rendered template: literal text, or a token to draw as a node. */
export type TemplateNodePart = { type: "text"; value: string } | { type: "node"; name: string; value: string };

/**
 * Renders a template where some tokens draw as React nodes rather than text —
 * the meter's `{icon}`, which is an `<img>`, not a string.
 *
 * Deliberately built ON TOP of renderTemplate rather than beside it. Each node
 * token is swapped for a sentinel that reads to the string engine as an
 * ordinary present value, the engine runs untouched, and the sentinels are cut
 * back out afterwards. So every collapse rule — emptied groups, bracket
 * unwrapping, all-empty, whitespace — applies to an icon exactly as it applies
 * to a name, and cannot drift, because there is only one copy of them.
 *
 * A node token that is empty or absent is left for the engine to handle, so it
 * empties and collapses like any other token.
 *
 * `value` on a node part is the RAW token value (e.g. `Pl1400`), not the
 * sentinel — callers map it to whatever they draw.
 */
export const renderTemplateNodes = (
  template: string,
  tokens: TemplateTokens,
  nodeTokens: readonly string[]
): TemplateNodePart[] => {
  const slots: { name: string; value: string }[] = [];
  const substituted: TemplateTokens = { ...tokens };

  for (const name of nodeTokens) {
    const value = tokens[name];
    // undefined stays literal, "" stays emptied — both are the engine's job.
    if (value === undefined || value === "") continue;
    substituted[name] = `${NODE_MARK}${slots.length}${NODE_MARK}`;
    slots.push({ name, value });
  }

  const rendered = renderTemplate(template, substituted);

  const parts: TemplateNodePart[] = [];
  let cursor = 0;

  // A COPY, for the same reason `matchTokens` walks one: `matchAll` reads the
  // source regex's `lastIndex` (it just never writes it back), so a shared `/g`
  // constant that anything ever `.exec()`s or `.test()`s would make this start
  // mid-string and silently drop the leading node slots.
  for (const match of rendered.matchAll(new RegExp(NODE_SLOT))) {
    const start = match.index!;
    if (start > cursor) parts.push({ type: "text", value: rendered.slice(cursor, start) });
    const slot = slots[Number(match[1])];
    parts.push({ type: "node", name: slot.name, value: slot.value });
    cursor = start + match[0].length;
  }

  if (cursor < rendered.length) parts.push({ type: "text", value: rendered.slice(cursor) });
  return parts;
};
