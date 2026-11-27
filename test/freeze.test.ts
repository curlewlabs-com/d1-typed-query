// The freezer: what it writes for an authored registry, that what it writes
// runs and keeps the authored SQL, and the registry shapes it refuses.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildQuery,
  eqParam,
  project,
  select,
} from "@curlewlabs-com/d1-typed-query";
import { freezeRegistry } from "@curlewlabs-com/d1-typed-query/freeze";
import {
  precomputed,
  type GeneratedQuery,
  type QueryRow,
} from "@curlewlabs-com/d1-typed-query/runtime";
import { Books, type Isbn } from "./library-schema";

const CATALOG_QUERIES = {
  BOOK_BY_ISBN: buildQuery(
    select({
      from: Books,
      columns: [project(Books.title)],
      where: eqParam(Books.isbn, "isbn"),
    }),
  ),
};

describe("freezeRegistry", () => {
  it("writes precomputed SQL typed by the authored module", () => {
    expect(
      freezeRegistry({
        exportName: "CATALOG_QUERIES",
        authoredModule: "../queries/catalog",
        registry: CATALOG_QUERIES,
      }),
    )
      .toBe(`import type { CATALOG_QUERIES as Authored } from "../queries/catalog";
import { precomputed } from "@curlewlabs-com/d1-typed-query/contract";
import type { GeneratedQuery } from "@curlewlabs-com/d1-typed-query/contract";

export const CATALOG_QUERIES = {
  BOOK_BY_ISBN: precomputed(
    "SELECT title FROM books WHERE isbn = ?",
    ["isbn"],
  ) as GeneratedQuery<(typeof Authored)["BOOK_BY_ISBN"]>,
} as const;
`);
  });

  // The frozen module is what a Worker loads, so it must evaluate on its own
  // and carry the authored SQL and bind order byte for byte.
  it("writes a module that evaluates to the same SQL and bind order", async () => {
    // Inside the package, so the module's import of the package by name
    // resolves as it does in an application.
    const cache = fileURLToPath(
      new URL("../node_modules/.cache", import.meta.url),
    );
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(join(cache, "freeze-"));
    try {
      const path = join(dir, "catalog.ts");
      writeFileSync(
        path,
        freezeRegistry({
          exportName: "CATALOG_QUERIES",
          authoredModule: "./authored",
          registry: CATALOG_QUERIES,
        }),
      );
      // The authored import is type-only, so the module needs no ./authored.
      const frozen = (await import(pathToFileURL(path).href)) as {
        CATALOG_QUERIES: typeof CATALOG_QUERIES;
      };
      const query = frozen.CATALOG_QUERIES.BOOK_BY_ISBN;
      expect(query.sql).toBe(CATALOG_QUERIES.BOOK_BY_ISBN.sql);
      expect(query.paramNames).toEqual(CATALOG_QUERIES.BOOK_BY_ISBN.paramNames);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The frozen entry's type is GeneratedQuery of its authored entry: the bind
  // and row types survive without the builder, and nothing else does.
  it("keeps the authored bind and row types in the frozen entry", () => {
    type Frozen = GeneratedQuery<(typeof CATALOG_QUERIES)["BOOK_BY_ISBN"]>;
    const frozen: Frozen = precomputed(
      CATALOG_QUERIES.BOOK_BY_ISBN.sql,
      CATALOG_QUERIES.BOOK_BY_ISBN.paramNames,
    );
    const _bound = frozen.bound({ isbn: "111" as Isbn });
    // @ts-expect-error the bind keeps its Isbn type
    frozen.bound({ isbn: "111" });
    const row: QueryRow<typeof _bound> = { title: "Engines" };
    // @ts-expect-error the row keeps its projection: there is no pages column
    const wrong: QueryRow<typeof _bound> = { title: "Engines", pages: 1 };
    // @ts-expect-error the authored query's build-time fields do not survive
    expect(frozen.jsonEachSources).toBeUndefined();
    expect([row, wrong]).toHaveLength(2);
  });

  it("refuses an entry that is not a query, and keys it cannot write", () => {
    expect(() =>
      freezeRegistry({
        exportName: "CATALOG_QUERIES",
        authoredModule: "./authored",
        registry: { BROKEN: { sql: "SELECT 1", paramNames: [1] } },
      }),
    ).toThrow(/CATALOG_QUERIES.BROKEN is not a Query/);
    expect(() =>
      freezeRegistry({
        exportName: "CATALOG_QUERIES",
        authoredModule: "./authored",
        registry: { "not-a-key": CATALOG_QUERIES.BOOK_BY_ISBN },
      }),
    ).toThrow(/not an identifier key/);
    // The module declares `precomputed` itself, and `class` cannot name a
    // const: either would produce a module that does not load.
    for (const exportName of ["catalog queries", "precomputed", "class"])
      expect(() =>
        freezeRegistry({
          exportName,
          authoredModule: "./authored",
          registry: CATALOG_QUERIES,
        }),
      ).toThrow(/cannot name the frozen registry/);
    // An object literal reads `__proto__:` as the prototype, not as an entry.
    const withProto = Object.defineProperty({}, "__proto__", {
      value: CATALOG_QUERIES.BOOK_BY_ISBN,
      enumerable: true,
    });
    expect(() =>
      freezeRegistry({
        exportName: "CATALOG_QUERIES",
        authoredModule: "./authored",
        registry: withProto,
      }),
    ).toThrow(/not an identifier key/);
    expect(() =>
      freezeRegistry({
        exportName: "CATALOG_QUERIES",
        authoredModule: "./authored",
        registry: null,
      }),
    ).toThrow(/is not an object/);
  });
});
