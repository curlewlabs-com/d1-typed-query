// Validation of the SQL identifiers query construction accepts, and the form
// the renderer writes each one in.

// SQL identifiers are authored tokens rather than SQL fragments. Keeping this
// boundary shared prevents schema, alias, and parameter constructors from
// accepting different identifier grammars.

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// SQLite's keywords, as sqlite3_keyword_name() lists them in SQLite 3.54.0
// (https://www.sqlite.org/lang_keywords.html); a test prepares each one as a
// table, column and alias name. SQLite lets some keywords stand bare as names
// where its grammar allows, but not all, and a bare current_time reads the
// clock rather than a column of that name.
const SQLITE_KEYWORDS = new Set(
  (
    "ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH " +
    "AUTOINCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE " +
    "COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE " +
    "CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED " +
    "DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE " +
    "EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM " +
    "FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX " +
    "INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY " +
    "LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL " +
    "NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA " +
    "PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX " +
    "RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS " +
    "SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION " +
    "TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL " +
    "WHEN WHERE WINDOW WITH WITHOUT"
  ).split(" "),
);

// The grammar alone. A bind name is checked only this far: it renders as `?`.
export function assertSqlIdentifier(token: string, kind: string): void {
  if (!SQL_IDENTIFIER.test(token)) {
    throw new Error(
      `query-builder: ${kind} "${token}" is not a SQL identifier`,
    );
  }
}

// A name that qualifies columns: a table, an alias, a CTE. In an upsert's
// conflict arm `excluded` names the incoming row, so a source of that name
// would render its own columns exactly as the incoming row's, and quoting it
// would not tell them apart.
export function assertSourceName(token: string, kind: string): void {
  assertSqlIdentifier(token, kind);
  if (token.toLowerCase() === "excluded")
    throw new Error(
      `query-builder: ${kind} "${token}" is the name SQLite gives an upsert's incoming row`,
    );
}

// The identifier as the SQL text carries it: a keyword in square brackets, so
// SQLite reads it as the name, and every other identifier bare, exactly as
// written. Brackets rather than double quotes: SQLite reads a double-quoted
// name that matches no column as a string literal, so a keyword column the
// database lacks would read as its own name instead of failing to prepare. A
// bracketed name is only ever an identifier, a form SQLite documents as
// accepted (https://www.sqlite.org/lang_keywords.html). The grammar admits no
// `]`, so no escaping is needed.
export function sqlName(token: string): string {
  return SQLITE_KEYWORDS.has(token.toUpperCase()) ? `[${token}]` : token;
}
