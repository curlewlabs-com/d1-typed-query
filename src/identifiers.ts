// Validation of the SQL identifiers query construction accepts.

// SQL identifiers are authored tokens rather than SQL fragments. Keeping this
// boundary shared prevents schema, alias, and parameter constructors from
// accepting different identifier grammars.

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// SQLite's keywords (https://www.sqlite.org/lang_keywords.html). SQLite lets
// some stand as names where its grammar allows it, but its documentation does
// not promise that a later release keeps doing so, so a name is refused for
// every keyword, not only for the ones that fail today.
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

// The grammar alone, which every name meets. A bind name is checked only this
// far: it renders as `?`. So is an output name: it is written only after `AS`
// and read only qualified or quoted (`c.current_time`,
// `ORDER BY "current_time"`), so it is never read as the keyword. One SQLite
// cannot parse after `AS` (`AS select`) fails when it is prepared.
export function assertSqlIdentifier(token: string, kind: string): void {
  if (!SQL_IDENTIFIER.test(token)) {
    throw new Error(
      `query-builder: ${kind} "${token}" is not a SQL identifier`,
    );
  }
}

// A name written bare where SQLite could read a keyword as the keyword: a
// column, which a single-source read renders unqualified (`current_time` reads
// the clock, `null` reads NULL); a source, whose name follows FROM or JOIN with
// no `AS` (`FROM books left JOIN authors` is a LEFT JOIN); an index.
export function assertSqlName(token: string, kind: string): void {
  assertSqlIdentifier(token, kind);
  if (SQLITE_KEYWORDS.has(token.toUpperCase()))
    throw new Error(`query-builder: ${kind} "${token}" is an SQLite keyword`);
}

// A name that qualifies columns: a table, an alias, a CTE. In an upsert's
// conflict arm `excluded` names the incoming row, so a source of that name
// would render its own columns exactly as the incoming row's.
export function assertSourceName(token: string, kind: string): void {
  assertSqlName(token, kind);
  if (token.toLowerCase() === "excluded")
    throw new Error(
      `query-builder: ${kind} "${token}" is the name SQLite gives an upsert's incoming row`,
    );
}
