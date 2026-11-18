// SELECT bodies own normalized read clauses and their shared source scope.
// Aggregate cardinality, projection identity, ordering and LIMIT must agree
// before statement construction grants nominal identity and bind agreement.

import type { TableSource } from "./catalog";
import type { Parameterized, Requirements } from "./params";
import type { SelectInput, SelectTree } from "./statements";
import { ReadScope, sourceRequirements } from "./sources";
import {
  assertExpression,
  type AnyExpression,
  type AnyPredicate,
} from "./expressions";
import { assertProjection, assertOrder } from "./projections";
import { SqliteScalars } from "./scalars";

// SQLite permits bare columns beside aggregates, but an empty input makes even
// a NOT NULL column read NULL. Such rows cannot keep the projected domain.
function aggregateResultOnly(value: AnyExpression): boolean {
  const tree = value.tree;
  switch (tree.kind) {
    case "column":
      return false;
    case "aggregate":
    case "parameter":
    case "literal":
    case "now":
    case "uuid":
      return true;
    case "subquery":
    case "exists":
      return tree.query.sources.length === 0;
    case "function":
      return tree.values.every(aggregateResultOnly);
    case "binary":
      return aggregateResultOnly(tree.left) && aggregateResultOnly(tree.right);
    case "conversion":
    case "unary":
      return aggregateResultOnly(tree.value);
    case "case":
      return (
        aggregateResultOnly(tree.fallback) &&
        tree.arms.every(
          ([condition, arm]) =>
            aggregatePredicateOnly(condition) && aggregateResultOnly(arm),
        )
      );
  }
}

function aggregatePredicateOnly(value: AnyPredicate): boolean {
  const tree = value.tree;
  switch (tree.kind) {
    case "comparison":
      return aggregateResultOnly(tree.left) && aggregateResultOnly(tree.right);
    case "null-check":
      return aggregateResultOnly(tree.expression);
    case "junction":
      return tree.predicates.every(aggregatePredicateOnly);
    case "group":
      return aggregatePredicateOnly(tree.predicate);
    case "exists":
      return tree.query.sources.length === 0;
    case "in-query":
      return aggregateResultOnly(tree.value) && tree.query.sources.length === 0;
    case "in-values":
      return (
        aggregateResultOnly(tree.value) &&
        tree.values.every(aggregateResultOnly)
      );
    case "like":
      return aggregateResultOnly(tree.value);
  }
}

function assertAggregateScope(
  value: AnyExpression,
  source: readonly TableSource[],
): void {
  const tree = value.tree;
  switch (tree.kind) {
    case "aggregate":
      // SQLite moves an aggregate whose operands name only outer sources into
      // that outer SELECT. It would then change cardinality outside this scope.
      if (
        tree.value !== null &&
        tree.value.sources.length !== 0 &&
        !tree.value.sources.some((item) => source.includes(item))
      )
        throw new Error(
          "query-builder: aggregate operand must belong to its SELECT scope",
        );
      return;
    case "function":
      for (const child of tree.values) assertAggregateScope(child, source);
      return;
    case "binary":
      assertAggregateScope(tree.left, source);
      assertAggregateScope(tree.right, source);
      return;
    case "conversion":
    case "unary":
      assertAggregateScope(tree.value, source);
      return;
    case "case":
      assertAggregateScope(tree.fallback, source);
      for (const [condition, arm] of tree.arms) {
        assertPredicateAggregateScope(condition, source);
        assertAggregateScope(arm, source);
      }
      return;
    case "column":
    case "parameter":
    case "literal":
    case "now":
    case "uuid":
    case "subquery":
    case "exists":
      return;
  }
}

function assertPredicateAggregateScope(
  value: AnyPredicate,
  source: readonly TableSource[],
): void {
  const tree = value.tree;
  switch (tree.kind) {
    case "comparison":
      assertAggregateScope(tree.left, source);
      assertAggregateScope(tree.right, source);
      return;
    case "null-check":
      assertAggregateScope(tree.expression, source);
      return;
    case "junction":
      for (const child of tree.predicates)
        assertPredicateAggregateScope(child, source);
      return;
    case "group":
      assertPredicateAggregateScope(tree.predicate, source);
      return;
    case "in-values":
      assertAggregateScope(tree.value, source);
      for (const item of tree.values) assertAggregateScope(item, source);
      return;
    case "in-query":
    case "like":
      assertAggregateScope(tree.value, source);
      return;
    case "exists":
      return;
  }
}

export function assertLimit(limit: AnyExpression): void {
  assertExpression(limit);
  if (
    limit.domain !== SqliteScalars.count ||
    limit.sources.length !== 0 ||
    limit.hasAggregate
  )
    throw new Error(
      "query-builder: LIMIT requires a source-free count expression",
    );
}

export class SelectBody<I extends SelectInput> {
  readonly tree: SelectTree<I["columns"]>;
  readonly nodes: readonly Parameterized<Requirements>[];
  readonly sources: readonly TableSource[];

  constructor(input: I) {
    const scope = new ReadScope(
      input.from,
      input.joins ?? [],
      input.outer ?? [],
    );
    const { source, visible, joins } = scope;
    if (input.columns.length === 0)
      throw new Error("query-builder: SELECT needs a projection");
    const names = new Set<string>();
    for (const column of input.columns) {
      assertProjection(column);
      ReadScope.assertVisible(column.sources, visible);
      assertAggregateScope(column.value, scope.local);
      if (column.name === null) continue;
      const name = column.name.toLowerCase();
      if (names.has(name))
        throw new Error(`query-builder: duplicate projection "${column.name}"`);
      names.add(name);
    }
    const aggregates = input.columns.some(
      (column) => column.value.hasAggregate,
    );
    if (
      aggregates &&
      input.columns.some((column) => !aggregateResultOnly(column.value))
    )
      throw new Error(
        "query-builder: aggregate projection cannot read ungrouped columns",
      );
    const where = ReadScope.where(input.where, visible);
    const orderBy = Object.freeze([...(input.orderBy ?? [])]);
    for (const order of orderBy) {
      assertOrder(order);
      switch (order.tree.kind) {
        case "expression":
          ReadScope.assertVisible(order.sources, visible);
          assertAggregateScope(order.tree.value, scope.local);
          if (order.tree.value.hasAggregate && !aggregates)
            throw new Error(
              "query-builder: aggregate ordering needs an aggregate projection",
            );
          break;
        case "projection": {
          const projection = order.tree.projection;
          if (!input.columns.includes(projection))
            throw new Error(
              "query-builder: ordering projection is outside this SELECT",
            );
          if (
            order.tree.isNotNull &&
            visible.some((item) => {
              const name = projection.name.toLowerCase();
              // Hidden row identities also win input-column resolution; reject
              // their names conservatively even for a WITHOUT ROWID source.
              return (
                name === "rowid" ||
                name === "_rowid_" ||
                name === "oid" ||
                item.columnNames.some((column) => column.toLowerCase() === name)
              );
            })
          )
            throw new Error(
              "query-builder: NULL ordering projection conflicts with an input column",
            );
          break;
        }
      }
    }
    const limit = input.limit ?? null;
    if (limit !== null) {
      assertLimit(limit);
    }
    // Cloning retains the authored tuple's order and projection identities; array
    // spread alone erases the tuple needed by scalar-subquery arity checks.
    const columns = Object.freeze([...input.columns]) as I["columns"];
    const nodes = [
      ...columns,
      { requirements: sourceRequirements(source), sources: [] },
      ...joins,
      ...(where === null ? [] : [where]),
      ...orderBy,
      ...(limit === null ? [] : [limit]),
    ];
    this.tree = Object.freeze({
      kind: "select",
      source,
      joins,
      columns,
      where,
      orderBy,
      limit,
    });
    this.nodes = Object.freeze(nodes);
    this.sources = Object.freeze(
      scope.outerDependencies(nodes.flatMap((node) => node.sources)),
    );
    Object.freeze(this);
  }
}
