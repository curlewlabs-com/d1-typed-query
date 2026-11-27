// The builder entry point: schema and domain declarations, the statement and
// expression constructors, and buildQuery, which closes authoring by rendering
// a checked statement to SQL and its ordered bind names. Nothing here belongs
// in a deployed bundle; the runtime entry points are ./runtime, and ./contract
// for a program that has no D1 types.

import type { AuthoredQuery } from "./format";
import type { BindParams, Requirements } from "./params";
import { precomputed } from "./contract";
import { renderQuery } from "./renderer";
import type { Statement } from "./statements";

export type { Brand, EpochSeconds, Seconds } from "./brand";

/**
 * The relations between an application's domains that TypeScript cannot read
 * from the domain objects, because only a value's type survives once it flows
 * through an expression. Declare them by augmenting this interface:
 *
 *     declare module "@curlewlabs-com/d1-typed-query" {
 *       interface DomainRelations {
 *         // The value types of the domains declared with { storedUuid: true }.
 *         storedUuid: BookId | LoanId;
 *         // [narrower, wider] for each refinement() declaration.
 *         refinements: [ShelfCode, string];
 *       }
 *     }
 *
 * Each entry mirrors a runtime declaration, and nothing checks that the two
 * agree: keep them beside each other.
 */
// Empty here: the augmentation target must be an interface an application can
// merge into.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an application merges its relations into it, which only an interface allows
export interface DomainRelations {}

export {
  domain,
  refinement,
  nullable,
  nonNullableDomain,
  acceptsDomain,
  jsonArrayDomain,
  SqliteScalars,
  type Domain,
  type DomainValue,
  type ScalarDomain,
  type DomainRefinements,
  type StoredUuid,
} from "./scalars";
export {
  defineTable,
  aliasTable,
  nullableAliasTable,
  indexedBy,
  excludedTable,
  cte,
  derived,
  type RowOf,
  type Column,
  type ColumnReference,
  type BrandOf,
  type DefinedTable,
  type NullableTable,
  type TableReference,
  type TableSource,
  type CteDefinition,
  type CteReference,
  type CteRequirements,
  type SourceRequirements,
  type SourceColumn,
} from "./catalog";
export { SchemaSourceCatalog, type JsonEachReference } from "./source-catalog";
export { SchemaColumnCatalog } from "./column-catalog";
export * from "./expressions";
export {
  addCount,
  subtractCount,
  addDuration,
  subtractDuration,
  betweenInstants,
  elapsedSinceUnixOrigin,
  addSeconds,
  remainderSeconds,
  operation,
  conversion,
  type ArithmeticOperator,
  type NullableExpression,
  type NullableResult,
} from "./arithmetic";
export {
  scalarSubquery,
  requiredScalarSubquery,
  aggregateSubquery,
  existsValue,
} from "./subqueries";
export * from "./assignments";
export * from "./projections";
export * from "./statements";
export { jsonEach } from "./json-each";
export {
  innerJoin,
  leftJoin,
  commaJoin,
  crossJoin,
  type SourceInput,
  type Join,
  type AnyJoin,
} from "./sources";
export {
  conflictDoNothing,
  conflictDoUpdate,
  type Conflict,
  type AnyConflict,
} from "./conflicts";
// Every type an inferred query, fragment or table type can mention, so an
// application whose program emits declarations can name it.
export type { SubqueryIdentity } from "./subqueries";
export type { ArithmeticIdentity } from "./arithmetic";
export type {
  BindParams,
  CollectRequirements,
  CompatibleRequirements,
  Parameterized,
  Requirements,
  RequirementsOf,
  RuntimeRequirement,
  SameType,
} from "./params";
export type { JsonEachOccurrence } from "./renderer";
export type { AuthoredSql, AuthoredQuery } from "./format";
export type { GeneratedQuery } from "./contract";

/**
 * Closes query authoring by rendering SQL and positional bind names together.
 * Unresolved outer sources fail here rather than escaping as standalone SQL.
 * The execution contract keeps the parameter types and the statement's output
 * row, which the executors return. A rowless mutation's row is `never`.
 * See docs/design.md sec."Output and execution boundary".
 */
export function buildQuery<P extends Requirements, R>(
  statement: Statement<P, R>,
): AuthoredQuery<BindParams<P>, R> {
  const rendered = renderQuery(statement);
  return {
    ...precomputed<BindParams<P>, R>(rendered.sql, rendered.paramNames),
    jsonEachSources: rendered.jsonEachSources,
  };
}
