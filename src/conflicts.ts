// Conflict clauses own destination identity, excluded-row visibility and index
// target predicates. An INSERT consumes a closed clause after these checks;
// its SELECT sources never enter the conflict arm's read scope.

import {
  isColumn,
  tableSource,
  type ColumnReference,
  type TableReference,
  type TableSource,
} from "./catalog";
import { assertPredicate, type AnyPredicate } from "./expressions";
import { checkedAssignments, type AnyAssignment } from "./assignments";
import { ReadScope } from "./sources";
import {
  collectRequirements,
  type CollectRequirements,
  type CompatibleRequirements,
  type Parameterized,
  type Requirements,
  type RequirementsOf,
} from "./params";

const CONFLICT: unique symbol = Symbol("ConflictClause");
const clauses = new WeakSet<object>();

interface ConflictTargetInput {
  readonly target: readonly [ColumnReference, ...ColumnReference[]];
  readonly targetWhere?: AnyPredicate;
}
interface ConflictUpdateInput extends ConflictTargetInput {
  readonly excluded: TableReference;
  readonly set: readonly AnyAssignment[];
  readonly where?: AnyPredicate;
}
type UpdateRequirements<I extends ConflictUpdateInput> = readonly [
  ...CollectRequirements<I["set"]>,
  ...("where" extends keyof I ? RequirementsOf<I["where"]> : readonly []),
];
interface ConflictTarget {
  readonly source: TableSource;
  readonly columns: readonly ColumnReference[];
  readonly where: AnyPredicate | null;
}
type ConflictAction =
  | { readonly kind: "nothing" }
  | {
      readonly kind: "update";
      readonly excluded: TableSource;
      readonly set: readonly AnyAssignment[];
      readonly where: AnyPredicate | null;
    };
export interface Conflict<P extends Requirements> extends Parameterized<P> {
  readonly [CONFLICT]: true;
  readonly target: ConflictTarget;
  readonly action: ConflictAction;
}
export type AnyConflict = Conflict<Requirements>;

// Partial-index inference needs a static predicate. Keep this grammar closed
// rather than accidentally admitting a parameter, subquery or volatile value.
function isIndexPredicate(predicate: AnyPredicate): boolean {
  const tree = predicate.tree;
  switch (tree.kind) {
    case "null-check":
      return tree.expression.tree.kind === "column";
    case "comparison":
      return [tree.left, tree.right].every(
        (value) =>
          value.tree.kind === "column" || value.tree.kind === "literal",
      );
    case "junction":
      return tree.predicates.every(isIndexPredicate);
    case "group":
      return isIndexPredicate(tree.predicate);
    case "exists":
    case "in-query":
    case "in-values":
    case "like":
      return false;
  }
}

function conflictTarget(input: ConflictTargetInput): ConflictTarget {
  const first = input.target[0];
  if (!isColumn(first))
    throw new Error("query-builder: conflict target needs schema columns");
  const source = first.source;
  if (source.kind !== "table" || source.alias !== null || source.nullExtended)
    throw new Error("query-builder: conflict target must be an insert target");
  const names = new Set<string>();
  for (const column of input.target) {
    if (!isColumn(column) || column.source !== source)
      throw new Error("query-builder: conflict columns must share a target");
    const name = column.name.toLowerCase();
    if (names.has(name))
      throw new Error("query-builder: duplicate conflict target column");
    names.add(name);
  }
  const where = input.targetWhere ?? null;
  if (where !== null) {
    assertPredicate(where);
    ReadScope.assertVisible(where.sources, [source]);
    if (!isIndexPredicate(where))
      throw new Error(
        "query-builder: conflict target needs a static index predicate",
      );
  }
  return Object.freeze({
    source,
    columns: Object.freeze([...input.target]),
    where,
  });
}

function conflict<P extends Requirements>(
  target: ConflictTarget,
  action: ConflictAction,
  nodes: readonly Parameterized<Requirements>[],
): Conflict<P> {
  const result: Conflict<P> = Object.freeze({
    [CONFLICT]: true as const,
    target,
    action: Object.freeze(action),
    requirements: Object.freeze([...collectRequirements(nodes)]),
  });
  clauses.add(result);
  return result;
}

export function conflictDoNothing(
  input: ConflictTargetInput,
): Conflict<readonly []> {
  return conflict(conflictTarget(input), { kind: "nothing" }, []);
}

export function conflictDoUpdate<const I extends ConflictUpdateInput>(
  input: I & CompatibleRequirements<UpdateRequirements<NoInfer<I>>>,
): Conflict<UpdateRequirements<I>> {
  const target = conflictTarget(input);
  const excluded = tableSource(input.excluded);
  if (excluded.kind !== "excluded" || excluded.target !== target.source)
    throw new Error(
      "query-builder: excluded row belongs to another conflict target",
    );
  const visible = [target.source, excluded];
  const set = checkedAssignments(input.set, target.source, visible);
  const where = input.where ?? null;
  if (where !== null) {
    assertPredicate(where);
    if (where.hasAggregate)
      throw new Error(
        "query-builder: aggregate is not allowed in conflict WHERE",
      );
    ReadScope.assertVisible(where.sources, visible);
  }
  return conflict(target, { kind: "update", excluded, set, where }, [
    ...set,
    ...(where === null ? [] : [where]),
  ]);
}

export function assertConflict(value: AnyConflict, source: TableSource): void {
  if (!clauses.has(value))
    throw new Error("query-builder: conflict must come from a constructor");
  if (value.target.source !== source)
    throw new Error("query-builder: conflict belongs to another insert target");
}
