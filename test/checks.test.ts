// The mistakes construction refuses. Each case is a `@ts-expect-error` the
// typecheck holds (an unused one fails `bun run typecheck`) and, where the
// mistake can still be made from untyped code, the error construction throws.
// Together they pin the guarantees the README states: binds typed by column,
// declared refinements and stored UUIDs only, closed arithmetic, nullability
// that follows LEFT JOIN, and one catalog.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  SchemaSourceCatalog,
  addDuration,
  aliasTable,
  and,
  betweenInstants,
  buildQuery,
  columnValue,
  compare,
  count,
  cte,
  defineTable,
  derived,
  jsonEach,
  like,
  literal,
  lowerText,
  nullable,
  operation,
  refinement,
  trimText,
  eqParam,
  existsValue,
  leftJoin,
  nullableParam,
  param,
  project,
  randomBlob16,
  refinedParam,
  scalarLiteral,
  scalarParam,
  select,
  setValue,
  unionAll,
  update,
  type ExpressionValue,
} from "@curlewlabs-com/d1-typed-query";
import type { QueryRow } from "@curlewlabs-com/d1-typed-query/runtime";
import {
  Authors,
  Books,
  Library,
  Loans,
  addPages,
  firstEdition,
  type Genre,
  type Isbn,
  type Pages,
  LIBRARY_DDL,
} from "./library-schema";

describe("binds", () => {
  it("types each bind by the column it is compared with", () => {
    const query = buildQuery(
      select({
        from: Books,
        columns: [project(Books.title)],
        where: eqParam(Books.isbn, "isbn"),
      }),
    );
    query.bound({ isbn: "111" as Isbn });
    // @ts-expect-error a bare string is not an Isbn
    query.bound({ isbn: "111" });
    // @ts-expect-error a misspelled key is not the query's parameter
    expect(() => query.bound({ ibsn: "111" as Isbn })).toThrow(
      /missing bind param ":isbn"/,
    );
  });

  // Two fragments that reuse one bind name must agree on its domain, or the
  // statement could not be bound with any single value.
  it("refuses one name with two domains", () => {
    const pages = eqParam(Books.pages, "n");
    const author = compare(
      columnValue(Books.author_id),
      "=",
      scalarParam(Library.authorId, "n"),
    );
    // @ts-expect-error "n" is a page count in one fragment, an author in the other
    expect(() => and([pages, author])).toThrow(
      /incompatible domains for parameter "n"/,
    );
    const again = eqParam(Books.pages, "n");
    expect(and([pages, again]).requirements).toHaveLength(2);
  });

  it("accepts a declared refinement where its wider domain is read", () => {
    const genre = refinedParam(Books.genre, Library.genre, "genre");
    const query = buildQuery(
      select({
        from: Books,
        columns: [project(Books.title)],
        where: compare(columnValue(Books.genre), "=", genre),
      }),
    );
    query.bound({ genre: "poetry" satisfies Genre });
    // @ts-expect-error the refined bind accepts only the declared subset
    query.bound({ genre: "cookery" });
    expect(() =>
      // @ts-expect-error an Isbn column is not the Genre refinement's base
      refinedParam(Books.isbn, Library.genre, "genre"),
    ).toThrow(/refinement is incompatible/);
  });

  it("keeps an explicitly nullable bind out of a required column", () => {
    expect(() =>
      update({
        table: Loans,
        // @ts-expect-error due_at is NOT NULL
        set: [setValue(Loans.due_at, nullableParam(Loans.due_at, "due"))],
      }),
    ).toThrow(/incompatible with its destination/);
  });
});

describe("closed arithmetic", () => {
  it("adds a duration to an instant and not an instant to an instant", () => {
    const deadline = addDuration(
      columnValue(Loans.due_at),
      scalarParam(Library.seconds, "grace"),
    );
    expect(deadline.domain).toBe(Library.epochSeconds);
    const overdue = betweenInstants(
      scalarParam(Library.epochSeconds, "now"),
      columnValue(Loans.due_at),
    );
    expect(overdue.domain).toBe(Library.seconds);
    expect(() =>
      // @ts-expect-error an instant is not a duration
      addDuration(columnValue(Loans.due_at), columnValue(Loans.lent_at)),
    ).toThrow(/incompatible domains/);
  });

  it("propagates NULL through an instant that can be NULL", () => {
    const back = addDuration(
      columnValue(Loans.returned_at),
      scalarParam(Library.seconds, "grace"),
    );
    expect(back.domain.nullable).toBe(true);
    const maybe: ExpressionValue<typeof back> = null;
    expect(maybe).toBeNull();
  });

  it("applies a declared operation only to its own domains", () => {
    const _total = addPages(
      columnValue(Books.pages),
      scalarParam(Library.pages, "extra"),
    );
    const pages: ExpressionValue<typeof _total> = 1 as Pages;
    expect(pages).toBe(1 as Pages);
    expect(() =>
      // @ts-expect-error a count is not a page count
      addPages(columnValue(Books.pages), count(1)),
    ).toThrow(/incompatible domains/);
  });

  it("reads a declared conversion as its operand's SQL", () => {
    const query = buildQuery(
      select({
        from: Books,
        columns: [project(firstEdition(columnValue(Books.id)), "edition")],
      }),
    );
    expect(query.sql).toBe("SELECT id AS edition FROM books");
    expect(() =>
      // @ts-expect-error an edition is not a book
      firstEdition(columnValue(Books.current_edition_id)),
    ).toThrow(/incompatible domain/);
  });
});

describe("stored UUIDs and nullability", () => {
  it("mints random bytes only for a declared stored-UUID column", () => {
    expect(randomBlob16(Books.id).value.tree.kind).toBe("uuid");
    // @ts-expect-error an author id is an integer, not a stored UUID
    expect(() => randomBlob16(Authors.id)).toThrow(/stored-UUID/);
  });

  it("types a LEFT JOIN's columns as nullable in the derived row", () => {
    const loan = leftJoin(Loans, "l", (l) =>
      compare(columnValue(l.book_id), "=", columnValue(Books.id)),
    );
    const _query = buildQuery(
      select({
        from: Books,
        joins: [loan],
        columns: [project(Books.title), project(loan.source.due_at)],
      }),
    );
    const unmatched: QueryRow<ReturnType<typeof _query.bound>> = {
      title: "Looms",
      due_at: null,
    };
    expect(unmatched.due_at).toBeNull();
    const _plain = buildQuery(
      select({ from: Loans, columns: [project(Loans.due_at)] }),
    );
    // @ts-expect-error a required column read without a join is never NULL
    const never: QueryRow<ReturnType<typeof _plain.bound>> = { due_at: null };
    void never;
  });
});

describe("authority", () => {
  // A table defined in any catalog but the package's has the same shape and
  // SQL text, and must still be refused, or the checks above could be skipped
  // by building a look-alike.
  it("refuses a column from another catalog", () => {
    const lookalike = new SchemaSourceCatalog().defineTable("books", {
      title: Library.text,
    });
    expect(() =>
      select({ from: lookalike, columns: [project(count(1), "n")] }),
    ).toThrow(/table must come from the schema model/);
    expect(() =>
      select({ from: Books, columns: [project(lookalike.title)] }),
    ).toThrow(/must come from a constructor/);
  });

  // A refinement's values stand where its base is read, which compares
  // non-null descriptors; a nullable base could never be satisfied.
  it("refuses a nullable refinement base", () => {
    expect(() =>
      refinement<"a", string | null>("Letter", nullable(Library.text)),
    ).toThrow(/base must be non-null/);
  });

  // A copied domain has the right shape but not the identity every domain
  // check compares, so it is refused where it would type a column.
  it("refuses a copied domain descriptor", () => {
    expect(() =>
      defineTable("shelves", { label: { ...Library.text } }),
    ).toThrow(/central scalar definitions/);
  });

  // The operator is emitted as SQL text, so an untyped caller's operator must
  // be one of the declared set.
  it("refuses an operator outside the closed set", () => {
    expect(() =>
      // @ts-expect-error division is not a declared operator
      operation("/", Library.pages, Library.pages, Library.pages),
    ).toThrow(/unsupported operator/);
  });

  // A comparison's operator is emitted as SQL text too.
  it("refuses a comparison operator outside the closed set", () => {
    expect(() =>
      compare(
        columnValue(Books.pages),
        // @ts-expect-error LIKE is a predicate of its own, not a comparison
        "LIKE",
        param(Books.pages, "pages"),
      ),
    ).toThrow(/invalid comparison operator/);
  });

  // lower() and trim() keep their input's domain, so a refinement would keep
  // a refinement whose values the transform can move outside it.
  it("lowers and trims ordinary text only", () => {
    const genre = refinedParam(Books.genre, Library.genre, "genre");
    expect(lowerText(columnValue(Books.title)).domain).toBe(Library.text);
    // @ts-expect-error a refined value is not ordinary text
    expect(() => lowerText(genre)).toThrow(/ordinary text/);
    // @ts-expect-error a refined value is not ordinary text
    expect(() => trimText(genre)).toThrow(/ordinary text/);
  });

  // D1 refuses a compound SELECT of more than five terms, which SQLite allows.
  it("refuses a sixth UNION ALL arm before D1 would", () => {
    const arm = () => select({ columns: [project(count(1), "n")] });
    expect(() => unionAll(arm(), arm(), arm(), arm(), arm(), arm())).toThrow(
      /SELECT arm limit/,
    );
  });
});

describe("source names and literal text", () => {
  // In a conflict arm `excluded.<column>` is the incoming row. A source of
  // that name would render its own columns the same way, so nothing could
  // tell the two apart.
  it("reserves excluded for an upsert's incoming row", () => {
    expect(() => defineTable("Excluded", { id: Library.integer })).toThrow(
      /table "Excluded" is the name SQLite gives an upsert's incoming row/,
    );
    expect(() => aliasTable(Loans, "excluded")).toThrow(/table alias/);
    const titles = select({ from: Books, columns: [project(Books.title)] });
    expect(() => cte("excluded", titles)).toThrow(/CTE "excluded"/);
    expect(() => derived("EXCLUDED", titles)).toThrow(/derived source alias/);
    expect(() => jsonEach("excluded", "ids", Library.integer, 8)).toThrow(
      /json_each source alias/,
    );
  });

  // SQLite cannot prepare NUL inside a statement, and a lone surrogate has no
  // UTF-8 form, so the statement would compare against U+FFFD instead.
  it("refuses text SQL cannot carry in a literal or a LIKE pattern", () => {
    for (const text of ["a\u0000b", "a\ud800", "\udc00"]) {
      expect(() => literal(Books.title, text)).toThrow(
        /NUL or a lone surrogate/,
      );
      expect(() => scalarLiteral(Library.text, text)).toThrow(
        /literal holds NUL/,
      );
      expect(() => like(Books.title, text)).toThrow(/LIKE pattern holds NUL/);
    }
  });

  // The surrogate check reads code points, so a well-formed pair outside the
  // BMP is still written, and reaches SQLite as the same text.
  it("carries quotes and characters outside the BMP exactly", () => {
    const db = new Database(":memory:");
    db.run(LIBRARY_DDL);
    const text = "it's \u{1F4DA}";
    const query = buildQuery(
      select({
        columns: [
          project(scalarLiteral(Library.text, text), "text"),
          project(
            existsValue(
              select({
                from: Books,
                columns: [project(count(1), "n")],
                where: like(Books.title, `%${text}`),
              }),
            ),
            "matched",
          ),
        ],
      }),
    );
    expect(db.query(query.sql).get()).toEqual({ text, matched: 0 });
  });
});
