// The execution contract a frozen registry is built from: a query declared
// once with a typed parameter shape and bound by name into a backend-neutral
// statement. It names no D1 type, so a program without Workers types (a build
// script, the builder) can load it.

// Makes a BoundQuery distinguishable from a D1PreparedStatement at run time
// (isBoundQuery) and keeps it opaque: callers only ever hand it to a lowering.
const BOUND_QUERY: unique symbol = Symbol("BoundQuery");

// The Query counterpart of BOUND_QUERY. A symbol rather than a structural
// `"sql" in v` check keeps registry membership unspoofable: a plain SQL string,
// a BoundQuery or a look-alike object is not a Query.
const QUERY: unique symbol = Symbol("Query");

// Compile-time only: no runtime object carries this key. It holds the row type
// the query's projection derives, so a lowering returns that row instead of one
// its caller names.
declare const ROW: unique symbol;

// A bound query, ready to execute and backend-neutral. `sql` is positional
// with `params` in placeholder order; a repeated name repeats its value.
export interface BoundQuery<R = unknown> {
  readonly [BOUND_QUERY]: true;
  readonly [ROW]?: R;
  readonly sql: string;
  readonly params: readonly unknown[];
}

// A query declared once with a typed parameter shape. `paramNames` is ordered
// with repetition, one name per placeholder in `sql`.
export interface Query<TParams extends Record<string, unknown>, R> {
  readonly [QUERY]: true;
  readonly sql: string;
  readonly paramNames: readonly string[];
  bound(params: TParams): BoundQuery<R>;
}

// Catches missing or misspelled keys even when untyped input reaches a bind;
// the compiler's checks cover typed input.
function assertParamNameAgreement(
  distinctNames: ReadonlySet<string>,
  params: Record<string, unknown>,
  sql: string,
): void {
  for (const name of distinctNames) {
    if (!(name in params)) {
      throw new Error(`bound: missing bind param ":${name}" for query: ${sql}`);
    }
  }
  for (const key of Object.keys(params)) {
    if (!distinctNames.has(key)) {
      throw new Error(
        `bound: param "${key}" has no matching ":${key}" in query: ${sql}`,
      );
    }
  }
}

// A frozen registry passes positional SQL and ordered parameter names
// together. Binding walks that order, including repeated names.
export function precomputed<TParams extends Record<string, unknown>, R>(
  sql: string,
  paramNames: readonly string[],
): Query<TParams, R> {
  // Built on first bind, not here. A registry constructs every query it holds
  // when its module loads, so building the set here would cost one Set per
  // query the running path never binds.
  let distinctNames: ReadonlySet<string> | undefined;
  return {
    [QUERY]: true,
    sql,
    paramNames,
    bound(params: TParams): BoundQuery<R> {
      distinctNames ??= new Set(paramNames);
      assertParamNameAgreement(distinctNames, params, sql);
      const values = paramNames.map(
        (name) => (params as Record<string, unknown>)[name],
      );
      return { [BOUND_QUERY]: true, sql, params: values };
    },
  };
}

// A D1PreparedStatement is an object too, so the symbol, not a structural
// check, is what distinguishes a BoundQuery from it.
export function isBoundQuery(value: unknown): value is BoundQuery {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [BOUND_QUERY]?: unknown })[BOUND_QUERY] === true
  );
}

// Narrows an arbitrary value to a Query, for code that collects registries and
// must refuse anything else. Parameter and row types are not recoverable here.
export function isQuery(
  value: unknown,
): value is Query<Record<string, unknown>, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [QUERY]?: unknown })[QUERY] === true
  );
}
