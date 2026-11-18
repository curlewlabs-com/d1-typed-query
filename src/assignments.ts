// Column assignments for INSERT and UPDATE construction.

// A destination column and its checked expression travel together through
// INSERT and UPDATE construction, preserving column/value order and preventing
// an assignment from inventing its own parameter type.

import type { EpochSeconds } from "./brand";
import type { BrandOf, ColumnReference, TableSource } from "./catalog";
import type { Parameterized, Requirements, RequirementsOf } from "./params";
import {
  assertAssignable,
  assertExpression,
  columnValue,
  literal,
  nowEpochSeconds,
  nullValue,
  param,
  uuidValue,
  type AnyExpression,
  type AssignableValue,
  type NullableColumn,
  type StoredUuidColumn,
} from "./expressions";
import { acceptsDomain } from "./scalars";

import { ReadScope } from "./sources";

const ASSIGNMENT: unique symbol = Symbol("SqlAssignment");
const INVALID_TARGET: unique symbol = Symbol("InvalidAssignmentTarget");
const assignments = new WeakSet<object>();

export interface Assignment<P extends Requirements> extends Parameterized<P> {
  readonly [ASSIGNMENT]: true;
  readonly column: ColumnReference;
  readonly value: AnyExpression;
  readonly sources: readonly TableSource[];
}
export type AnyAssignment = Assignment<Requirements>;

type EpochTarget<C extends ColumnReference> =
  NonNullable<BrandOf<C>> extends EpochSeconds
    ? unknown
    : { readonly [INVALID_TARGET]: "epoch column required" };
type IntegerTarget<C extends ColumnReference> =
  NonNullable<BrandOf<C>> extends number
    ? unknown
    : { readonly [INVALID_TARGET]: "integer column required" };
function assignment<E extends AnyExpression>(
  column: ColumnReference,
  value: E,
): Assignment<RequirementsOf<E>> {
  const destination = columnValue(column);
  assertExpression(value);
  if (!acceptsDomain(destination.domain, value.domain))
    throw new Error(
      "query-builder: assignment domain does not match its column",
    );
  const result: Assignment<RequirementsOf<E>> = Object.freeze({
    [ASSIGNMENT]: true as const,
    column,
    value,
    sources: Object.freeze([column.source, ...value.sources]),
    requirements: value.requirements,
  });
  assignments.add(result);
  return result;
}

function assertAssignment(value: AnyAssignment): void {
  if (!assignments.has(value))
    throw new Error("query-builder: assignment must come from a constructor");
}

export function setValue<C extends ColumnReference, E extends AnyExpression>(
  column: C,
  value: E & AssignableValue<C, NoInfer<E>>,
): Assignment<RequirementsOf<E>> {
  assertAssignable<C, E>(column, value);
  return assignment<E>(column, value);
}

export function setParam<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
): Assignment<readonly [readonly [Name, NonNullable<BrandOf<C>>]]> {
  return assignment(column, param(column, name));
}

export function setNull<C extends ColumnReference>(
  column: C & NullableColumn<NoInfer<C>>,
): Assignment<readonly []> {
  // nullValue's own check also protects this adapter when called from JavaScript.
  const value = nullValue<C>(column);
  return assignment(column, value);
}

export function setNow<C extends ColumnReference>(
  column: C & EpochTarget<NoInfer<C>>,
): Assignment<readonly []> {
  return assignment(column, nowEpochSeconds());
}

export function setLitInt<C extends ColumnReference>(
  column: C & IntegerTarget<NoInfer<C>>,
  value: NoInfer<NonNullable<BrandOf<C>>>,
): Assignment<readonly []> {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(
      "query-builder: integer assignment requires a safe integer",
    );
  return assignment(column, literal<C>(column, value));
}

export function litInt<C extends ColumnReference>(
  column: C & IntegerTarget<NoInfer<C>>,
  value: NoInfer<NonNullable<BrandOf<C>>>,
): Assignment<readonly []> {
  return setLitInt<C>(column, value);
}

export function randomBlob16<C extends ColumnReference>(
  column: C & StoredUuidColumn<NoInfer<C>>,
): Assignment<readonly []> {
  return assignment(column, uuidValue<C>(column));
}

export function checkedAssignments(
  values: readonly AnyAssignment[],
  source: TableSource,
  visible: readonly TableSource[],
): readonly AnyAssignment[] {
  if (values.length === 0)
    throw new Error("query-builder: mutation needs a destination column");
  const names = new Set<string>();
  for (const value of values) {
    assertAssignment(value);
    if (value.column.source !== source)
      throw new Error(
        "query-builder: assignment belongs to another target source",
      );
    const name = value.column.name.toLowerCase();
    if (names.has(name))
      throw new Error(
        `query-builder: duplicate assignment for "${value.column.name}"`,
      );
    names.add(name);
    ReadScope.assertVisible(value.value.sources, visible);
    if (value.value.hasAggregate)
      throw new Error(
        "query-builder: aggregate is not allowed in mutation values",
      );
  }
  return Object.freeze([...values]);
}
