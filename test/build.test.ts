// What buildQuery renders and whether SQLite runs it: each test pins the SQL
// and ordered bind names one statement shape produces, then prepares and runs
// that SQL against the library schema, because a rendering that SQLite cannot
// parse or that binds in the wrong order is the failure that matters.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  addDuration,
  aggregateCount,
  aliasTable,
  and,
  buildQuery,
  coalesce,
  compare,
  columnValue,
  conflictDoUpdate,
  cte,
  derived,
  eqParam,
  excludedTable,
  indexedBy,
  insert,
  isNull,
  jsonEach,
  innerJoin,
  leftJoin,
  crossJoin,
  nowEpochSeconds,
  orderBy,
  param,
  project,
  randomBlob16,
  remainderSeconds,
  scalarParam,
  scalarSubquery,
  select,
  setParam,
  setValue,
  unionAll,
  update,
  withCtes,
  elapsedSinceUnixOrigin,
  type Statement,
  type Requirements,
} from "@curlewlabs-com/d1-typed-query";
import { jsonArrayOf } from "@curlewlabs-com/d1-typed-query/runtime";
import {
  Authors,
  Books,
  LIBRARY_DDL,
  Library,
  Loans,
  addPages,
  type AuthorId,
  type BookId,
  type Isbn,
} from "./library-schema";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run(LIBRARY_DDL);
  db.run(`
    INSERT INTO authors VALUES (1, 'Ada', NULL), (2, 'Basil', 100);
    INSERT INTO books VALUES (x'01', 1, 'Engines', '111', 'history', 120, NULL, 1000),
                             (x'02', 1, 'Looms', '222', NULL, 80, x'22', 2000),
                             (x'03', 2, 'Tides', '333', 'poetry', 40, NULL, 3000);
    INSERT INTO members VALUES (7, 'Cora', 500), (8, 'Dev', 600);
    INSERT INTO loans VALUES (x'01', 7, 4000, 5000, NULL, 1, 0),
                             (x'02', 8, 4100, 4200, 4150, 2, 1);
  `);
});

function rows<P extends Requirements, R>(
  statement: Statement<P, R>,
  values: Record<string, unknown>,
): unknown[] {
  const query = buildQuery(statement);
  const params = query.paramNames.map((name) => values[name]);
  return db.query(query.sql).all(...(params as never[]));
}

const isbn = (text: string) => text as Isbn;

describe("rendering", () => {
  it("renders a single-source read with bare column names", () => {
    const query = buildQuery(
      select({
        from: Books,
        columns: [project(Books.title), project(Books.pages)],
        where: eqParam(Books.isbn, "isbn"),
      }),
    );
    expect(query.sql).toBe("SELECT title, pages FROM books WHERE isbn = ?");
    expect(query.paramNames).toEqual(["isbn"]);
    const bound = query.bound({ isbn: isbn("111") });
    expect(db.query(bound.sql).all(...(bound.params as never[]))).toEqual([
      { title: "Engines", pages: 120 },
    ]);
  });

  // One authored parameter reused in two places binds once by name but must
  // fill both positional slots, in order.
  it("repeats a reused parameter's name at every placeholder", () => {
    const author = param(Books.author_id, "author");
    const query = buildQuery(
      select({
        from: Books,
        columns: [project(Books.title)],
        where: and([
          compare(columnValue(Books.author_id), "=", author),
          compare(
            scalarSubquery(
              select({
                from: Authors,
                columns: [project(Authors.id)],
                where: compare(columnValue(Authors.id), "=", author),
              }),
            ),
            "IS NOT",
            scalarParam(Library.authorId, "excluded"),
          ),
        ]),
        orderBy: [orderBy(Books.title)],
      }),
    );
    expect(query.sql).toBe(
      "SELECT title FROM books WHERE author_id = ? AND (SELECT id FROM authors WHERE id = ?) IS NOT ? ORDER BY title",
    );
    expect(query.paramNames).toEqual(["author", "author", "excluded"]);
    const bound = query.bound({
      author: 1 as AuthorId,
      excluded: 9 as AuthorId,
    });
    expect(bound.params).toEqual([1, 1, 9]);
  });

  it("widens a LEFT JOIN's columns to nullable and keeps unmatched rows", () => {
    const loan = leftJoin(Loans, "l", (l) =>
      and([
        compare(columnValue(l.book_id), "=", columnValue(Books.id)),
        isNull(l.returned_at),
      ]),
    );
    const statement = select({
      from: Books,
      joins: [loan],
      columns: [project(Books.title), project(loan.source.member_id)],
      orderBy: [orderBy(Books.title)],
    });
    expect(buildQuery(statement).sql).toBe(
      "SELECT books.title, l.member_id FROM books LEFT JOIN loans l ON l.book_id = books.id AND l.returned_at IS NULL ORDER BY books.title",
    );
    expect(rows(statement, {})).toEqual([
      { title: "Engines", member_id: 7 },
      { title: "Looms", member_id: null },
      { title: "Tides", member_id: null },
    ]);
  });

  it("renders the time algebra as plain SQLite arithmetic", () => {
    const statement = select({
      from: Loans,
      columns: [
        project(
          addDuration(
            columnValue(Loans.due_at),
            scalarParam(Library.seconds, "grace"),
          ),
          "deadline",
        ),
        project(
          remainderSeconds(
            elapsedSinceUnixOrigin(columnValue(Loans.lent_at)),
            scalarParam(Library.seconds, "day"),
          ),
          "time_of_day",
        ),
      ],
      where: isNull(Loans.returned_at),
    });
    expect(buildQuery(statement).sql).toBe(
      "SELECT due_at + ? AS deadline, lent_at % ? AS time_of_day FROM loans WHERE returned_at IS NULL",
    );
    expect(rows(statement, { grace: 60, day: 1000 })).toEqual([
      { deadline: 5060, time_of_day: 0 },
    ]);
  });

  it("pins an index and keeps a CTE's column qualified", () => {
    const window = cte(
      "params",
      select({
        columns: [
          project(scalarParam(Library.epochSeconds, "cutoff"), "cutoff"),
        ],
      }),
      { form: "values" },
    );
    const open = indexedBy(aliasTable(Loans, "l"), "open_loans_by_due");
    const statement = withCtes(
      [window],
      select({
        from: open,
        joins: [crossJoin(window)],
        columns: [project(open.member_id)],
        where: and([
          isNull(open.returned_at),
          compare(columnValue(open.due_at), "<", columnValue(window.cutoff)),
        ]),
      }),
    );
    expect(buildQuery(statement).sql).toBe(
      "WITH params(cutoff) AS (VALUES (?)) SELECT l.member_id FROM loans l INDEXED BY open_loans_by_due CROSS JOIN params WHERE l.returned_at IS NULL AND l.due_at < params.cutoff",
    );
    expect(rows(statement, { cutoff: 6000 })).toEqual([{ member_id: 7 }]);
  });

  it("renders a derived source, UNION ALL and an aggregate", () => {
    const shelf = derived(
      "shelf",
      unionAll(
        select({
          from: Books,
          columns: [project(columnValue(Books.title), "title")],
          where: eqParam(Books.author_id, "first"),
        }),
        select({
          from: Books,
          columns: [project(columnValue(Books.title), "title")],
          where: eqParam(Books.author_id, "second"),
        }),
      ),
    );
    const statement = select({
      from: shelf,
      columns: [project(aggregateCount(), "titles")],
    });
    expect(buildQuery(statement).sql).toBe(
      "SELECT COUNT(*) AS titles FROM (SELECT title AS title FROM books WHERE author_id = ? UNION ALL SELECT title AS title FROM books WHERE author_id = ?) shelf",
    );
    expect(buildQuery(statement).paramNames).toEqual(["first", "second"]);
    expect(rows(statement, { first: 1, second: 2 })).toEqual([{ titles: 3 }]);
  });

  // A list of variable length takes one bind: a JSON array whose maximum the
  // source declares, so the statement's placeholder count stays fixed.
  it("binds a bounded list through one json_each placeholder", () => {
    const wanted = jsonEach("wanted", "ids", Library.bookId, 4);
    const statement = select({
      from: wanted.source,
      joins: [
        innerJoin(Books, compare(columnValue(Books.id), "=", wanted.element)),
      ],
      columns: [project(Books.title)],
      orderBy: [orderBy(Books.title)],
    });
    const query = buildQuery(statement);
    expect(query.sql).toBe(
      "SELECT books.title FROM json_each(?) wanted JOIN books ON books.id = unhex(wanted.value) ORDER BY books.title",
    );
    expect(query.jsonEachSources).toEqual([
      { alias: "wanted", bind: "ids", maxLength: 4 },
    ]);
    const ids = jsonArrayOf(
      [new Uint8Array([1]), new Uint8Array([3])] as unknown as BookId[],
      4,
    );
    expect<string>(ids).toBe('["01","03"]');
    expect(rows(statement, { ids })).toEqual([
      { title: "Engines" },
      { title: "Tides" },
    ]);
  });
});

describe("mutations", () => {
  it("inserts with a random stored UUID and the SQLite clock", () => {
    const statement = insert({
      table: Books,
      values: [
        randomBlob16(Books.id),
        setParam(Books.author_id, "author"),
        setParam(Books.title, "title"),
        setParam(Books.isbn, "isbn"),
        setParam(Books.pages, "pages"),
        setValue(Books.published_at, nowEpochSeconds()),
      ],
      returning: [Books.id],
    });
    expect(buildQuery(statement).sql).toBe(
      "INSERT INTO books (id, author_id, title, isbn, pages, published_at) SELECT randomblob(16), ?, ?, ?, ?, unixepoch('now') RETURNING id",
    );
    const [row] = rows(statement, {
      author: 2,
      title: "Reefs",
      isbn: "444",
      pages: 10,
    }) as { id: Uint8Array }[];
    expect(row?.id.byteLength).toBe(16);
  });

  // The conflict arm reads the incoming row through `excluded` and keeps the
  // stored count when the incoming one is NULL.
  it("upserts through the excluded row", () => {
    const incoming = excludedTable(Loans);
    const statement = insert({
      table: Loans,
      values: [
        setParam(Loans.book_id, "book"),
        setParam(Loans.member_id, "member"),
        setParam(Loans.lent_at, "lent"),
        setParam(Loans.due_at, "due"),
        setParam(Loans.status, "status"),
        setParam(Loans.renewals, "renewals"),
      ],
      onConflict: conflictDoUpdate({
        target: [Loans.book_id, Loans.member_id],
        excluded: incoming,
        set: [
          setValue(Loans.due_at, columnValue(incoming.due_at)),
          setValue(
            Loans.renewals,
            coalesce(
              columnValue(incoming.renewals),
              columnValue(Loans.renewals),
            ),
          ),
        ],
      }),
    });
    expect(buildQuery(statement).sql).toBe(
      "INSERT INTO loans (book_id, member_id, lent_at, due_at, status, renewals) SELECT ?, ?, ?, ?, ?, ? ON CONFLICT (book_id, member_id) DO UPDATE SET due_at = excluded.due_at, renewals = COALESCE(excluded.renewals, loans.renewals)",
    );
    rows(statement, {
      book: new Uint8Array([1]),
      member: 7,
      lent: 4000,
      due: 9000,
      status: 1,
      renewals: 2,
    });
    expect(
      db.query("SELECT due_at, renewals FROM loans WHERE member_id = 7").all(),
    ).toEqual([{ due_at: 9000, renewals: 2 }]);
  });

  it("updates through the declared operation", () => {
    const statement = update({
      table: Books,
      set: [
        setValue(
          Books.pages,
          addPages(
            columnValue(Books.pages),
            scalarParam(Library.pages, "extra"),
          ),
        ),
      ],
      where: eqParam(Books.isbn, "isbn"),
      returning: [Books.pages],
    });
    expect(buildQuery(statement).sql).toBe(
      "UPDATE books SET pages = pages + ? WHERE isbn = ? RETURNING pages",
    );
    expect(rows(statement, { extra: 5, isbn: "333" })).toEqual([{ pages: 45 }]);
  });
});
