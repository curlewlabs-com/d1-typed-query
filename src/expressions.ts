// Typed value expressions consumed by statement construction. Nodes
// retain domain, parameter, and source provenance until the renderer traverses
// them; constructor membership prevents structural copies from becoming nodes.

import type { EpochSeconds } from "./brand";
import type { DomainRefinements, StoredUuid } from "./scalars";
import {
  isColumn,
  type BrandOf,
  type ColumnReference,
  type TableSource,
} from "./catalog";
import {
  SqliteScalars,
  acceptsDomain,
  nonNullableDomain,
  nullable,
  assertDomain,
  type Domain,
  type DomainValue,
  type ScalarDomain,
} from "./scalars";
import {
  collectRequirements,
  type CollectRequirements,
  type CompatibleRequirements,
  type Parameterized,
  type Requirements,
  type RequirementsOf,
  type RuntimeRequirement,
  type SameType,
} from "./params";
import { assertPredicate, type AnyPredicate } from "./predicates";
import { assertSqlIdentifier } from "./identifiers";
import { assertLiteralText } from "./literal-text";
import type { AnySelect } from "./statements";
import { isSubqueryExpression, type SubqueryIdentity } from "./subqueries";

import { isArithmeticExpression, type ArithmeticIdentity } from "./arithmetic";

const EXPRESSION: unique symbol = Symbol("SqlExpression");
const TYPE_ERROR: unique symbol = Symbol("IncompatibleSqlDomain");
const expressionNodes = new WeakSet();

export type NullableColumn<C extends ColumnReference> =
  null extends BrandOf<C>
    ? unknown
    : { readonly [TYPE_ERROR]: "nullable column required" };
export type StoredUuidColumn<C extends ColumnReference> =
  NonNullable<BrandOf<C>> extends StoredUuid
    ? unknown
    : { readonly [TYPE_ERROR]: "stored UUID column required" };

export type ExpressionTree =
  | { readonly kind: "column"; readonly column: ColumnReference }
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "literal"; readonly value: string | number | null }
  | { readonly kind: "now" }
  | { readonly kind: "uuid" }
  | { readonly kind: "subquery"; readonly query: AnySelect }
  // A declared reinterpretation of its operand's domain (arithmetic.ts); it
  // renders as the operand.
  | { readonly kind: "conversion"; readonly value: AnyExpression }
  | {
      readonly kind: "exists";
      readonly query: AnySelect;
    }
  | {
      readonly kind: "function";
      readonly name: "COALESCE" | "MIN" | "MAX" | "date" | "changes" | "unhex";
      readonly values: readonly AnyExpression[];
    }
  | {
      readonly kind: "case";
      readonly arms: readonly CaseArm[];
      readonly fallback: AnyExpression;
    }
  | { readonly kind: "aggregate"; readonly name: "COUNT"; readonly value: null }
  | {
      readonly kind: "aggregate";
      readonly name: "MIN" | "MAX";
      readonly value: AnyExpression;
    }
  | {
      readonly kind: "binary";
      readonly operator: "+" | "-" | "|" | "*" | "%";
      readonly left: AnyExpression;
      readonly right: AnyExpression;
    }
  | {
      readonly kind: "unary";
      readonly name: "hex" | "lower" | "trim";
      readonly value: AnyExpression;
    };

interface CoreExpressionIdentity {
  readonly [EXPRESSION]: true;
}
type ExpressionIdentity =
  CoreExpressionIdentity | SubqueryIdentity | ArithmeticIdentity;

interface ExpressionBase {
  readonly tree: ExpressionTree;
  readonly domain: ScalarDomain;
  readonly hasAggregate: boolean;
  readonly sources: readonly TableSource[];
}

export type Expression<T, P extends Requirements> = ExpressionBase &
  ExpressionIdentity &
  Parameterized<P> & { readonly domain: Domain<T> };

export type AnyExpression = ExpressionBase &
  ExpressionIdentity &
  Parameterized<Requirements>;
export type ExpressionValue<E> =
  E extends Expression<infer T, Requirements> ? T : never;

// Subtype compatibility is limited to declared refinements
// (DomainRelations["refinements"]); branded values cannot enter primitive slots
// merely because their representations match.
// R is a type parameter so the test distributes over the declared pairs.
type RefinesInto<Destination, Source, R = DomainRefinements> = true extends (
  R extends readonly [infer Narrow, infer Wide]
    ? [Source] extends [Narrow]
      ? SameType<Destination, Wide>
      : false
    : never
)
  ? true
  : false;
type CompatibleNonNullValue<Destination, Source> =
  SameType<Destination, Source> extends true
    ? true
    : RefinesInto<Destination, Source>;

export type CompatibleValue<Destination, Source> =
  CompatibleNonNullValue<
    NonNullable<Destination>,
    NonNullable<Source>
  > extends true
    ? null extends Source
      ? null extends Destination
        ? unknown
        : { readonly [TYPE_ERROR]: "nullable source" }
      : unknown
    : { readonly [TYPE_ERROR]: "incompatible domain" };

function treeHasAggregate(tree: ExpressionTree): boolean {
  switch (tree.kind) {
    case "aggregate":
      return true;
    case "function":
      return tree.values.some((value) => value.hasAggregate);
    case "case":
      return (
        tree.fallback.hasAggregate ||
        tree.arms.some(
          ([condition, value]) => condition.hasAggregate || value.hasAggregate,
        )
      );
    case "binary":
      return tree.left.hasAggregate || tree.right.hasAggregate;
    case "unary":
    case "conversion":
      return tree.value.hasAggregate;
    case "column":
    case "parameter":
    case "literal":
    case "now":
    case "uuid":
    case "subquery":
    case "exists":
      return false;
  }
}

function expression<T, P extends Requirements>(
  tree: ExpressionTree,
  domain: Domain<T>,
  sources: readonly TableSource[],
  requirements: readonly RuntimeRequirement[],
): Expression<T, P> {
  const result: Expression<T, P> = Object.freeze({
    [EXPRESSION]: true as const,
    tree: Object.freeze(tree),
    domain,
    hasAggregate: treeHasAggregate(tree),
    sources: Object.freeze([...sources]),
    requirements: Object.freeze([...requirements]),
  });
  expressionNodes.add(result);
  return result;
}

export function assertExpression(value: AnyExpression): void {
  if (
    !expressionNodes.has(value) &&
    !isSubqueryExpression(value) &&
    !isArithmeticExpression(value)
  )
    throw new Error("query-builder: expression must come from a constructor");
}

function columnDomain<C extends ColumnReference>(
  column: C,
): Domain<BrandOf<C>> {
  if (!isColumn(column))
    throw new Error("query-builder: column must come from the schema model");
  return column.domain;
}

export function columnValue<C extends ColumnReference>(
  column: C,
): Expression<BrandOf<C>, readonly []> {
  return expression(
    { kind: "column", column },
    columnDomain(column),
    [column.source],
    [],
  );
}

// The element a json_each source yields, in its declared domain. A blob
// element travels as hex (json-array-param.ts), so it is decoded with unhex(),
// which a blob index seek can then compare against; any other element is the
// JSON value itself.
//
// Only a json_each source's own value column, read in the element domain that
// source declared, is accepted: anything else would relabel a column's domain.
export function jsonEachElement<T>(
  value: ColumnReference,
  element: Domain<T>,
): Expression<T, readonly []> {
  const source = value.source;
  if (
    source.kind !== "json-each" ||
    value.name !== "value" ||
    source.element !== element
  )
    throw new Error(
      "query-builder: jsonEachElement reads only a json_each source's value column, in the element domain it declared",
    );
  const raw = columnValue(value);
  if (element.storage !== "blob")
    return expression(raw.tree, element, raw.sources, []);
  return expression(
    { kind: "function", name: "unhex", values: Object.freeze([raw]) },
    element,
    raw.sources,
    [],
  );
}

/**
 * The caller supplies and documents the predicate or schema invariant that
 * makes this column non-null. This changes the expression's domain, not its SQL:
 * it adds no null check or fallback. Restricting refinement to a column keeps
 * nullable input parameters from being narrowed by assertion.
 * See docs/design.md sec."Projection types and executor rows".
 */
export function requiredColumnValue<C extends ColumnReference>(
  column: C,
): Expression<NonNullable<BrandOf<C>>, readonly []> {
  return expression(
    { kind: "column", column },
    nonNullableDomain(columnDomain(column)) as Domain<NonNullable<BrandOf<C>>>,
    [column.source],
    [],
  );
}

export function param<C extends ColumnReference, const Name extends string>(
  column: C,
  name: Name,
): Expression<
  NonNullable<BrandOf<C>>,
  readonly [readonly [Name, NonNullable<BrandOf<C>>]]
> {
  assertSqlIdentifier(name, "parameter");
  const domain = nonNullableDomain(columnDomain(column));
  return expression(
    { kind: "parameter", name },
    domain,
    [],
    [{ name, domain }],
  );
}

export function nullableParam<
  C extends ColumnReference,
  const Name extends string,
>(
  column: C,
  name: Name,
): Expression<
  BrandOf<C> | null,
  readonly [readonly [Name, BrandOf<C> | null]]
> {
  assertSqlIdentifier(name, "parameter");
  // Input nullability belongs to the bind, including optional comparisons with
  // required columns. Assignment construction still checks storage nullability.
  const domain = nullable(columnDomain(column));
  return expression(
    { kind: "parameter", name },
    domain,
    [],
    [{ name, domain }],
  );
}

export function refinedParam<
  C extends ColumnReference,
  D extends ScalarDomain,
  const Name extends string,
>(
  column: C,
  refinement: D &
    CompatibleValue<NonNullable<BrandOf<C>>, DomainValue<NoInfer<D>>>,
  name: Name,
): Expression<DomainValue<D>, readonly [readonly [Name, DomainValue<D>]]> {
  assertSqlIdentifier(name, "parameter");
  if (!acceptsDomain(columnDomain(column), refinement) || refinement.nullable) {
    throw new Error(
      "query-builder: refinement is incompatible with its column",
    );
  }
  const domain = refinement as Domain<DomainValue<D>>;
  return expression(
    { kind: "parameter", name },
    domain,
    [],
    [{ name, domain }],
  );
}

export function countParam<const Name extends string>(
  name: Name,
): Expression<number, readonly [readonly [Name, number]]> {
  assertSqlIdentifier(name, "parameter");
  return expression(
    { kind: "parameter", name },
    SqliteScalars.count,
    [],
    [{ name, domain: SqliteScalars.count }],
  );
}

function literalTree(value: unknown): ExpressionTree {
  if (value === null) return { kind: "literal", value };
  if (typeof value === "string") {
    assertLiteralText(value, "literal");
    return { kind: "literal", value };
  }
  if (typeof value === "number" && Number.isSafeInteger(value))
    return { kind: "literal", value };
  throw new Error(
    "query-builder: literal requires text, NULL, or a safe integer",
  );
}

export function literal<C extends ColumnReference>(
  column: C,
  value: NoInfer<NonNullable<BrandOf<C>>>,
): Expression<NonNullable<BrandOf<C>>, readonly []> {
  const domain = nonNullableDomain(columnDomain(column));
  if (
    (domain.storage === "integer" && typeof value !== "number") ||
    (domain.storage === "text" && typeof value !== "string") ||
    domain.storage === "blob"
  ) {
    throw new Error("query-builder: literal storage does not match its column");
  }
  return expression(literalTree(value), domain, [], []);
}

export function count(value: number): Expression<number, readonly []> {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("query-builder: count must be a nonnegative safe integer");
  return expression(literalTree(value), SqliteScalars.count, [], []);
}

export function nullValue<C extends ColumnReference>(
  column: C & NullableColumn<NoInfer<C>>,
): Expression<BrandOf<C>, readonly []> {
  const domain = columnDomain(column);
  if (!domain.nullable)
    throw new Error("query-builder: NULL requires a nullable column");
  return expression({ kind: "literal", value: null }, domain, [], []);
}

/**
 * Read SQLite's connection-local preceding-write count, with no source or bind
 * requirements. This is a scalar count, not an aggregate. Callers relying on
 * another statement's result must keep that write immediately before this
 * expression's statement in the same D1 batch; construction cannot prove the
 * execution order or connection identity.
 */
export function sqliteChanges(): Expression<number, readonly []> {
  return expression(
    { kind: "function", name: "changes", values: Object.freeze([]) },
    SqliteScalars.count,
    [],
    [],
  );
}

export function nowEpochSeconds(): Expression<EpochSeconds, readonly []> {
  return expression({ kind: "now" }, SqliteScalars.epochSeconds, [], []);
}

export function uuidValue<C extends ColumnReference>(
  column: C & StoredUuidColumn<NoInfer<C>>,
): Expression<NonNullable<BrandOf<C>>, readonly []> {
  const domain = nonNullableDomain(columnDomain(column));
  if (!domain.storedUuid)
    throw new Error("query-builder: random UUID requires a stored-UUID column");
  return expression({ kind: "uuid" }, domain, [], []);
}

export function assertAssignable<
  C extends ColumnReference,
  E extends AnyExpression,
>(
  column: C,
  value: E & CompatibleValue<BrandOf<C>, ExpressionValue<NoInfer<E>>>,
): void {
  assertExpression(value);
  if (!acceptsDomain(columnDomain(column), value.domain))
    throw new Error(
      "query-builder: value is incompatible with its destination column",
    );
}

export type AssignableValue<
  C extends ColumnReference,
  E extends AnyExpression,
> = CompatibleValue<BrandOf<C>, ExpressionValue<E>>;

export * from "./predicates";

export function scalarParam<D extends ScalarDomain, const Name extends string>(
  domain: D,
  name: Name,
): Expression<DomainValue<D>, readonly [readonly [Name, DomainValue<D>]]> {
  assertDomain(domain);
  assertSqlIdentifier(name, "parameter");
  return expression(
    { kind: "parameter", name },
    domain,
    [],
    [{ name, domain }],
  );
}

export function scalarLiteral<D extends ScalarDomain>(
  domain: D,
  value: NoInfer<DomainValue<D>>,
): Expression<DomainValue<D>, readonly []> {
  assertDomain(domain);
  if (
    (value === null && !domain.nullable) ||
    (value !== null &&
      ((domain.storage === "integer" && typeof value !== "number") ||
        (domain.storage === "text" && typeof value !== "string") ||
        domain.storage === "blob"))
  )
    throw new Error("query-builder: literal storage does not match its domain");
  return expression(literalTree(value), domain, [], []);
}

type MatchingDomain<L, R> =
  SameType<
    NonNullable<ExpressionValue<L>>,
    NonNullable<ExpressionValue<R>>
  > extends true
    ? unknown
    : { readonly [TYPE_ERROR]: "incompatible domain" };
type PairRequirements<
  L extends AnyExpression,
  R extends AnyExpression,
> = CollectRequirements<readonly [L, R]>;
type CheckedRight<
  L extends AnyExpression,
  R extends AnyExpression,
> = MatchingDomain<L, R> & CompatibleRequirements<PairRequirements<L, R>>;

function sameDomain(values: readonly AnyExpression[]): ScalarDomain {
  const first = values[0];
  if (first === undefined)
    throw new Error("query-builder: expression needs an operand");
  assertExpression(first);
  const domain = nonNullableDomain(first.domain);
  for (const value of values) {
    assertExpression(value);
    if (nonNullableDomain(value.domain) !== domain)
      throw new Error(
        "query-builder: expression operands have incompatible domains",
      );
  }
  return domain;
}

type CoalesceResult<V extends readonly AnyExpression[]> = V extends readonly [
  infer H extends AnyExpression,
  ...infer T extends readonly AnyExpression[],
]
  ? | NonNullable<ExpressionValue<H>>
    | (null extends ExpressionValue<H> ? CoalesceResult<T> : never)
  : null;
type MatchingValues<V extends readonly AnyExpression[]> = {
  readonly [K in keyof V]: V[K] & MatchingDomain<V[0], V[K]>;
};

export function coalesce<
  const V extends readonly [AnyExpression, AnyExpression, ...AnyExpression[]],
>(
  ...values: V &
    MatchingValues<NoInfer<V>> &
    CompatibleRequirements<CollectRequirements<NoInfer<V>>>
): Expression<CoalesceResult<V>, CollectRequirements<V>> {
  if (values.length < 2)
    throw new Error("query-builder: COALESCE needs fallback operands");
  const domain = sameDomain(values);
  return expression(
    { kind: "function", name: "COALESCE", values: Object.freeze([...values]) },
    values.every((value) => value.domain.nullable) ? nullable(domain) : domain,
    values.flatMap((value) => value.sources),
    collectRequirements(values),
  );
}

function extremum<L extends AnyExpression, R extends AnyExpression>(
  name: "MIN" | "MAX",
  left: L,
  right: R,
): Expression<ExpressionValue<L> | ExpressionValue<R>, PairRequirements<L, R>> {
  const domain = sameDomain([left, right]);
  return expression(
    { kind: "function", name, values: Object.freeze([left, right]) },
    left.domain.nullable || right.domain.nullable ? nullable(domain) : domain,
    [...left.sources, ...right.sources],
    collectRequirements([left, right]),
  );
}

export function scalarMin<L extends AnyExpression, R extends AnyExpression>(
  left: L,
  right: R & CheckedRight<NoInfer<L>, NoInfer<R>>,
) {
  return extremum<L, R>("MIN", left, right);
}
export function scalarMax<L extends AnyExpression, R extends AnyExpression>(
  left: L,
  right: R & CheckedRight<NoInfer<L>, NoInfer<R>>,
) {
  return extremum<L, R>("MAX", left, right);
}

type CaseArm = readonly [AnyPredicate, AnyExpression];
type ArmRequirements<A extends readonly CaseArm[]> = A extends readonly [
  infer H extends CaseArm,
  ...infer T extends readonly CaseArm[],
]
  ? readonly [...CollectRequirements<H>, ...ArmRequirements<T>]
  : number extends A["length"]
    ? Requirements
    : readonly [];
type CaseRequirements<
  A extends readonly CaseArm[],
  E extends AnyExpression,
> = readonly [...ArmRequirements<A>, ...RequirementsOf<E>];
type CheckedArms<A extends readonly CaseArm[], E extends AnyExpression> = {
  readonly [K in keyof A]: readonly [
    A[K][0],
    A[K][1] & MatchingDomain<E, A[K][1]>,
  ];
};

export function caseWhen<
  const A extends readonly CaseArm[],
  E extends AnyExpression,
>(
  arms: A & CheckedArms<NoInfer<A>, NoInfer<E>>,
  fallback: E &
    CompatibleRequirements<CaseRequirements<NoInfer<A>, NoInfer<E>>>,
): Expression<
  ExpressionValue<A[number][1]> | ExpressionValue<E>,
  CaseRequirements<A, E>
> {
  if (arms.length === 0)
    throw new Error("query-builder: CASE needs a WHEN arm");
  for (const [condition] of arms) assertPredicate(condition);
  const values = [...arms.map(([, value]) => value), fallback];
  const domain = sameDomain(values);
  const nodes = [
    ...arms.flatMap(([condition, value]) => [condition, value]),
    fallback,
  ];
  return expression(
    {
      kind: "case",
      arms: Object.freeze(
        arms.map(([condition, value]) =>
          Object.freeze([condition, value] as const),
        ),
      ),
      fallback,
    },
    values.some((value) => value.domain.nullable) ? nullable(domain) : domain,
    nodes.flatMap((node) => node.sources),
    collectRequirements(nodes),
  );
}

export function aggregateCount(): Expression<number, readonly []> {
  return expression(
    { kind: "aggregate", name: "COUNT", value: null },
    SqliteScalars.count,
    [],
    [],
  );
}
function aggregate<E extends AnyExpression>(
  name: "MIN" | "MAX",
  value: E,
): Expression<ExpressionValue<E> | null, RequirementsOf<E>> {
  assertExpression(value);
  if (value.hasAggregate)
    throw new Error("query-builder: nested aggregate is not supported");
  return expression(
    { kind: "aggregate", name, value },
    nullable(value.domain as Domain<ExpressionValue<E>>),
    value.sources,
    value.requirements,
  );
}
export function aggregateMin<E extends AnyExpression>(value: E) {
  return aggregate("MIN", value);
}
export function aggregateMax<E extends AnyExpression>(value: E) {
  return aggregate("MAX", value);
}

export function storedUuidHex<E extends AnyExpression>(
  value: E &
    (ExpressionValue<NoInfer<E>> extends StoredUuid
      ? unknown
      : { readonly [TYPE_ERROR]: "stored UUID required" }),
): Expression<string, RequirementsOf<E>> {
  assertExpression(value);
  if (value.domain.nullable || !value.domain.storedUuid)
    throw new Error("query-builder: hex requires a stored UUID");
  return expression(
    { kind: "unary", name: "hex", value },
    SqliteScalars.text,
    value.sources,
    value.requirements,
  );
}
export function lowerText<T extends string | null, P extends Requirements>(
  value: Expression<T, P> &
    (SameType<NonNullable<NoInfer<T>>, string> extends true
      ? unknown
      : { readonly [TYPE_ERROR]: "ordinary text required" }),
): Expression<T, P> {
  assertExpression(value);
  // Exactly text: a refinement keeps its domain through lower(), which could
  // then hold a value outside it.
  if ((nonNullableDomain(value.domain) as ScalarDomain) !== SqliteScalars.text)
    throw new Error("query-builder: lower requires ordinary text");
  return expression(
    { kind: "unary", name: "lower", value },
    value.domain,
    value.sources,
    value.requirements,
  );
}

/**
 * Uses SQLite's default space trimming, preserving NULL and ordinary-text
 * identity. Indexed address comparisons must transform stored and bound values
 * identically; application Unicode normalization has different semantics.
 * See docs/design.md sec."Constants and scalar algebra".
 */
export function trimText<T extends string | null, P extends Requirements>(
  value: Expression<T, P> &
    (SameType<NonNullable<NoInfer<T>>, string> extends true
      ? unknown
      : { readonly [TYPE_ERROR]: "ordinary text required" }),
): Expression<T, P> {
  assertExpression(value);
  // Exactly text, as for lowerText.
  if ((nonNullableDomain(value.domain) as ScalarDomain) !== SqliteScalars.text)
    throw new Error("query-builder: trim requires ordinary text");
  return expression(
    { kind: "unary", name: "trim", value },
    value.domain,
    value.sources,
    value.requirements,
  );
}

/**
 * The UTC calendar day of an instant, as `date(value, 'unixepoch')`: the fixed
 * interpretation keeps any local calendar out of it. NULL input or an instant
 * outside SQLite's calendar yields NULL, so the result is nullable text. Source
 * and parameter requirements remain those of the input expression.
 * See docs/design.md sec."Composable expressions and statements".
 */
export function utcDate<T extends EpochSeconds | null, P extends Requirements>(
  value: Expression<T, P>,
): Expression<string | null, P> {
  assertExpression(value);
  if (
    !acceptsDomain(SqliteScalars.epochSeconds, nonNullableDomain(value.domain))
  )
    throw new Error(
      "query-builder: UTC date requires an epoch-seconds instant",
    );
  return expression(
    {
      kind: "function",
      name: "date",
      values: Object.freeze([
        value,
        scalarLiteral(SqliteScalars.text, "unixepoch"),
      ]),
    },
    nullable(SqliteScalars.text),
    value.sources,
    value.requirements,
  );
}
