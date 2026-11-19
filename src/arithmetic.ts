// Closed dimensional arithmetic for build-time query values: the count and
// time operations, and the two declarations an application closes its own
// arithmetic with. Each operation fixes its operand and result domains; private
// construction keeps a caller from choosing an unrelated output domain for the
// same SQL operator.

import type { EpochSeconds, Seconds } from "./brand";
import {
  assertExpression,
  type AnyExpression,
  type Expression,
  type ExpressionTree,
  type ExpressionValue,
} from "./expressions";
import {
  SqliteScalars,
  assertDomain,
  nullable,
  nonNullableDomain,
  type ScalarDomain,
  type Domain,
} from "./scalars";
import {
  collectRequirements,
  type CollectRequirements,
  type CompatibleRequirements,
  type Requirements,
  type RequirementsOf,
} from "./params";

const ARITHMETIC: unique symbol = Symbol("ArithmeticExpression");
const arithmeticNodes = new WeakSet();
export interface ArithmeticIdentity {
  readonly [ARITHMETIC]: true;
}

export function isArithmeticExpression(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && arithmeticNodes.has(value)
  );
}

export type ArithmeticOperator = "+" | "-" | "|" | "*" | "%";
const OPERATORS: ReadonlySet<string> = new Set(["+", "-", "|", "*", "%"]);

type PairRequirements<
  L extends AnyExpression,
  R extends AnyExpression,
> = CollectRequirements<readonly [L, R]>;

function binary<T, L extends AnyExpression, R extends AnyExpression>(
  operator: ArithmeticOperator,
  left: L,
  right: R,
  leftDomain: ScalarDomain,
  rightDomain: ScalarDomain,
  resultDomain: Domain<T>,
): Expression<T, PairRequirements<L, R>> {
  assertExpression(left);
  assertExpression(right);
  if (left.domain !== leftDomain || right.domain !== rightDomain)
    throw new Error(
      "query-builder: arithmetic operands have incompatible domains",
    );
  return arithmetic({ kind: "binary", operator, left, right }, resultDomain, [
    left,
    right,
  ]);
}

function arithmetic<T, const O extends readonly AnyExpression[]>(
  tree: ExpressionTree,
  domain: Domain<T>,
  operands: O,
): Expression<T, CollectRequirements<O>> {
  const result: Expression<T, CollectRequirements<O>> = Object.freeze({
    [ARITHMETIC]: true as const,
    tree: Object.freeze(tree),
    domain,
    hasAggregate: operands.some((value) => value.hasAggregate),
    sources: Object.freeze(operands.flatMap((value) => value.sources)),
    requirements: Object.freeze([...collectRequirements(operands)]),
  });
  arithmeticNodes.add(result);
  return result;
}

export function addCount<
  L extends Expression<number, Requirements>,
  R extends Expression<number, Requirements>,
>(
  left: L,
  right: R & CompatibleRequirements<PairRequirements<NoInfer<L>, NoInfer<R>>>,
) {
  return binary(
    "+",
    left,
    right,
    SqliteScalars.count,
    SqliteScalars.count,
    SqliteScalars.count,
  );
}
// The caller bounds the result: a count column's CHECK rejects a negative.
export function subtractCount<
  L extends Expression<number, Requirements>,
  R extends Expression<number, Requirements>,
>(
  left: L,
  right: R & CompatibleRequirements<PairRequirements<NoInfer<L>, NoInfer<R>>>,
) {
  return binary(
    "-",
    left,
    right,
    SqliteScalars.count,
    SqliteScalars.count,
    SqliteScalars.count,
  );
}
export function addDuration<
  L extends NullableExpression<EpochSeconds>,
  R extends NullableExpression<Seconds>,
>(
  left: L,
  right: R & CompatibleRequirements<PairRequirements<NoInfer<L>, NoInfer<R>>>,
): Expression<NullableResult<EpochSeconds, L | R>, PairRequirements<L, R>> {
  return binary(
    "+",
    left,
    right,
    checkedDomain(left, SqliteScalars.epochSeconds),
    checkedDomain(right, SqliteScalars.seconds),
    propagatedDomain<EpochSeconds, L | R>(
      SqliteScalars.epochSeconds,
      left,
      right,
    ),
  );
}
export function subtractDuration<
  L extends NullableExpression<EpochSeconds>,
  R extends NullableExpression<Seconds>,
>(
  left: L,
  right: R & CompatibleRequirements<PairRequirements<NoInfer<L>, NoInfer<R>>>,
): Expression<NullableResult<EpochSeconds, L | R>, PairRequirements<L, R>> {
  return binary(
    "-",
    left,
    right,
    checkedDomain(left, SqliteScalars.epochSeconds),
    checkedDomain(right, SqliteScalars.seconds),
    propagatedDomain<EpochSeconds, L | R>(
      SqliteScalars.epochSeconds,
      left,
      right,
    ),
  );
}
export function betweenInstants<
  L extends NullableExpression<EpochSeconds>,
  R extends NullableExpression<EpochSeconds>,
>(
  left: L,
  right: R & CompatibleRequirements<PairRequirements<NoInfer<L>, NoInfer<R>>>,
): Expression<NullableResult<Seconds, L | R>, PairRequirements<L, R>> {
  return binary(
    "-",
    left,
    right,
    checkedDomain(left, SqliteScalars.epochSeconds),
    checkedDomain(right, SqliteScalars.epochSeconds),
    propagatedDomain<Seconds, L | R>(SqliteScalars.seconds, left, right),
  );
}

export type NullableExpression<T> =
  Expression<T, Requirements> | Expression<T | null, Requirements>;
export type NullableResult<T, E> =
  null extends ExpressionValue<E> ? T | null : T;
type DurationResult<E> = NullableResult<Seconds, E>;

function checkedDomain(
  value: AnyExpression,
  expected: ScalarDomain,
): ScalarDomain {
  assertExpression(value);
  if (nonNullableDomain(value.domain) !== expected)
    throw new Error(
      "query-builder: arithmetic operands have incompatible domains",
    );
  return value.domain;
}

function propagatedDomain<T, E extends AnyExpression>(
  domain: Domain<T>,
  ...values: readonly E[]
): Domain<NullableResult<T, E>> {
  return (
    values.some((value) => value.domain.nullable) ? nullable(domain) : domain
  ) as Domain<NullableResult<T, E>>;
}

/**
 * Reinterprets an instant as the duration since the Unix origin, so a time of
 * day can be taken with remainderSeconds. The SQL is the operand unchanged.
 */
export function elapsedSinceUnixOrigin<
  E extends NullableExpression<EpochSeconds>,
>(value: E): Expression<DurationResult<E>, readonly [...RequirementsOf<E>]> {
  checkedDomain(value, SqliteScalars.epochSeconds);
  return arithmetic(
    { kind: "conversion", value },
    propagatedDomain<Seconds, E>(SqliteScalars.seconds, value),
    [value],
  );
}

export function addSeconds<
  L extends NullableExpression<Seconds>,
  R extends NullableExpression<Seconds>,
>(
  left: L,
  right: R & CompatibleRequirements<PairRequirements<NoInfer<L>, NoInfer<R>>>,
): Expression<DurationResult<L | R>, PairRequirements<L, R>> {
  return binary(
    "+",
    left,
    right,
    checkedDomain(left, SqliteScalars.seconds),
    checkedDomain(right, SqliteScalars.seconds),
    propagatedDomain<Seconds, L | R>(SqliteScalars.seconds, left, right),
  );
}

export function remainderSeconds<
  L extends NullableExpression<Seconds>,
  R extends NullableExpression<Seconds>,
>(
  left: L,
  right: R & CompatibleRequirements<PairRequirements<NoInfer<L>, NoInfer<R>>>,
): Expression<Seconds | null, PairRequirements<L, R>> {
  // Even required operands can produce NULL when the divisor is zero.
  return binary(
    "%",
    left,
    right,
    checkedDomain(left, SqliteScalars.seconds),
    checkedDomain(right, SqliteScalars.seconds),
    nullable(SqliteScalars.seconds),
  );
}

// A remainder is NULL when its divisor is zero, whatever its operands are.
type OperationResult<O extends ArithmeticOperator, T, E> = O extends "%"
  ? T | null
  : NullableResult<T, E>;

/**
 * Declares one closed operation on an application's own domains: `left
 * operator right` yields `result`. The returned constructor accepts operands of
 * exactly those domains, nullable or not, and its result is nullable when an
 * operand is, and always for `%`. Declare each operation once, beside the
 * domains it relates; a call site never names a result domain.
 */
export function operation<const O extends ArithmeticOperator, L, R, T>(
  operator: O,
  left: Domain<L>,
  right: Domain<R>,
  result: Domain<T>,
) {
  // The operator is emitted as SQL text, so untyped input is refused here.
  if (!OPERATORS.has(operator))
    throw new Error(`query-builder: unsupported operator "${operator}"`);
  assertDomain(left);
  assertDomain(right);
  assertDomain(result);
  if (left.nullable || right.nullable || result.nullable)
    throw new Error(
      "query-builder: an operation is declared on non-null domains",
    );
  return function apply<
    A extends NullableExpression<L>,
    B extends NullableExpression<R>,
  >(
    a: A,
    b: B & CompatibleRequirements<PairRequirements<NoInfer<A>, NoInfer<B>>>,
  ): Expression<OperationResult<O, T, A | B>, PairRequirements<A, B>> {
    return binary(
      operator,
      a,
      b,
      checkedDomain(a, left),
      checkedDomain(b, right),
      (operator === "%"
        ? nullable(result)
        : propagatedDomain<T, A | B>(result, a, b)) as Domain<
        OperationResult<O, T, A | B>
      >,
    );
  };
}

/**
 * Declares that a value of `from` may be read as a value of `to` without any
 * SQL operation: the rendered SQL is the operand unchanged. Use it where the
 * schema gives one domain's values a second meaning, such as an identity
 * reused as the first member of a series. Nullability carries through.
 */
export function conversion<F, T>(from: Domain<F>, to: Domain<T>) {
  assertDomain(from);
  assertDomain(to);
  if (from.nullable || to.nullable)
    throw new Error(
      "query-builder: a conversion is declared on non-null domains",
    );
  return function apply<E extends NullableExpression<F>>(
    value: E,
  ): Expression<NullableResult<T, E>, readonly [...RequirementsOf<E>]> {
    checkedDomain(value, from);
    return arithmetic(
      { kind: "conversion", value },
      propagatedDomain<T, E>(to, value),
      [value],
    );
  };
}
