// The runtime entry: binding by name into positional parameters, the name
// check that catches untyped input and the names it is built from, the D1
// lowering, the json_each bind mint and the values it refuses, and the
// property the package exists for - that a Worker importing ./runtime, or a
// frozen registry importing ./contract, bundles no builder module.

import { describe, expect, it } from "bun:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import {
  batchD1,
  isBoundQuery,
  isQuery,
  jsonArrayOf,
  lowerToD1,
  precomputed,
  type D1Handle,
} from "@curlewlabs-com/d1-typed-query/runtime";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("precomputed", () => {
  const query = precomputed<{ shelf: number; title: string }, { id: number }>(
    "SELECT id FROM books WHERE shelf = ? AND title = ? AND shelf > ?",
    ["shelf", "title", "shelf"],
  );

  it("binds each placeholder from its name, repeating a reused name", () => {
    const bound = query.bound({ shelf: 4, title: "Tides" });
    expect(bound.sql).toBe(query.sql);
    expect(bound.params).toEqual([4, "Tides", 4]);
    expect(isBoundQuery(bound)).toBe(true);
    expect(isQuery(query)).toBe(true);
  });

  // The typed signature stops these at compile time; the check is for values
  // that reach bound() without types, such as a parsed request body.
  it("refuses a missing or an extra key from untyped input", () => {
    const untyped = query as unknown as {
      bound(params: Record<string, unknown>): unknown;
    };
    expect(() => untyped.bound({ shelf: 4 })).toThrow(
      /missing bind param ":title"/,
    );
    expect(() => untyped.bound({ shelf: 4, title: "x", tilte: "x" })).toThrow(
      /param "tilte" has no matching/,
    );
  });

  // The name check's set is built on the first bind and binding reads the
  // names on every bind, so both must read one list the caller cannot change.
  it("keeps the names it was given when the caller's array changes", () => {
    const names = ["shelf"];
    const byShelf = precomputed<{ shelf: number }, unknown>(
      "SELECT id FROM books WHERE shelf = ?",
      names,
    );
    names[0] = "title";
    expect(byShelf.bound({ shelf: 4 }).params).toEqual([4]);
    names.push("title");
    expect(byShelf.bound({ shelf: 5 }).params).toEqual([5]);
    expect(byShelf.paramNames).toEqual(["shelf"]);
    expect(Object.isFrozen(byShelf.paramNames)).toBe(true);
  });

  it("tells a query from a look-alike object", () => {
    expect(isQuery({ sql: "SELECT 1", paramNames: [], bound() {} })).toBe(
      false,
    );
    expect(isBoundQuery({ sql: "SELECT 1", params: [] })).toBe(false);
  });
});

describe("D1 lowering", () => {
  // A recording stand-in for a D1 handle: enough to show what lowerToD1 and
  // batchD1 hand to D1, which is the whole of their behavior.
  function recordingHandle() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handle = {
      prepare(sql: string) {
        const statement = {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return statement;
          },
        };
        return statement;
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ results: [], success: true, meta: {} }));
      },
    } as unknown as D1Handle;
    return { handle, calls };
  }

  it("prepares the SQL and binds the positional parameters", async () => {
    const { handle, calls } = recordingHandle();
    const query = precomputed<{ id: number }, { title: string }>(
      "SELECT title FROM books WHERE id = ?",
      ["id"],
    );
    const lowered = lowerToD1(handle, query.bound({ id: 3 }));
    expect(calls).toEqual([
      { sql: "SELECT title FROM books WHERE id = ?", params: [3] },
    ]);
    const results = await batchD1(handle, [lowered, lowered]);
    expect(results).toHaveLength(2);
  });

  // Each position of a batch keeps its own statement's row, and a lowered
  // statement's rows are the query's, not a type argument the caller picks.
  it("types a heterogeneous batch by position", async () => {
    const { handle } = recordingHandle();
    const titles = precomputed<{ id: number }, { title: string }>(
      "SELECT title FROM books WHERE id = ?",
      ["id"],
    );
    const counts = precomputed<Record<string, never>, { n: number }>(
      "SELECT COUNT(*) AS n FROM books",
      [],
    );
    const [first, second] = await batchD1(handle, [
      lowerToD1(handle, titles.bound({ id: 1 })),
      lowerToD1(handle, counts.bound({})),
    ]);
    const titleRows: { title: string }[] = first.results;
    const countRows: { n: number }[] = second.results;
    // @ts-expect-error the second position holds counts, not titles
    const wrong: { title: string }[] = second.results;
    expect([titleRows, countRows, wrong]).toHaveLength(3);
    // @ts-expect-error the id is a number
    expect(() => titles.bound({ id: "1" })).not.toThrow();
  });
});

describe("jsonArrayOf", () => {
  it("encodes numbers and text as JSON and bytes as hex", () => {
    expect<string>(jsonArrayOf([1, 2], 3)).toBe("[1,2]");
    expect<string>(jsonArrayOf(["a"], 3)).toBe('["a"]');
    expect<string>(jsonArrayOf([new Uint8Array([0, 255])], 3)).toBe('["00ff"]');
  });

  // JSON.stringify would write each of these as null, and the source would
  // yield a NULL element that its non-null element domain says cannot occur.
  it("refuses NaN, an infinity and a missing element", () => {
    expect(() => jsonArrayOf([1, Number.NaN], 3)).toThrow(/element 1 is NaN/);
    expect(() => jsonArrayOf([Number.POSITIVE_INFINITY], 3)).toThrow(
      /element 0 is Infinity/,
    );
    expect(() => jsonArrayOf([Number.NEGATIVE_INFINITY], 3)).toThrow(
      /-Infinity/,
    );
    const holed: number[] = [1];
    holed[2] = 3;
    expect(() => jsonArrayOf(holed, 3)).toThrow(/element 1 is missing/);
  });

  // The declared maximum is what bounds the rows a json_each source walks, so a
  // longer list is refused rather than bound.
  it("refuses a list longer than its maximum", () => {
    expect(() => jsonArrayOf([1, 2, 3, 4], 3)).toThrow(/exceed/);
    // @ts-expect-error the maximum is a single numeric literal, not `number`
    expect(() => jsonArrayOf([1], 0 as number)).toThrow(/positive integer/);
  });
});

describe("runtime bundle", () => {
  // If the runtime entry reached a builder module, every Worker using frozen
  // queries would ship the builder again, which is what freezing removes.
  it("bundles from ./runtime without any builder module", async () => {
    const result = await build({
      entryPoints: [`${PACKAGE_ROOT}/src/runtime.ts`],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      minify: true,
    });
    const inputs = Object.keys(result.metafile.inputs).map((path) =>
      path.replace(/^(.*\/)?src\//, ""),
    );
    expect(inputs.sort()).toEqual([
      "contract.ts",
      "json-array.ts",
      "runtime.ts",
    ]);
  });

  // Every frozen module imports ./contract, so whatever it reaches loads
  // wherever a frozen registry does, a program without D1 included.
  it("bundles from ./contract with nothing but the contract", async () => {
    const result = await build({
      entryPoints: [`${PACKAGE_ROOT}/src/contract.ts`],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      minify: true,
    });
    const inputs = Object.keys(result.metafile.inputs).map((path) =>
      path.replace(/^(.*\/)?src\//, ""),
    );
    expect(inputs).toEqual(["contract.ts"]);
  });
});
