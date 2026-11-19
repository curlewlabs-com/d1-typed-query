// The remaining statement forms run against SQLite (DELETE, the two ways an
// insert meets a conflict, INSERT from a read, UNION's deduplication), and the
// scope and row guarantees construction holds: declared outer sources, CTEs
// that must be attached in order and keep apart from table names, ordering
// terms SQLite would read as something else, compound arms that must agree,
// and the two subquery forms that keep a non-null result.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  aggregateMax,
  aggregateSubquery,
  aliasTable,
  buildQuery,
  columnValue,
  compare,
  conflictDoNothing,
  count,
  cte,
  defineTable,
  deleteFrom,
  eqParam,
  exists,
  insert,
  isNotNull,
  operation,
  orderBy,
  project,
  requiredScalarSubquery,
  scalarParam,
  select,
  setParam,
  setValue,
  union,
  unionAll,
  withCtes,
  type ExpressionValue,
  type Requirements,
  type Statement,
} from "@curlewlabs-com/d1-typed-query";
import { Authors, Books, LIBRARY_DDL, Library, Loans } from "./library-schema";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run(LIBRARY_DDL);
  db.run(`
    INSERT INTO authors VALUES (1, 'Ada', NULL), (2, 'Basil', 100);
    INSERT INTO books VALUES (x'01', 1, 'Engines', '111', 'history', 120, NULL, 1000),
                             (x'02', 1, 'Looms', '222', 'history', 80, NULL, 2000),
                             (x'03', 2, 'Tides', '333', 'poetry', 40, NULL, 3000);
    INSERT INTO members VALUES (7, 'Cora', 500);
    INSERT INTO loans VALUES (x'01', 7, 4000, 5000, NULL, 1, 0),
                             (x'02', 7, 4100, 4200, 4150, 2, 1);
  `);
});

function run<P extends Requirements, R>(
  statement: Statement<P, R>,
  values: Record<string, unknown> = {},
): unknown[] {
  const query = buildQuery(statement);
  const params = query.paramNames.map((name) => values[name]);
  return db.query(query.sql).all(...(params as never[]));
}

const loanRow = (book: number) => ({
  book: new Uint8Array([book]),
  member: 7,
  lent: 6000,
  due: 7000,
  status: 1,
  renewals: 0,
});
const loanValues = [
  setParam(Loans.book_id, "book"),
  setParam(Loans.member_id, "member"),
  setParam(Loans.lent_at, "lent"),
  setParam(Loans.due_at, "due"),
  setParam(Loans.status, "status"),
  setParam(Loans.renewals, "renewals"),
] as const;

describe("statement forms", () => {
  it("deletes with a predicate and returns the deleted rows", () => {
    const statement = deleteFrom({
      table: Loans,
      where: isNotNull(Loans.returned_at),
      returning: [Loans.book_id],
    });
    expect(buildQuery(statement).sql).toBe(
      "DELETE FROM loans WHERE returned_at IS NOT NULL RETURNING book_id",
    );
    expect(run(statement)).toEqual([{ book_id: new Uint8Array([2]) }]);
  });

  it("leaves the stored row alone on a targeted DO NOTHING", () => {
    const statement = insert({
      table: Loans,
      values: loanValues,
      onConflict: conflictDoNothing({
        target: [Loans.book_id, Loans.member_id],
      }),
    });
    expect(buildQuery(statement).sql).toBe(
      "INSERT INTO loans (book_id, member_id, lent_at, due_at, status, renewals) SELECT ?, ?, ?, ?, ?, ? ON CONFLICT (book_id, member_id) DO NOTHING",
    );
    run(statement, loanRow(1));
    expect(
      db.query("SELECT due_at FROM loans WHERE book_id = x'01'").all(),
    ).toEqual([{ due_at: 5000 }]);
  });

  it("renders INSERT OR IGNORE as its own conflict policy", () => {
    const statement = insert({
      table: Loans,
      orIgnore: true,
      values: loanValues,
    });
    expect(buildQuery(statement).sql).toBe(
      "INSERT OR IGNORE INTO loans (book_id, member_id, lent_at, due_at, status, renewals) SELECT ?, ?, ?, ?, ?, ?",
    );
    run(statement, loanRow(1));
    run(statement, loanRow(3));
    expect(db.query("SELECT COUNT(*) AS n FROM loans").get()).toEqual({ n: 3 });
  });

  // The destination does not become readable: values read only the declared
  // source, here the book being lent.
  it("inserts from a declared read source", () => {
    const statement = insert({
      table: Loans,
      from: Books,
      values: [
        setValue(Loans.book_id, columnValue(Books.id)),
        setParam(Loans.member_id, "member"),
        setValue(Loans.lent_at, columnValue(Books.published_at)),
        setParam(Loans.due_at, "due"),
        setParam(Loans.status, "status"),
        setParam(Loans.renewals, "renewals"),
      ],
      where: eqParam(Books.isbn, "isbn"),
    });
    expect(buildQuery(statement).sql).toBe(
      "INSERT INTO loans (book_id, member_id, lent_at, due_at, status, renewals) SELECT id, ?, published_at, ?, ?, ? FROM books WHERE isbn = ?",
    );
    run(statement, {
      member: 7,
      due: 9000,
      status: 1,
      renewals: 0,
      isbn: "333",
    });
    expect(
      db.query("SELECT lent_at FROM loans WHERE book_id = x'03'").all(),
    ).toEqual([{ lent_at: 3000 }]);
  });

  it("deduplicates whole rows with UNION and keeps them with UNION ALL", () => {
    const arm = () =>
      select({
        from: Books,
        columns: [project(Books.genre)],
        where: compare(
          columnValue(Books.author_id),
          "=",
          scalarParam(Library.authorId, "author"),
        ),
      });
    expect(run(union(arm(), arm()), { author: 1 })).toEqual([
      { genre: "history" },
    ]);
    expect(run(unionAll(arm(), arm()), { author: 1 })).toHaveLength(4);
  });
});

describe("scope", () => {
  // A correlated subquery names the outer occurrence it reads; an undeclared
  // one could otherwise resolve to whatever source of that name is in scope.
  it("requires a correlated read to declare its outer source", () => {
    const outer = aliasTable(Books, "b");
    const onLoan = (declared: boolean) =>
      exists(
        select({
          from: Loans,
          ...(declared ? { outer: [outer] } : {}),
          columns: [project(count(1), "one")],
          where: compare(
            columnValue(Loans.book_id),
            "=",
            columnValue(outer.id),
          ),
        }),
      );
    const statement = select({
      from: outer,
      columns: [project(outer.title)],
      where: onLoan(true),
    });
    expect(buildQuery(statement).sql).toBe(
      "SELECT b.title FROM books b WHERE EXISTS (SELECT 1 AS one FROM loans WHERE book_id = b.id)",
    );
    expect(run(statement)).toEqual([{ title: "Engines" }, { title: "Looms" }]);
    expect(() => onLoan(false)).toThrow();
  });

  it("refuses a CTE that is not attached, or attached after its reader", () => {
    const first = cte(
      "first_author",
      select({
        columns: [project(scalarParam(Library.authorId, "author"), "id")],
      }),
      { form: "values" },
    );
    const reader = select({
      from: first,
      columns: [project(first.id)],
    });
    expect(() => buildQuery(reader)).toThrow(/no visible definition/);
    const later = cte(
      "later",
      select({ from: first, columns: [project(first.id)] }),
    );
    expect(() =>
      buildQuery(
        withCtes(
          [later, first],
          select({ from: later, columns: [project(later.id)] }),
        ),
      ),
    ).toThrow(/no visible definition/);
    expect(
      buildQuery(
        withCtes(
          [first, later],
          select({ from: later, columns: [project(later.id)] }),
        ),
      ).sql,
    ).toBe(
      "WITH first_author(id) AS (VALUES (?)), later AS (SELECT first_author.id FROM first_author) SELECT later.id FROM later",
    );
  });

  // A CTE shadows a table of its name for every read inside its WITH scope,
  // so a table defined after the CTE must not take that name either.
  it("keeps CTE and table names apart whichever is defined first", () => {
    const shelf = select({ from: Books, columns: [project(Books.title)] });
    cte("Reading_List", shelf);
    expect(() => defineTable("reading_list", { title: Library.text })).toThrow(
      /table cannot take a CTE's name/,
    );
    expect(() => cte("BOOKS", shelf)).toThrow(/cannot shadow a physical table/);
  });

  // SQLite reads a bare ORDER BY name as an output alias before an input
  // column. A single-source read renders its columns bare, so ordering by
  // pages while projecting the title as "pages" would sort by the title.
  it("refuses a bare ordering name that an output alias would capture", () => {
    expect(() =>
      select({
        from: Books,
        columns: [project(columnValue(Books.title), "pages")],
        orderBy: [orderBy(Books.pages)],
      }),
    ).toThrow(/ordering by "pages" would order by the output alias "pages"/);
    const sameColumn = select({
      from: Books,
      columns: [
        project(Books.title),
        project(columnValue(Books.pages), "pages"),
      ],
      orderBy: [orderBy(Books.pages, "DESC")],
    });
    expect(buildQuery(sameColumn).sql).toBe(
      "SELECT title, pages AS pages FROM books ORDER BY pages DESC",
    );
    const b = aliasTable(Books, "b");
    const qualified = select({
      from: b,
      columns: [project(columnValue(b.title), "pages")],
      orderBy: [orderBy(b.pages)],
    });
    expect(buildQuery(qualified).sql).toBe(
      "SELECT b.title AS pages FROM books b ORDER BY b.pages",
    );
    expect(run(qualified)).toEqual([
      { pages: "Tides" },
      { pages: "Looms" },
      { pages: "Engines" },
    ]);
  });

  // An integer constant in ORDER BY is an output position, not a value.
  it("refuses ordering by an integer constant", () => {
    expect(() =>
      select({
        from: Books,
        columns: [project(Books.title), project(Books.pages)],
        orderBy: [orderBy(count(2))],
      }),
    ).toThrow(/orders by an output position/);
  });

  it("refuses compound arms whose outputs disagree", () => {
    const titles = select({ from: Books, columns: [project(Books.title)] });
    const pages = select({ from: Books, columns: [project(Books.pages)] });
    // @ts-expect-error a page count is not a title
    expect(() => unionAll(titles, pages)).toThrow();
  });
});

describe("subquery row guarantees", () => {
  it("keeps an aggregate subquery's domain, nullable where empty input is", () => {
    const _latest = aggregateSubquery(
      select({
        from: Loans,
        columns: [project(aggregateMax(columnValue(Loans.due_at)))],
      }),
    );
    const due: ExpressionValue<typeof _latest> = null;
    expect(due).toBeNull();
    // Construction, not the type, refuses a plain column here.
    expect(() =>
      aggregateSubquery(
        select({ from: Loans, columns: [project(Loans.due_at)] }),
      ),
    ).toThrow(/aggregate/);
  });

  it("keeps a required lookup non-null and refuses a nullable projection", () => {
    const _name = requiredScalarSubquery(
      select({
        from: Authors,
        columns: [project(Authors.name)],
        where: compare(
          columnValue(Authors.id),
          "=",
          columnValue(Books.author_id),
        ),
        outer: [Books],
      }),
    );
    const text: ExpressionValue<typeof _name> = "Ada";
    expect(text).toBe("Ada");
    expect(() =>
      requiredScalarSubquery(
        // @ts-expect-error born_at can be NULL
        select({ from: Authors, columns: [project(Authors.born_at)] }),
      ),
    ).toThrow(/non-null projection/);
  });
});

describe("declared remainder", () => {
  // SQLite returns NULL for a remainder by zero, so the declared result must
  // admit NULL even when both operands are required.
  it("types a declared % as nullable whatever its operands", () => {
    const remainder = operation(
      "%",
      Library.count,
      Library.count,
      Library.count,
    );
    const value = remainder(count(1), count(0));
    expect(value.domain.nullable).toBe(true);
    const none: ExpressionValue<typeof value> = null;
    expect(none).toBeNull();
    expect(run(select({ columns: [project(value, "r")] }))).toEqual([
      { r: null },
    ]);
  });
});
