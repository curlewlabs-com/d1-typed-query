// The runtime entry point: the execution contract a frozen registry is built
// from (contract.ts, also an entry point of its own), and its lowering onto
// D1. This is the part of the package a deployed Worker loads, so it imports
// no builder module.
//
// A query is declared once with a typed parameter shape, bound by name, and
// lowered to a D1 statement whose rows have the type the query's projection
// derived. Passing a value whose type does not match a parameter's is a
// compile error at the call site.
//
// The D1 types (D1PreparedStatement, D1Result) are the ambient ones
// @cloudflare/workers-types declares, which every program that runs D1 queries
// already has.

export type { Brand, EpochSeconds, Seconds } from "./brand";
export {
  jsonArrayOf,
  type JsonArrayOf,
  type NumericLiteral,
} from "./json-array";
export {
  precomputed,
  isBoundQuery,
  isQuery,
  type BoundQuery,
  type GeneratedQuery,
  type Query,
} from "./contract";
import type { BoundQuery, Query } from "./contract";

// Compile-time only, as contract.ts's own: it carries a lowered statement's row.
declare const ROW: unique symbol;

// A BoundQuery lowered onto D1. D1's own run/all accept any row type argument,
// so this view exposes only the forms that return the projection's row. At run
// time it is the D1PreparedStatement lowerToD1 prepared.
export interface D1Query<R> {
  readonly [ROW]?: R;
  run(): Promise<D1Result<R>>;
  all(): Promise<D1Result<R>>;
  first(): Promise<R | null>;
}

// The row a query, bound query or lowered statement yields, for naming a
// registry entry's row as QueryRow<(typeof REGISTRY)["KEY"]>. A raw
// D1PreparedStatement has no projection, so its rows stay `unknown` for the
// caller to narrow.
export type QueryRow<S> =
  S extends BoundQuery<infer R>
    ? R
    : S extends D1PreparedStatement
      ? unknown
      : S extends D1Query<infer R>
        ? R
        : S extends Query<never, infer R>
          ? R
          : unknown;

// Positional, so a heterogeneous batch keeps each statement's own row.
export type BatchResults<S extends readonly unknown[]> = {
  -readonly [K in keyof S]: D1Result<QueryRow<S[K]>>;
};

// What lowerToD1 and batchD1 need from a D1 handle. A D1Database and a
// D1DatabaseSession each satisfy it.
export interface D1Handle {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

// The one place a BoundQuery becomes a D1 statement.
export function lowerToD1<R>(db: D1Handle, query: BoundQuery<R>): D1Query<R> {
  return db.prepare(query.sql).bind(...query.params);
}

// The D1PreparedStatement a D1Query views, for D1's own batch.
export function d1Statement(
  query: D1Query<unknown> | D1PreparedStatement,
): D1PreparedStatement {
  return query as D1PreparedStatement;
}

// D1's batch with each result typed by its own statement's row.
export async function batchD1<const S extends readonly D1Query<unknown>[]>(
  db: D1Handle,
  stmts: S,
): Promise<BatchResults<S>> {
  return (await db.batch(stmts.map(d1Statement))) as BatchResults<S>;
}
