// Validation of the text the renderer writes between quotes: a literal's value
// or a LIKE pattern. Quotes are escaped where it is written (renderer.ts); this
// refuses what no escaping can carry.

// SQLite cannot prepare a statement with NUL in its text. A lone surrogate has
// no UTF-8 form, so the statement would carry U+FFFD in its place and compare
// against a different string than the one written.
const UNWRITABLE_TEXT = /[\u0000\p{Surrogate}]/u;

export function assertLiteralText(value: string, kind: string): void {
  if (UNWRITABLE_TEXT.test(value))
    throw new Error(
      `query-builder: ${kind} holds NUL or a lone surrogate, which SQL text cannot carry`,
    );
}
