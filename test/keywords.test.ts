// Names that are SQLite keywords. The renderer writes them in square brackets
// and every other name exactly as given. Each keyword is prepared and run against
// SQLite as a table, a column and an alias, so both the list and the quoting
// are exercised rather than asserted.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  aliasTable,
  buildQuery,
  columnValue,
  compare,
  conflictDoUpdate,
  cte,
  defineTable,
  derived,
  eqParam,
  excludedTable,
  indexedBy,
  innerJoin,
  insert,
  jsonEach,
  project,
  scalarParam,
  select,
  setParam,
  setValue,
  withCtes,
} from "@curlewlabs-com/d1-typed-query";
import { Books, LIBRARY_DDL, Library } from "./library-schema";

// SQLite's documented keyword list (https://www.sqlite.org/lang_keywords.html),
// written out here apart from the package's own copy, so a keyword the package
// missed would render bare and fail below.
const KEYWORDS = (
  "ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH " +
  "AUTOINCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE " +
  "COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE " +
  "CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE " +
  "DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE " +
  "EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED " +
  "GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY " +
  "INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE " +
  "LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF " +
  "OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING " +
  "PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE " +
  "RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT " +
  "SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION " +
  "UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH " +
  "WITHOUT"
)
  .toLowerCase()
  .split(" ");

// The package's one catalog refuses a table and a CTE of the same name, and it
// lives for the whole run, so this keyword is proven as a CTE name below
// rather than as a table.
const CTE_KEYWORD = "rows";

function library(): Database {
  const db = new Database(":memory:");
  db.run(LIBRARY_DDL);
  return db;
}

describe("keyword names", () => {
  // Unquoted, a keyword column either fails to prepare or is read as the
  // keyword (current_time as the clock, null as NULL), and a source aliased
  // `left` turns the join after it into a LEFT JOIN. The join below has no
  // matching book, so an inner join returns no row and a LEFT JOIN would
  // return one.
  it("prepares every keyword as a table, column and alias name", () => {
    const db = library();
    for (const keyword of KEYWORDS.filter((word) => word !== CTE_KEYWORD)) {
      const table = defineTable(keyword, { [keyword]: Library.pages });
      const column = table[keyword]!;
      const read = buildQuery(
        select({
          from: table,
          columns: [project(columnValue(column), keyword)],
          where: eqParam(column, "value"),
        }),
      );
      const q = `[${keyword}]`;
      expect(read.sql).toBe(`SELECT ${q} AS ${q} FROM ${q} WHERE ${q} = ?`);
      const alias = aliasTable(table, keyword);
      const joined = buildQuery(
        select({
          from: alias,
          joins: [
            innerJoin(
              Books,
              compare(
                columnValue(Books.pages),
                "=",
                columnValue(alias[keyword]!),
              ),
            ),
          ],
          columns: [project(columnValue(alias[keyword]!), keyword)],
        }),
      );
      expect(joined.sql).toBe(
        `SELECT ${q}.${q} AS ${q} FROM ${q} ${q} JOIN books ON books.pages = ${q}.${q}`,
      );
      db.run(`CREATE TABLE ${q} (${q} INTEGER NOT NULL)`);
      db.run(`INSERT INTO ${q} VALUES (7)`);
      expect(db.query(read.sql).all(7)).toEqual([{ [keyword]: 7 }]);
      expect(db.query(joined.sql).all()).toEqual([]);
    }
  });

  // A double-quoted name that matches no column is read by SQLite as a string,
  // which would let a keyword column the database lacks read as its own name.
  // In brackets it is only ever a name, so that drift fails to prepare.
  it("fails to prepare a keyword column the database lacks", () => {
    const db = library();
    const Drifted = defineTable("drifted", {
      id: Library.integer,
      key: Library.text,
    });
    db.run("CREATE TABLE drifted (id INTEGER NOT NULL) STRICT");
    const bare = buildQuery(
      select({ from: Drifted, columns: [project(Drifted.key)] }),
    );
    expect(bare.sql).toBe("SELECT [key] FROM drifted");
    expect(() => db.query(bare.sql)).toThrow(/no such column: key/);
    const d = aliasTable(Drifted, "d");
    const qualified = buildQuery(
      select({ from: d, columns: [project(d.id)], where: eqParam(d.key, "k") }),
    );
    expect(qualified.sql).toBe("SELECT d.id FROM drifted d WHERE d.[key] = ?");
    expect(() => db.query(qualified.sql)).toThrow(/no such column: d.key/);
  });

  it("leaves every other name bare", () => {
    expect(
      buildQuery(
        select({
          from: Books,
          columns: [project(columnValue(Books.title), "keys")],
          where: eqParam(Books.isbn, "key"),
        }),
      ).sql,
    ).toBe("SELECT title AS keys FROM books WHERE isbn = ?");
  });

  // A bind renders as `?`, so its name never reaches the SQL text.
  it("binds a parameter named after a keyword", () => {
    const query = buildQuery(
      select({
        from: Books,
        columns: [project(Books.title)],
        limit: scalarParam(Library.count, "limit"),
      }),
    );
    expect(query.sql).toBe("SELECT title FROM books LIMIT ?");
    expect(query.paramNames).toEqual(["limit"]);
  });

  // Every clause that writes a name quotes a keyword the same way: an
  // upsert's target, columns, conflict arm and RETURNING, a pinned index,
  // a VALUES CTE and its columns, a derived source and a json_each source.
  it("quotes a keyword in every clause that writes a name", () => {
    const db = library();
    const Orders = defineTable("Order", {
      Key: Library.text,
      current_time: Library.epochSeconds,
    });
    db.run(`
      CREATE TABLE "Order" ("Key" TEXT PRIMARY KEY, "current_time" INTEGER NOT NULL) STRICT;
      CREATE INDEX "index" ON "Order" ("current_time");
    `);
    const incoming = excludedTable(Orders);
    const upsert = buildQuery(
      insert({
        table: Orders,
        values: [
          setParam(Orders.Key, "key"),
          setParam(Orders.current_time, "at"),
        ],
        onConflict: conflictDoUpdate({
          target: [Orders.Key],
          excluded: incoming,
          set: [
            setValue(Orders.current_time, columnValue(incoming.current_time)),
          ],
        }),
        returning: [Orders.Key, Orders.current_time],
      }),
    );
    expect(upsert.sql).toBe(
      "INSERT INTO [Order] ([Key], [current_time]) SELECT ?, ? ON CONFLICT ([Key]) DO UPDATE SET [current_time] = excluded.[current_time] RETURNING [Key], [current_time]",
    );
    const run = (at: number) =>
      db
        .query(upsert.sql)
        .all(...upsert.paramNames.map((name) => (name === "key" ? "a" : at)));
    expect(run(100)).toEqual([{ Key: "a", current_time: 100 }]);
    expect(run(200)).toEqual([{ Key: "a", current_time: 200 }]);

    const pinned = indexedBy(Orders, "index");
    const rows = cte(
      CTE_KEYWORD,
      select({
        columns: [project(scalarParam(Library.text, "first"), "first")],
      }),
      { form: "values" },
    );
    const group = derived(
      "group",
      select({ from: pinned, columns: [project(pinned.current_time)] }),
    );
    const each = jsonEach("join", "keys", Library.text, 4);
    const read = buildQuery(
      withCtes(
        [rows],
        select({
          from: group,
          joins: [
            innerJoin(
              rows,
              compare(columnValue(rows.first), "=", columnValue(rows.first)),
            ),
            innerJoin(
              each.source,
              compare(each.element, "=", columnValue(rows.first)),
            ),
          ],
          columns: [project(group.current_time)],
        }),
      ),
    );
    expect(read.sql).toBe(
      "WITH [rows]([first]) AS (VALUES (?)) SELECT [group].[current_time] FROM (SELECT [current_time] FROM [Order] INDEXED BY [index]) [group] JOIN [rows] ON [rows].[first] = [rows].[first] JOIN json_each(?) [join] ON [join].value = [rows].[first]",
    );
    expect(db.query(read.sql).all("a", '["a"]')).toEqual([
      { current_time: 200 },
    ]);
  });
});
