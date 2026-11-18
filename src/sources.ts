// Read scopes own source occurrence visibility and ordered join clauses. Schema
// construction supplies nominal columns; predicates supply checked dependencies
// and bind requirements, so neither alias text nor copied nodes establish scope.

import {
  isColumn,
  tableSource,
  nullableAliasTable,
  type SourceColumn,
  type SourceRequirements,
  type TableReference,
  type TableSource,
} from "./catalog";
import { assertPredicate, type AnyPredicate } from "./expressions";
import type { Parameterized, Requirements, RequirementsOf } from "./params";

const JOIN: unique symbol = Symbol("JoinClause");
const joinsCreated = new WeakSet();
export type SourceInput = TableReference | SourceColumn;

type JoinClause =
  | { readonly kind: "comma" | "cross"; readonly on: null }
  | { readonly kind: "inner" | "left"; readonly on: AnyPredicate };

export type Join<
  T extends TableReference,
  P extends Requirements,
> = Parameterized<P> &
  JoinClause & {
    readonly [JOIN]: true;
    readonly source: T;
    readonly sources: readonly TableSource[];
  };
export type AnyJoin = Join<TableReference, Requirements>;

function join<T extends TableReference, P extends Requirements>(
  source: T,
  clause: JoinClause,
): Join<T, P> {
  tableSource(source);
  const { on } = clause;
  if (on !== null) {
    assertPredicate(on);
    if (on.hasAggregate)
      throw new Error("query-builder: aggregate is not allowed in ON");
  }
  const result: Join<T, P> = Object.freeze({
    [JOIN]: true as const,
    ...clause,
    source,
    sources: Object.freeze([...(on?.sources ?? [])]),
    requirements: Object.freeze([
      ...sourceRequirements(tableSource(source)),
      ...(on?.requirements ?? []),
    ]),
  });
  joinsCreated.add(result);
  return result;
}

/**
 * The enclosing statement checks ON visibility in join order: it may read this
 * source and already-visible sources, but not a later join. Reuse the same source
 * occurrence for the predicate and subsequent projections.
 * See docs/design.md sec."Joined source construction".
 */
export function innerJoin<T extends TableReference, P extends AnyPredicate>(
  source: T,
  on: P,
): Join<T, readonly [...SourceRequirements<T>, ...RequirementsOf<P>]> {
  return join(source, { kind: "inner", on });
}

/**
 * Preserves a comma-joined source without inventing an ON predicate. Any filter
 * belongs in the enclosing read's WHERE; source order still controls visibility.
 * See docs/design.md sec."Joined source construction".
 */
export function commaJoin<T extends TableReference>(
  source: T,
): Join<T, SourceRequirements<T>> {
  return join(source, { kind: "comma", on: null });
}

/**
 * Retains an explicit CROSS JOIN and its planner ordering constraint. Filters
 * belong in WHERE; the source remains the exact checked occurrence supplied.
 * Callers preserving an access path must verify the resulting D1 plan.
 * See docs/design.md sec."Joined source construction".
 */
export function crossJoin<T extends TableReference>(
  source: T,
): Join<T, SourceRequirements<T>> {
  return join(source, { kind: "cross", on: null });
}

/**
 * Build ON from the callback's nullable alias and use the returned join.source
 * for later reads. Its nullability represents a missing joined row even when the
 * underlying storage column is required. The original table and this optional
 * alias are distinct source occurrences, even when they describe the same table.
 * See docs/design.md sec."Joined source construction".
 */
export function leftJoin<T extends TableReference, P extends AnyPredicate>(
  table: T,
  alias: string,
  on: (source: ReturnType<typeof nullableAliasTable<T>>) => P,
): Join<
  ReturnType<typeof nullableAliasTable<T>>,
  readonly [...SourceRequirements<T>, ...RequirementsOf<P>]
> {
  const source = nullableAliasTable(table, alias);
  return join(source, { kind: "left", on: on(source) });
}

export function sourceOf(input: SourceInput): TableSource {
  if (
    isColumn(input) &&
    (input.source.kind === "derived" || input.source.kind === "json-each")
  )
    throw new Error(
      `query-builder: ${input.source.kind} FROM requires the complete source, not a column`,
    );
  return isColumn(input) ? input.source : tableSource(input);
}

/** Inline source binds belong at FROM/JOIN, never at a projected column use. */
export function sourceRequirements(source: TableSource | null) {
  if (source?.kind === "derived") return source.query.requirements;
  if (source?.kind === "json-each") return [source.param];
  return [];
}

export class ReadScope {
  readonly source: TableSource | null;
  readonly joins: readonly AnyJoin[];
  readonly local: readonly TableSource[];
  readonly visible: readonly TableSource[];

  constructor(
    from: SourceInput | undefined,
    joins: readonly AnyJoin[],
    outer: readonly SourceInput[],
  ) {
    this.source = from === undefined ? null : sourceOf(from);
    if (this.source === null && joins.length !== 0)
      throw new Error("query-builder: joins require a FROM source");
    if (this.source?.kind === "excluded")
      throw new Error("query-builder: excluded cannot be a FROM source");
    const local = this.source === null ? [] : [this.source];
    const visible = [...local, ...outer.map(sourceOf)];
    const qualifiers = new Set<string>();
    const register = (source: TableSource) => {
      const qualifier = (source.alias ?? source.table).toLowerCase();
      if (qualifiers.has(qualifier))
        throw new Error(
          `query-builder: duplicate source qualifier "${qualifier}"`,
        );
      qualifiers.add(qualifier);
    };
    for (const source of visible) register(source);
    for (const clause of joins) {
      if (!joinsCreated.has(clause))
        throw new Error("query-builder: join must come from a constructor");
      const source = tableSource(clause.source);
      if (source.kind === "excluded")
        throw new Error("query-builder: excluded cannot be a joined source");
      register(source);
      local.push(source);
      visible.push(source);
      ReadScope.assertVisible(clause.sources, visible);
    }
    this.local = Object.freeze(local);
    this.visible = Object.freeze(visible);
    this.joins = Object.freeze([...joins]);
    Object.freeze(this);
  }

  static where(
    where: AnyPredicate | undefined,
    visible: readonly TableSource[],
  ): AnyPredicate | null {
    if (where === undefined) return null;
    assertPredicate(where);
    if (where.hasAggregate)
      throw new Error("query-builder: aggregate is not allowed in WHERE");
    ReadScope.assertVisible(where.sources, visible);
    return where;
  }

  static assertVisible(
    sources: readonly TableSource[],
    visible: readonly TableSource[],
  ): void {
    for (const source of sources) {
      if (!visible.includes(source))
        throw new Error(
          `query-builder: source "${source.alias ?? source.table}" is outside this statement's scope`,
        );
    }
  }

  outerDependencies(sources: readonly TableSource[]): readonly TableSource[] {
    return sources.filter((source) => !this.local.includes(source));
  }
}
