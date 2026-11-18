// Projection names and expression types define a statement's result columns.
// Names are checked here before later subquery and CTE consumers derive a row.

import type { BrandOf, ColumnReference, TableSource } from "./catalog";
import type { ScalarDomain } from "./scalars";
import type { Parameterized, Requirements, RequirementsOf } from "./params";
import { isColumn } from "./catalog";
import {
  assertExpression,
  columnValue,
  type AnyExpression,
  type Expression,
  type ExpressionValue,
} from "./expressions";
import { assertSqlIdentifier } from "./identifiers";

const PROJECTION: unique symbol = Symbol("SqlProjection");
const OUTPUT: unique symbol = Symbol("ProjectionValue");
const projections = new WeakSet<object>();

export interface Projection<
  Name extends string | null,
  T,
  P extends Requirements,
> extends Parameterized<P> {
  readonly [PROJECTION]: true;
  readonly [OUTPUT]?: T;
  readonly name: Name;
  readonly alias: string | null;
  readonly value: AnyExpression;
  readonly sources: readonly TableSource[];
}
export type AnyProjection = Projection<string | null, unknown, Requirements>;
type ProjectionValue<P> =
  P extends Projection<string | null, infer T, Requirements> ? T : never;
export type ProjectionRow<P extends readonly AnyProjection[]> = {
  [Item in P[number] as Extract<Item["name"], string>]: ProjectionValue<Item>;
};

export interface OutputColumn<Name extends string | null, T> {
  readonly [OUTPUT]?: T;
  readonly name: Name;
  readonly domain: ScalarDomain;
}
export type AnyOutputColumn = OutputColumn<string | null, unknown>;
export type OutputValue<O> =
  O extends OutputColumn<string | null, infer T> ? T : never;
export type ProjectionOutputs<C extends readonly AnyProjection[]> = {
  readonly [K in keyof C]: OutputColumn<C[K]["name"], ProjectionValue<C[K]>>;
};
export type OutputRow<O extends readonly AnyOutputColumn[]> = {
  [Item in O[number] as Extract<Item["name"], string>]: OutputValue<Item>;
};

export type ColumnOutputs<C extends readonly ColumnReference[]> = {
  readonly [K in keyof C]: OutputColumn<C[K]["name"], BrandOf<C[K]>>;
};
export type ColumnRow<C extends readonly ColumnReference[]> = {
  [Item in C[number] as Item["name"]]: BrandOf<Item>;
};

export function columnOutputs<C extends readonly ColumnReference[]>(
  columns: C,
): ColumnOutputs<C> {
  return Object.freeze(
    columns.map((column) => {
      if (!isColumn(column))
        throw new Error("query-builder: output must be a schema column");
      return Object.freeze({ name: column.name, domain: column.domain });
    }),
  ) as ColumnOutputs<C>;
}

export function projectionOutputs<C extends readonly AnyProjection[]>(
  columns: C,
): ProjectionOutputs<C> {
  return Object.freeze(
    columns.map((column) => {
      assertProjection(column);
      return Object.freeze({ name: column.name, domain: column.value.domain });
    }),
  ) as ProjectionOutputs<C>;
}

export function project<C extends ColumnReference>(
  column: C,
): Projection<C["name"], BrandOf<C>, readonly []>;
export function project<E extends AnyExpression>(
  value: E,
): Projection<null, ExpressionValue<E>, RequirementsOf<E>>;
export function project<E extends AnyExpression, const Name extends string>(
  value: E,
  alias: Name,
): Projection<Name, ExpressionValue<E>, RequirementsOf<E>>;
export function project(
  value: ColumnReference | AnyExpression,
  alias?: string,
): AnyProjection {
  const column = isColumn(value) ? value : null;
  const expression =
    column === null ? (value as AnyExpression) : columnValue(column);
  assertExpression(expression);
  const name = alias ?? column?.name ?? null;
  if (name !== null) assertSqlIdentifier(name, "projection alias");
  const result: AnyProjection = Object.freeze({
    [PROJECTION]: true as const,
    name,
    alias: alias ?? null,
    value: expression,
    sources: expression.sources,
    requirements: expression.requirements,
  });
  projections.add(result);
  return result;
}

export function assertProjection(value: AnyProjection): void {
  if (!projections.has(value))
    throw new Error("query-builder: projection must come from a constructor");
}

const ORDER: unique symbol = Symbol("SqlOrder");
const orders = new WeakSet<object>();
export interface Order<P extends Requirements> extends Parameterized<P> {
  readonly [ORDER]: true;
  readonly tree:
    | { readonly kind: "expression"; readonly value: AnyExpression }
    | {
        readonly kind: "projection";
        readonly projection: Projection<string, unknown, Requirements>;
        readonly isNotNull: boolean;
      };
  readonly direction: "ASC" | "DESC" | null;
  readonly sources: readonly TableSource[];
}
export type AnyOrder = Order<Requirements>;

export function orderBy<C extends ColumnReference>(
  column: C,
  direction?: "ASC" | "DESC",
): Order<readonly []>;
export function orderBy<E extends AnyExpression>(
  value: E,
  direction?: "ASC" | "DESC",
): Order<RequirementsOf<E>>;
export function orderBy(
  value: ColumnReference | AnyExpression,
  direction?: "ASC" | "DESC",
): AnyOrder {
  const expression = isColumn(value) ? columnValue(value) : value;
  assertExpression(expression);
  if (direction !== undefined && direction !== "ASC" && direction !== "DESC")
    throw new Error("query-builder: invalid order direction");
  const result: AnyOrder = Object.freeze({
    [ORDER]: true as const,
    tree: Object.freeze({ kind: "expression" as const, value: expression }),
    direction: direction ?? null,
    sources: expression.sources,
    requirements: expression.requirements,
  });
  orders.add(result);
  return result;
}

function projectionOrder(
  projection: Projection<string, unknown, Requirements>,
  isNotNull: boolean,
  direction?: "ASC" | "DESC",
): Order<readonly []> {
  assertProjection(projection);
  if (projection.name === null)
    throw new Error("query-builder: ordering needs a named projection");
  if (direction !== undefined && direction !== "ASC" && direction !== "DESC")
    throw new Error("query-builder: invalid order direction");
  const result: Order<readonly []> = Object.freeze({
    [ORDER]: true as const,
    tree: Object.freeze({ kind: "projection" as const, projection, isNotNull }),
    direction: direction ?? null,
    sources: Object.freeze([]),
    requirements: Object.freeze([]),
  });
  orders.add(result);
  return result;
}

export function orderByProjection(
  projection: Projection<string, unknown, Requirements>,
  direction?: "ASC" | "DESC",
): Order<readonly []> {
  return projectionOrder(projection, false, direction);
}

export function orderByProjectionIsNotNull(
  projection: Projection<string, unknown, Requirements>,
  direction?: "ASC" | "DESC",
): Order<readonly []> {
  return projectionOrder(projection, true, direction);
}

export function assertOrder(value: AnyOrder): void {
  if (!orders.has(value))
    throw new Error("query-builder: order must come from a constructor");
}

export type LimitExpression = Expression<number, Requirements>;
