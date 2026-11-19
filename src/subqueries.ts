// SELECT-to-value conversion owns scalar empty-row nullability, aggregate row
// guarantees, and EXISTS flag semantics. Its private membership registry keeps
// copied or fabricated nested values out of the expression graph.

import type { Expression } from "./expressions";
import type { OutputValue } from "./projections";
import type { Requirements, RequirementsOf } from "./params";
import { SqliteScalars, nullable, type Domain } from "./scalars";
import {
  assertSelect,
  assertSingleSelect,
  type AnySelect,
  type SingleSelect,
  type SingleSimpleSelect,
} from "./statements";

const SUBQUERY: unique symbol = Symbol("SubqueryExpression");
const subqueryNodes = new WeakSet();
export interface SubqueryIdentity {
  readonly [SUBQUERY]: true;
}

/**
 * Checks constructor membership, not a structural shape: copied nodes must not
 * bypass the checked SELECT-to-expression boundary.
 */
export function isSubqueryExpression(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && subqueryNodes.has(value)
  );
}

// An aggregate inside the nested SELECT belongs to that SELECT's row scope;
// marking this wrapper as aggregate would incorrectly constrain its consumer.
function subqueryExpression<T, P extends Requirements>(
  tree: { readonly kind: "subquery" | "exists"; readonly query: AnySelect },
  domain: Domain<T>,
  sources: AnySelect["sources"],
  requirements: AnySelect["requirements"],
): Expression<T, P> {
  const value: Expression<T, P> = Object.freeze({
    [SUBQUERY]: true as const,
    tree: Object.freeze(tree),
    domain,
    hasAggregate: false,
    sources: Object.freeze([...sources]),
    requirements: Object.freeze([...requirements]),
  });
  subqueryNodes.add(value);
  return value;
}

type SelectedValue<S extends SingleSelect> = OutputValue<S["outputs"][0]>;

/**
 * Use when a lookup may return no row: even a non-null projected column then
 * produces SQL NULL. This checks projection arity, not row uniqueness; callers
 * needing a particular row must constrain or order the SELECT. Correlated source
 * requirements remain attached for the enclosing statement to resolve.
 * See docs/design.md sec."Subquery construction boundary".
 */
export function scalarSubquery<S extends SingleSelect>(
  query: S,
): Expression<SelectedValue<S> | null, RequirementsOf<S>> {
  assertSingleSelect(query);
  return subqueryExpression(
    { kind: "subquery", query },
    nullable(query.outputs[0].domain as Domain<SelectedValue<S>>),
    query.sources,
    query.requirements,
  );
}

/**
 * Preserves the projected domain because an aggregate SELECT without LIMIT
 * retains its result row even for empty input. Nullable aggregate values remain
 * nullable. The aggregate projection and lack of LIMIT are checked here; SELECT
 * construction checks aggregate scope so the row guarantee belongs to this query.
 * See docs/design.md sec."Subquery construction boundary".
 */
export function aggregateSubquery<S extends SingleSimpleSelect>(
  query: S,
): Expression<SelectedValue<S>, RequirementsOf<S>> {
  assertSingleSelect(query);
  // Read as unknown: an untyped caller can pass a compound SELECT here.
  const kind: unknown = query.tree.kind;
  if (kind !== "select")
    throw new Error("query-builder: aggregate scalar requires a simple SELECT");
  const value = query.tree.columns[0].value;
  if (!value.hasAggregate || query.tree.limit !== null)
    throw new Error(
      "query-builder: aggregate scalar requires an aggregate projection without LIMIT",
    );
  return subqueryExpression(
    { kind: "subquery", query },
    query.outputs[0].domain as Domain<SelectedValue<S>>,
    query.sources,
    query.requirements,
  );
}

/**
 * Use for a projected presence flag, rather than a WHERE guard. Row presence
 * produces a non-null flag regardless of projected values; correlated sources
 * and bind requirements still have to resolve in the enclosing statement.
 * See docs/design.md sec."Subquery construction boundary".
 */
export function existsValue<S extends AnySelect>(
  query: S,
): Expression<0 | 1, RequirementsOf<S>> {
  assertSelect(query);
  return subqueryExpression(
    { kind: "exists", query },
    SqliteScalars.flag,
    query.sources,
    query.requirements,
  );
}

/**
 * The caller must establish and document row existence, usually through an
 * earlier write in the same atomic batch. This checks a non-null projection but
 * does not prove that a row exists or add a SQL fallback. A nullable projected
 * value needs a separate source guarantee; use scalarSubquery when absence is
 * possible.
 * See docs/design.md sec."Projection types and executor rows".
 */
export function requiredScalarSubquery<S extends SingleSelect>(
  query: S & (null extends SelectedValue<NoInfer<S>> ? never : unknown),
): Expression<SelectedValue<S>, RequirementsOf<S>> {
  assertSingleSelect(query);
  const output = query.outputs[0];
  if (output.domain.nullable)
    throw new Error(
      "query-builder: required scalar lookup needs a non-null projection",
    );
  return subqueryExpression(
    { kind: "subquery", query },
    output.domain as Domain<SelectedValue<S>>,
    query.sources,
    query.requirements,
  );
}
