// The authored query types: what buildQuery returns, carrying SQL, bind order
// and row shape across the build boundary. The type a generated registry entry
// carries is the contract's (GeneratedQuery, contract.ts), since a frozen
// module imports only the contract.

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
