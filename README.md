# d1-typed-query

Type-checked SQL for Cloudflare D1: queries written with a typed builder and
frozen to plain SQL at build time, so the Worker ships the SQL and not the
builder.

## What it is

A TypeScript package in three parts:

- **A builder** (`@curlewlabs-com/d1-typed-query`). You declare your tables with
  a semantic domain for every column, and write each query from checked
  constructors. A bind's type comes from the column it is compared with or
  written to. A projection's row type comes from the columns and expressions it
  selects, nullable where a LEFT JOIN or an empty aggregate can make it so.
  `buildQuery` renders the statement to positional SQL and its ordered bind
  names in one pass.
- **A freezer** (`@curlewlabs-com/d1-typed-query/freeze`). At build time it
  turns a registry of built queries into a module of
  `precomputed(sql, paramNames)` entries. The module imports its authored
  registry for types only, so every bind and row type survives and the builder
  is not loaded.
- **A runtime** (`@curlewlabs-com/d1-typed-query/runtime`). This is what your
  Worker loads: `Query.bound()`, which maps named values to positional
  parameters, and `lowerToD1`/`batchD1`, which prepare and bind the statement
  and return the query's own row type. It does not export `precomputed`, so code
  that imports only the runtime runs the queries it is handed and cannot build
  one from SQL text. The frozen module imports only its contract part,
  `@curlewlabs-com/d1-typed-query/contract` (`precomputed`, `Query`,
  `BoundQuery`, `GeneratedQuery`), which names no D1 type, so a program that
  runs statements through a database handle of its own can load frozen queries
  without the Workers types.

## Why it exists

A user id, a timestamp and a page count are all `number` to TypeScript and all
`INTEGER` to SQLite. So `WHERE id = ?` bound with a timestamp compiles, runs and
reads the wrong rows. A string of SQL beside a hand-written row type drifts from
the query the moment either is edited.

Branded domains close the first gap and a builder closes the second, but a
builder that runs at request time puts its own code and its query building on
the Worker's hot path. A Worker's start-up and CPU time are both metered. This
package builds every query once, at build time, and keeps only the result.

It was built for a Worker's D1 database and is published as built: SQLite
semantics as D1 runs them, and no dialect switch.

## How to use it

Install the release tarball (the package is not on npm):

```sh
bun add https://github.com/curlewlabs-com/d1-typed-query/releases/download/v0.3.0/curlewlabs-com-d1-typed-query-0.3.0.tgz
```

The package ships TypeScript source, so the builder and the freezer run under a
runtime that loads TypeScript, such as Bun. The runtime entry is bundled into
your Worker like any other source.

**1. Declare your domains and tables** (a build-time module):

```ts
// schema.ts
import {
  SqliteScalars,
  defineTable,
  domain,
  nullable,
  refinement,
  type Brand,
} from "@curlewlabs-com/d1-typed-query";

export type MemberId = Brand<number, "MemberId">;
export type BookId = Brand<ArrayLike<number>, "BookId">;
export type Genre = "fiction" | "history" | "poetry";

declare module "@curlewlabs-com/d1-typed-query" {
  interface DomainRelations {
    storedUuid: BookId;
    refinements: [Genre, string];
  }
}

export const Library = Object.freeze({
  ...SqliteScalars,
  memberId: domain<MemberId>("MemberId", "integer"),
  bookId: domain<BookId>("BookId", "blob", { storedUuid: true }),
  genre: refinement<Genre, string>("Genre", SqliteScalars.text),
});

export const Books = defineTable("books", {
  id: Library.bookId,
  title: Library.text,
  genre: nullable(Library.text),
  published_at: Library.epochSeconds,
});

export const Loans = defineTable("loans", {
  book_id: Library.bookId,
  member_id: Library.memberId,
  due_at: Library.epochSeconds,
  returned_at: nullable(Library.epochSeconds),
});
```

**2. Author queries** (a build-time module):

```ts
// queries/loans.ts
import {
  addDuration,
  and,
  buildQuery,
  columnValue,
  compare,
  eqParam,
  isNull,
  leftJoin,
  project,
  scalarParam,
  select,
} from "@curlewlabs-com/d1-typed-query";
import { Books, Library, Loans } from "../schema";

const loan = leftJoin(Loans, "l", (l) =>
  and([
    compare(columnValue(l.book_id), "=", columnValue(Books.id)),
    isNull(l.returned_at),
  ]),
);

export const LOAN_QUERIES = {
  SHELF_WITH_DEADLINES: buildQuery(
    select({
      from: Books,
      joins: [loan],
      columns: [
        project(Books.title),
        project(
          addDuration(
            columnValue(loan.source.due_at),
            scalarParam(Library.seconds, "grace"),
          ),
          "deadline",
        ),
      ],
    }),
  ),
  LOANS_OF_MEMBER: buildQuery(
    select({
      from: Loans,
      columns: [project(Loans.book_id), project(Loans.due_at)],
      where: eqParam(Loans.member_id, "member"),
    }),
  ),
};
```

`LOANS_OF_MEMBER.bound({ member })` accepts only a `MemberId`. The
`SHELF_WITH_DEADLINES` row is
`{ title: string; deadline: EpochSeconds | null }`, nullable because the loan is
optional. Writing
`addDuration(columnValue(Loans.due_at), columnValue(Loans.due_at))` does not
compile, because an instant plus an instant is not a time.

**3. Freeze them** (a build step):

```ts
// scripts/freeze.ts
import { writeFileSync } from "node:fs";
import { freezeRegistry } from "@curlewlabs-com/d1-typed-query/freeze";
import { LOAN_QUERIES } from "../src/queries/loans";

writeFileSync(
  "src/generated/loans.ts",
  freezeRegistry({
    exportName: "LOAN_QUERIES",
    authoredModule: "../queries/loans",
    registry: LOAN_QUERIES,
  }),
);
```

The output holds the SQL text and bind names and nothing else:

```ts
import type { LOAN_QUERIES as Authored } from "../queries/loans";
import { precomputed } from "@curlewlabs-com/d1-typed-query/contract";
import type { GeneratedQuery } from "@curlewlabs-com/d1-typed-query/contract";

export const LOAN_QUERIES = {
  LOANS_OF_MEMBER: precomputed(
    "SELECT book_id, due_at FROM loans WHERE member_id = ?",
    ["member"],
  ) as GeneratedQuery<(typeof Authored)["LOANS_OF_MEMBER"]>,
  // ...
} as const;
```

**4. Run them** (the Worker):

```ts
import { lowerToD1 } from "@curlewlabs-com/d1-typed-query/runtime";
import { LOAN_QUERIES } from "./generated/loans";

const { results } = await lowerToD1(
  env.DB,
  LOAN_QUERIES.LOANS_OF_MEMBER.bound({ member }),
).all();
// results: { book_id: BookId; due_at: EpochSeconds }[]
```

`lowerToD1` takes a `D1Database` or a `D1DatabaseSession`. `batchD1` runs
several lowered statements in one D1 batch and types each result by its own
statement. A program that runs D1 queries has the D1 types from
`@cloudflare/workers-types`, and the runtime entry uses those ambient
declarations.

A program whose statements run through another handle (its own interface over
D1, or SQLite in its tests) uses the contract entry instead. A bound query is
its `sql` and its positional `params`, so the program prepares and binds it on
that handle itself:

```ts
import type { BoundQuery } from "@curlewlabs-com/d1-typed-query/contract";

function prepareBound(db: MyHandle, query: BoundQuery) {
  return db.prepare(query.sql).bind(...query.params);
}
```

## What ships at runtime

The runtime entry bundles to about 1.5 KB minified (`contract.ts`, `runtime.ts`
and `json-array.ts`; a test holds that list). At run time each query is its SQL
string, a frozen copy of its bind-name list made when the module loads, and the
cost of `bound()`: one array map, and a check of the given keys against the
query's bind names, held in a `Set` built the first time that query binds. The
check catches a missing or misspelled key in untyped input. No builder module,
schema or domain object is loaded. The contract entry is `contract.ts` alone
(also held by a test), and a frozen module's runtime import is that file.

## The inputs, and why each exists

1. **`domain<T>(name, storage, { storedUuid? })`**: your semantic domains.
   Without it a column could only take the generic SQLite domains, so no bind
   could be told apart from another of the same storage type. `storedUuid` marks
   a blob domain holding 16 random bytes, the only kind `randomBlob16()` and
   `storedUuidHex()` accept.
2. **`refinement<T, Base>(name, base)`**: a narrower domain whose values may be
   bound where `base` is read, such as a closed set of strings stored in a TEXT
   column. Without it, a bind could be no narrower than its column.
3. **`defineTable(name, domains)`**: your schema. Every column and source is
   minted in the package's one catalog. A structurally identical descriptor made
   anywhere else is refused, including by another `SchemaSourceCatalog`.
4. **`DomainRelations`** (declaration merging, as above): the type-level form of
   1 and 2. Once a value flows through an expression only its type survives, so
   TypeScript cannot read these relations from the domain objects. Plain
   subtyping would let a branded `number` into any `number` slot.
5. **`operation(operator, left, right, result)`** and
   **`conversion(from, to)`**: your own closed arithmetic, and declared
   reinterpretations that emit no SQL. Expression nodes are private by design,
   so without these there is no arithmetic on your domains. A declared `%` is
   nullable whatever its operands, since a zero divisor yields NULL. The
   package's own are the count operations and the time algebra (`addDuration`,
   `subtractDuration`, `betweenInstants`, `addSeconds`, `remainderSeconds`,
   `elapsedSinceUnixOrigin`).
6. **`freezeRegistry({ exportName, authoredModule, registry })`**: the generated
   module must name its export and import its authored types. You write the
   returned text wherever your build keeps generated files, under whatever
   notice it uses.

There are no modes and no configuration beyond these.

## Beside Kysely and Drizzle

Both are good, general query builders. The differences below are what was
checked, not a ranking.

- **Kysely** types columns from your `Database` interface, so branded column
  types work, and left-joined tables are nullable. It builds queries at run time
  and ships with your Worker. `compile()` returns positional SQL with the
  parameter _values_ in a list (`{ sql, parameters, query }`); its documentation
  describes no way to keep the SQL and fill named parameters later.
- **Drizzle** has prepared statements with named placeholders
  (`sql.placeholder("id")`, then `execute({ id })`). In drizzle-orm's source
  (`src/sql/sql.ts`), `Placeholder` is declared
  `Placeholder<TName extends string = string, TValue = any>` and
  `sql.placeholder(name)` sets no `TValue`, so a placeholder's value is not
  typed by the column it is compared with. The ORM ships with your Worker.
- **SQL-first generators** go the other way: you write SQL and its parameter and
  result types are inferred against the database. TypeSQL lists a D1 client.
  Their documentation describes types inferred from the schema, not domains you
  declare per column.

What this package does that those do not, as their documentation describes them:
binds typed by the declared domain of their column, a Worker that carries only
SQL strings and bind names, and arithmetic closed over your domains. You give up
generality for that. It covers SQLite as D1 runs it, it cannot express SQL its
constructors do not build (there is no raw-SQL escape), and its queries are
fixed at build time.

## Status and limits

Built and in use: everything above. The statement forms are:

- SELECT with inner, left, comma and cross joins;
- subqueries (scalar, `EXISTS`, `IN`), correlated through declared outer
  sources;
- CTEs (SELECT and VALUES, optionally `MATERIALIZED`) and derived sources;
- UNION and UNION ALL;
- INSERT ... SELECT with `ON CONFLICT DO NOTHING / DO UPDATE` over `excluded`,
  and `INSERT OR IGNORE`;
- UPDATE and DELETE;
- `RETURNING` of destination columns on INSERT, UPDATE and DELETE;
- `INDEXED BY`;
- bounded `json_each` list binds.

[docs/design.md](docs/design.md) is the construction model in full.

Limits:

- **UNION arms.** A compound SELECT is refused past five arms, because D1
  refuses six; SQLite's own default limit is 500.
- **Literals.** They are text, NULL or safe integers; a blob or a fraction
  enters as a bind. Text holding NUL or a lone surrogate is refused, in a
  literal or a `like()` pattern, because SQL text cannot carry it.
- **Names.** Every name is a plain identifier. One that is an
  [SQLite keyword](https://www.sqlite.org/lang_keywords.html) is written in
  square brackets (`[key]`), so a `key`, `order` or `current_time` column reads
  that column, and a source aliased `left` stays an alias. Brackets rather than
  double quotes, because SQLite reads a double-quoted name that matches no
  column as a string: a keyword column missing from the database fails to
  prepare instead. Every other name is written as given. No table, alias or CTE
  may be named `excluded`, the name an upsert's incoming row takes, which
  quoting cannot tell apart.
- **Functions.** The SQL functions are the closed set the constructors build
  (`COALESCE`, `MIN`, `MAX`, `COUNT`, `date`, `changes`, `hex`, `unhex`,
  `lower`, `trim`, `unixepoch`, `randomblob`).
- **Two declarations per relation.** `DomainRelations` and the runtime
  declarations it mirrors are written twice, and nothing checks that they agree.
- **Exact type comparisons.** The builder compares types exactly, so a program
  that names `EpochSeconds` or `Seconds` imports them from this package. A
  second declaration of the same shape is a different type to it.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

### Contribution

By submitting a contribution for inclusion in this project, you agree that it is
dual licensed as above, without any additional terms or conditions.
