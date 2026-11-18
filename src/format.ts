// The authored and generated query types that carry SQL, bind order, and row
// shape across the build boundary.

// SQL and bind order cross the build boundary together. Generated registries
// retain the execution contract - bind types and the projection's row - through
// erased imports of their authored types.

import type { Query } from "./contract";
import type { JsonEachOccurrence } from "./renderer";

export interface AuthoredSql {
  readonly sql: string;
  readonly paramNames: readonly string[];
  // The json_each occurrences buildQuery rendered (RenderedQuery). Authored
  // only: a generated registry carries SQL and bind order, and nothing at run
  // time reads this.
  readonly jsonEachSources?: readonly JsonEachOccurrence[];
}
export interface AuthoredQuery<P extends Record<string, unknown>, R>
  extends Query<P, R>, AuthoredSql {}
// The type a frozen registry entry carries: its authored query's parameter and
// row types, without the authored query's build-time fields.
export type GeneratedQuery<Q> =
  Q extends Query<infer P, infer R> ? Query<P, R> : never;
