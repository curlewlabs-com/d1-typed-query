// Predicate construction owns comparison, null checks, and boolean composition.
// Its nominal registry admits only checked expression operands; value-domain
// construction remains with the expressions those predicates consume.

import type { BrandOf, ColumnReference, TableSource } from "./catalog";
import {
  assertExpression,
  columnValue,
  param,
  literal,
  type AnyExpression,
  type ExpressionValue,
  type CompatibleValue,
} from "./expressions";
import { acceptsDomain, nonNullableDomain } from "./scalars";
import { assertLiteralText } from "./literal-text";
import {
  collectRequirements,
  type CollectRequirements,
  type CompatibleRequirements,
  type Parameterized,
  type Requirements,
  type RuntimeRequirement,
  type RequirementsOf,
} from "./params";
import {
  assertSelect,
  assertSingleSelect,
  type AnySelect,
  type SingleSelect,
} from "./statements";
import type { OutputValue } from "./projections";

const PREDICATE: unique symbol = Symbol("SqlPredicate");
const predicateNodes = new WeakSet<object>();

export type Comparison = "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=" | "IS NOT";
type PredicateTree =
  | {
      readonly kind: "exists";
      readonly query: AnySelect;
      readonly negate: boolean;
    }
  | {
      readonly kind: "in-query";
      readonly value: AnyExpression;
      readonly query: SingleSelect;
    }
  | {
      readonly kind: "in-values";
      readonly value: AnyExpression;
      readonly values: readonly AnyExpression[];
    }
  | {
      readonly kind: "like";
      readonly value: AnyExpression;
      readonly pattern: string;
      readonly negate: boolean;
    }
  | {
      readonly kind: "comparison";
      readonly left: AnyExpression;
      readonly operator: Comparison;
      readonly right: AnyExpression;
    }
  | {
      readonly kind: "null-check";
      readonly expression: AnyExpression;
      readonly negate: boolean;
    }
  | {
      readonly kind: "junction";
      readonly operator: "AND" | "OR";
      readonly predicates: readonly AnyPredicate[];
    }
  | {
      readonly kind: "group";
      readonly predicate: AnyPredicate;
      readonly negate: boolean;
    };

interface PredicateBase {
  readonly [PREDICATE]: true;
  readonly tree: PredicateTree;
  readonly sources: readonly TableSource[];
  readonly hasAggregate: boolean;
}
export interface Predicate<P extends Requirements>
  extends PredicateBase, Parameterized<P> {}
export type AnyPredicate = PredicateBase & Parameterized<Requirements>;

function predicateHasAggregate(tree: PredicateTree): boolean {
  switch (tree.kind) {
    case "comparison":
      return tree.left.hasAggregate || tree.right.hasAggregate;
    case "null-check":
      return tree.expression.hasAggregate;
    case "junction":
      return tree.predicates.some((item) => item.hasAggregate);
    case "group":
      return tree.predicate.hasAggregate;
    case "exists":
      return false;
    case "in-values":
      return (
        tree.value.hasAggregate ||
        tree.values.some((value) => value.hasAggregate)
      );
    case "in-query":
    case "like":
      return tree.value.hasAggregate;
  }
}

function predicate<P extends Requirements>(
  tree: PredicateTree,
  sources: readonly TableSource[],
  requirements: readonly RuntimeRequirement[],
): Predicate<P> {
  const result: Predicate<P> = Object.freeze({
    [PREDICATE]: true as const,
    tree: Object.freeze(tree),
    hasAggregate: predicateHasAggregate(tree),
    sources: Object.freeze([...sources]),
    requirements: Object.freeze([...requirements]),
  });
  predicateNodes.add(result);
  return result;
}

export function assertPredicate(value: AnyPredicate): void {
  if (!predicateNodes.has(value))
    throw new Error("query-builder: predicate must come from a constructor");
}

export function compare<L extends AnyExpression, R extends AnyExpression>(
  left: L,
  operator: Comparison,
  right: R &
    CompatibleValue<
      NonNullable<ExpressionValue<L>>,
      NonNullable<ExpressionValue<NoInfer<R>>>
    > &
    CompatibleRequirements<
      CollectRequirements<readonly [NoInfer<L>, NoInfer<R>]>
    >,
): Predicate<CollectRequirements<readonly [L, R]>> {
  assertExpression(left);
  assertExpression(right);
  if (!["=", "!=", "<>", "<", "<=", ">", ">=", "IS NOT"].includes(operator))
    throw new Error("query-builder: invalid comparison operator");
  if (
    !acceptsDomain(
      nonNullableDomain(left.domain),
      nonNullableDomain(right.domain),
    )
  ) {
    throw new Error(
      "query-builder: comparison operands have incompatible domains",
    );
  }
  return predicate(
    { kind: "comparison", left, operator, right },
    [...left.sources, ...right.sources],
    collectRequirements([left, right]),
  );
}

function columnComparison<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
  operator: Comparison,
): Predicate<readonly [readonly [Name, NonNullable<BrandOf<C>>]]> {
  const left = columnValue(column);
  const right = param(column, name);
  return predicate(
    { kind: "comparison", left, operator, right },
    left.sources,
    right.requirements,
  );
}

export function eqParam<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
) {
  return columnComparison(column, name, "=");
}
export function ne<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
) {
  return columnComparison(column, name, "!=");
}
export function lte<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
) {
  return columnComparison(column, name, "<=");
}
export function gt<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
) {
  return columnComparison(column, name, ">");
}
export function gte<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
) {
  return columnComparison(column, name, ">=");
}

export function equalsConstant<C extends ColumnReference>(
  column: C,
  value: NoInfer<NonNullable<BrandOf<C>>>,
): Predicate<readonly []> {
  const left = columnValue(column);
  const right = literal(column, value);
  return predicate(
    { kind: "comparison", left, operator: "=", right },
    left.sources,
    [],
  );
}

export function isNull<C extends ColumnReference>(
  column: C,
): Predicate<readonly []> {
  const value = columnValue(column);
  return predicate(
    { kind: "null-check", expression: value, negate: false },
    value.sources,
    [],
  );
}
export function isNotNull<C extends ColumnReference>(
  column: C,
): Predicate<readonly []> {
  const value = columnValue(column);
  return predicate(
    { kind: "null-check", expression: value, negate: true },
    value.sources,
    [],
  );
}

export function isNullValue<E extends AnyExpression>(
  value: E,
): Predicate<RequirementsOf<E>> {
  assertExpression(value);
  return predicate(
    { kind: "null-check", expression: value, negate: false },
    value.sources,
    value.requirements,
  );
}
export function isNotNullValue<E extends AnyExpression>(
  value: E,
): Predicate<RequirementsOf<E>> {
  assertExpression(value);
  return predicate(
    { kind: "null-check", expression: value, negate: true },
    value.sources,
    value.requirements,
  );
}

function junction<P extends readonly AnyPredicate[]>(
  operator: "AND" | "OR",
  predicates: P,
): Predicate<CollectRequirements<P>> {
  if (predicates.length === 0)
    throw new Error("query-builder: empty predicate junction");
  for (const item of predicates) assertPredicate(item);
  return predicate(
    { kind: "junction", operator, predicates: Object.freeze([...predicates]) },
    predicates.flatMap((item) => item.sources),
    collectRequirements(predicates),
  );
}

export function and<const P extends readonly AnyPredicate[]>(
  predicates: P & CompatibleRequirements<CollectRequirements<NoInfer<P>>>,
): Predicate<CollectRequirements<P>> {
  return junction<P>("AND", predicates);
}
export function or<const P extends readonly AnyPredicate[]>(
  predicates: P & CompatibleRequirements<CollectRequirements<NoInfer<P>>>,
): Predicate<CollectRequirements<P>> {
  return junction<P>("OR", predicates);
}
export function group<P extends Requirements>(
  value: Predicate<P>,
): Predicate<P> {
  assertPredicate(value);
  return predicate(
    { kind: "group", predicate: value, negate: false },
    value.sources,
    value.requirements,
  );
}

export function not<P extends Requirements>(value: Predicate<P>): Predicate<P> {
  assertPredicate(value);
  return predicate(
    { kind: "group", predicate: value, negate: true },
    value.sources,
    value.requirements,
  );
}

export function exists<S extends AnySelect>(
  query: S,
): Predicate<RequirementsOf<S>> {
  assertSelect(query);
  return predicate(
    { kind: "exists", query, negate: false },
    query.sources,
    query.requirements,
  );
}

export function notExists<S extends AnySelect>(
  query: S,
): Predicate<RequirementsOf<S>> {
  assertSelect(query);
  return predicate(
    { kind: "exists", query, negate: true },
    query.sources,
    query.requirements,
  );
}

export function inSubquery<E extends AnyExpression, S extends SingleSelect>(
  value: E,
  query: S &
    CompatibleValue<
      NonNullable<ExpressionValue<NoInfer<E>>>,
      NonNullable<OutputValue<NoInfer<S>["outputs"][0]>>
    > &
    CompatibleRequirements<
      CollectRequirements<readonly [NoInfer<E>, NoInfer<S>]>
    >,
): Predicate<CollectRequirements<readonly [E, S]>> {
  assertExpression(value);
  assertSingleSelect(query);
  if (
    !acceptsDomain(
      nonNullableDomain(value.domain),
      nonNullableDomain(query.outputs[0].domain),
    )
  )
    throw new Error("query-builder: IN subquery has an incompatible domain");
  return predicate(
    { kind: "in-query", value, query },
    [...value.sources, ...query.sources],
    collectRequirements([value, query]),
  );
}

type InRequirements<
  E extends AnyExpression,
  V extends readonly AnyExpression[],
> = CollectRequirements<readonly [E, ...V]>;
type ComparableValues<
  E extends AnyExpression,
  V extends readonly AnyExpression[],
> = {
  readonly [K in keyof V]: V[K] &
    CompatibleValue<
      NonNullable<ExpressionValue<E>>,
      NonNullable<ExpressionValue<V[K]>>
    >;
};

export function inValues<
  E extends AnyExpression,
  const V extends readonly [AnyExpression, ...AnyExpression[]],
>(
  value: E,
  values: V &
    ComparableValues<NoInfer<E>, NoInfer<V>> &
    CompatibleRequirements<NoInfer<InRequirements<E, V>>>,
): Predicate<InRequirements<E, V>> {
  assertExpression(value);
  if (values.length === 0)
    throw new Error("query-builder: IN requires a nonempty value list");
  for (const item of values) {
    assertExpression(item);
    if (
      !acceptsDomain(
        nonNullableDomain(value.domain),
        nonNullableDomain(item.domain),
      )
    )
      throw new Error("query-builder: IN operands have incompatible domains");
  }
  return predicate(
    { kind: "in-values", value, values: Object.freeze([...values]) },
    [value, ...values].flatMap((item) => item.sources),
    collectRequirements([value, ...values]),
  );
}

export function inConstants<C extends ColumnReference>(
  column: C,
  values: readonly NoInfer<NonNullable<BrandOf<C>>>[],
): Predicate<readonly []> {
  if (values.length === 0)
    throw new Error("query-builder: IN requires a nonempty constant list");
  const value = columnValue(column);
  const constants = Object.freeze(values.map((item) => literal(column, item)));
  return predicate(
    { kind: "in-values", value, values: constants },
    value.sources,
    [],
  );
}

export function like<C extends ColumnReference>(
  column: C &
    (NonNullable<BrandOf<NoInfer<C>>> extends string ? unknown : never),
  pattern: string,
  negate = false,
): Predicate<readonly []> {
  const value = columnValue(column);
  if (value.domain.storage !== "text")
    throw new Error("query-builder: LIKE requires a text column");
  assertLiteralText(pattern, "LIKE pattern");
  return predicate({ kind: "like", value, pattern, negate }, value.sources, []);
}
