// Statement construction owns clause structure, source visibility, and parameter
// agreement. The renderer receives only nominal nodes whose children passed
// these checks, including assignments that cannot escape their destination.

import {
  isColumn,
  cteDefinition,
  type CteDefinition,
  type CteReference,
  type CteRequirements,
  type ColumnReference,
  type SourceRequirements,
  type TableSource,
} from "./catalog";
import {
  ReadScope,
  sourceOf,
  sourceRequirements,
  type SourceInput,
  type AnyJoin,
} from "./sources";
import {
  collectRequirements,
  type CollectRequirements,
  type CompatibleRequirements,
  type Parameterized,
  type Requirements,
  type RequirementsOf,
  type SameType,
} from "./params";
import type { AnyExpression, AnyPredicate } from "./expressions";
import { checkedAssignments, type AnyAssignment } from "./assignments";
import {
  projectionOutputs,
  columnOutputs,
  type ColumnOutputs,
  type ColumnRow,
  type AnyProjection,
  type AnyOrder,
  type ProjectionRow,
  type LimitExpression,
  type AnyOutputColumn,
  type OutputColumn,
  type OutputValue,
  type OutputRow,
  type ProjectionOutputs,
} from "./projections";
import { nullable, nonNullableDomain } from "./scalars";

import { assertConflict, type AnyConflict } from "./conflicts";

import { SelectBody, assertLimit } from "./select-body";

const STATEMENT: unique symbol = Symbol("SqlStatement");
const ROW: unique symbol = Symbol("StatementRow");
const statements = new WeakSet();

type OptionalRequirements<I, K extends PropertyKey> = K extends keyof I
  ? RequirementsOf<I[K]>
  : readonly [];
type OrderRequirements<I> = I extends {
  readonly orderBy: infer O extends readonly AnyOrder[];
}
  ? CollectRequirements<O>
  : readonly [];

type JoinRequirements<I> = I extends {
  readonly joins: infer J extends readonly AnyJoin[];
}
  ? CollectRequirements<J>
  : readonly [];

export interface SelectInput {
  readonly from?: SourceInput;
  readonly joins?: readonly AnyJoin[];
  readonly outer?: readonly SourceInput[];
  readonly columns: readonly AnyProjection[];
  readonly where?: AnyPredicate;
  readonly orderBy?: readonly AnyOrder[];
  readonly limit?: LimitExpression;
}
type SelectRequirements<I extends SelectInput> = readonly [
  ...CollectRequirements<I["columns"]>,
  ...SourceRequirements<I["from"]>,
  ...JoinRequirements<I>,
  ...OptionalRequirements<I, "where">,
  ...OrderRequirements<I>,
  ...OptionalRequirements<I, "limit">,
];
interface MutationInput {
  readonly returning?: readonly ColumnReference[];
  readonly table: SourceInput;
  readonly where?: AnyPredicate;
}
export interface UpdateInput extends MutationInput {
  readonly set: readonly AnyAssignment[];
}
export interface InsertInput extends MutationInput {
  readonly onConflict?: AnyConflict;
  readonly orIgnore?: true;
  readonly from?: SourceInput;
  readonly joins?: readonly AnyJoin[];
  readonly values: readonly AnyAssignment[];
}
type UpdateRequirements<I extends UpdateInput> = readonly [
  ...CollectRequirements<I["set"]>,
  ...OptionalRequirements<I, "where">,
];
type InsertRequirements<I extends InsertInput> = readonly [
  ...CollectRequirements<I["values"]>,
  ...SourceRequirements<I["from"]>,
  ...JoinRequirements<I>,
  ...OptionalRequirements<I, "where">,
  ...OptionalRequirements<I, "onConflict">,
];

export interface SelectTree<
  C extends readonly AnyProjection[] = readonly AnyProjection[],
> {
  readonly kind: "select";
  readonly source: TableSource | null;
  readonly joins: readonly AnyJoin[];
  readonly columns: C;
  readonly where: AnyPredicate | null;
  readonly orderBy: readonly AnyOrder[];
  readonly limit: AnyExpression | null;
}

interface CompoundSelectTree<
  O extends readonly AnyOutputColumn[] = readonly AnyOutputColumn[],
> {
  readonly kind: "compound-select";
  readonly operator: "UNION" | "UNION ALL";
  readonly arms: readonly AnySimpleSelect[];
  readonly limit: AnyExpression | null;
  readonly outputs: O;
}

type StatementOutputs<T extends StatementTree> =
  T extends SelectTree<infer C>
    ? ProjectionOutputs<C>
    : T extends CompoundSelectTree<infer O>
      ? O
      : T extends MutationTree<infer C>
        ? ColumnOutputs<C>
        : never;

export type MutationTree<
  C extends readonly ColumnReference[] = readonly ColumnReference[],
> = {
  readonly source: TableSource;
  readonly where: AnyPredicate | null;
  readonly returning: C;
} & (
  | { readonly kind: "update"; readonly set: readonly AnyAssignment[] }
  | { readonly kind: "delete" }
  | {
      readonly kind: "insert";
      readonly onConflict: AnyConflict | null;
      readonly orIgnore: boolean;
      readonly from: TableSource | null;
      readonly joins: readonly AnyJoin[];
      readonly values: readonly AnyAssignment[];
    }
);
type StatementTree = SelectTree | CompoundSelectTree | MutationTree;
type ReturningColumns<I extends MutationInput> = I extends {
  readonly returning: infer C extends readonly ColumnReference[];
}
  ? C
  : readonly [];
type ReturningRow<I extends MutationInput> = I extends {
  readonly returning: readonly ColumnReference[];
}
  ? ColumnRow<ReturningColumns<I>>
  : never;

export interface Statement<
  P extends Requirements,
  R = never,
  T extends StatementTree = StatementTree,
> extends Parameterized<P> {
  readonly [STATEMENT]: true;
  readonly [ROW]?: R;
  readonly tree: T;
  readonly ctes: readonly CteDefinition[];
  readonly outputs: StatementOutputs<T>;
  readonly sources: readonly TableSource[];
}
export type AnyStatement = Statement<Requirements, unknown>;
export type SelectStatement<
  P extends Requirements,
  C extends readonly AnyProjection[],
> = Statement<P, ProjectionRow<C>, SelectTree<C>>;
export type AnySimpleSelect = SelectStatement<
  Requirements,
  readonly AnyProjection[]
>;
export type SingleSimpleSelect = SelectStatement<
  Requirements,
  readonly [AnyProjection]
>;
export type CompoundSelectStatement<
  P extends Requirements,
  O extends readonly AnyOutputColumn[],
> = Statement<P, OutputRow<O>, CompoundSelectTree<O>>;
export type AnySelect =
  | AnySimpleSelect
  | CompoundSelectStatement<Requirements, readonly AnyOutputColumn[]>;
export type SingleSelect =
  | SingleSimpleSelect
  | CompoundSelectStatement<Requirements, readonly [AnyOutputColumn]>;
export type StatementRow<S> =
  S extends Statement<Requirements, infer R> ? R : never;

// Copy caller-owned collections before granting constructor identity so later
// array edits cannot invalidate the checked clause graph or bind agreement.
function statement<
  P extends Requirements,
  R = never,
  T extends StatementTree = StatementTree,
>(
  tree: T,
  nodes: readonly Parameterized<Requirements>[],
  sources: readonly TableSource[] = [],
  ctes: readonly CteDefinition[] = [],
): Statement<P, R, T> {
  const result: Statement<P, R, T> = Object.freeze({
    [STATEMENT]: true as const,
    tree: Object.freeze(tree),
    ctes: Object.freeze([...ctes]),
    outputs: (tree.kind === "select"
      ? projectionOutputs(tree.columns)
      : tree.kind === "compound-select"
        ? tree.outputs
        : columnOutputs(tree.returning)) as StatementOutputs<T>,
    requirements: Object.freeze([...collectRequirements(nodes)]),
    sources: Object.freeze([...new Set(sources)]),
  });
  statements.add(result);
  return result;
}

type DefinitionRequirements<C extends readonly CteReference[]> =
  C extends readonly [
    infer H extends CteReference,
    ...infer T extends readonly CteReference[],
  ]
    ? readonly [...CteRequirements<H>, ...DefinitionRequirements<T>]
    : number extends C["length"]
      ? Requirements
      : readonly [];
type WithRequirements<
  C extends readonly CteReference[],
  S extends AnyStatement,
> = readonly [...DefinitionRequirements<C>, ...RequirementsOf<S>];

/**
 * Attach unaliased CTE definitions to a body that has no WITH of its own. Their
 * bind requirements precede the body's. Supply definitions in dependency order:
 * rendering checks exact definition identity and rejects missing or forward
 * references, duplicate names and shadowing. Attachment itself does not resolve
 * those lexical dependencies.
 * See docs/design.md sec."CTE definition identity and scope".
 */
export function withCtes<
  const C extends readonly CteReference[],
  S extends AnyStatement,
>(
  definitions: C,
  body: S & CompatibleRequirements<WithRequirements<NoInfer<C>, NoInfer<S>>>,
): Statement<WithRequirements<C, S>, StatementRow<S>, S["tree"]> {
  assertStatement(body);
  if (definitions.length === 0 || body.ctes.length !== 0)
    throw new Error(
      "query-builder: WITH needs definitions on an unwrapped statement",
    );
  const ctes = definitions.map(cteDefinition);
  return statement(
    body.tree,
    [...ctes.map((definition) => definition.query), body],
    body.sources,
    ctes,
  );
}

/**
 * Enforces constructor identity at runtime, where a cast or object copy could
 * otherwise bypass construction checks. This does not validate unresolved outer
 * sources; rendering a standalone query owns that check.
 */
export function assertStatement(value: AnyStatement): void {
  if (!statements.has(value))
    throw new Error("query-builder: statement must come from a constructor");
}

/**
 * A mutation with RETURNING still has write semantics and cannot be embedded as
 * a read. Check that boundary as well as constructor identity.
 */
export function assertSelect(value: AnySelect): void {
  assertStatement(value);
  // Read as unknown: an untyped caller can pass any statement here.
  const kind: unknown = value.tree.kind;
  if (kind !== "select" && kind !== "compound-select")
    throw new Error("query-builder: subquery must be a SELECT");
}

/**
 * Checks output-column arity for scalar and IN consumers. This says nothing
 * about result-row cardinality or whether a projected value can be NULL.
 */
export function assertSingleSelect(value: SingleSelect): void {
  assertSelect(value);
  // Read as a number: an untyped caller can pass a SELECT of any arity here.
  const arity: number = value.outputs.length;
  if (arity !== 1)
    throw new Error("query-builder: scalar subquery needs a single projection");
}

const COMPOUND_ERROR: unique symbol = Symbol("CompoundOutputMismatch");
type MatchingOutputs<
  L extends readonly AnyOutputColumn[],
  R extends readonly AnyOutputColumn[],
> = L extends readonly [
  infer H extends AnyOutputColumn,
  ...infer T extends readonly AnyOutputColumn[],
]
  ? R extends readonly [
      infer RH extends AnyOutputColumn,
      ...infer RT extends readonly AnyOutputColumn[],
    ]
    ? SameType<
        NonNullable<OutputValue<H>>,
        NonNullable<OutputValue<RH>>
      > extends true
      ? MatchingOutputs<T, RT>
      : { readonly [COMPOUND_ERROR]: "compound output domain mismatch" }
    : { readonly [COMPOUND_ERROR]: "compound output arity mismatch" }
  : R extends readonly []
    ? unknown
    : { readonly [COMPOUND_ERROR]: "compound output arity mismatch" };
type MatchingArms<A extends readonly AnySimpleSelect[]> = {
  readonly [K in keyof A]: A[K] &
    MatchingOutputs<A[0]["outputs"], A[K]["outputs"]>;
};
type MergeOutputs<
  L extends readonly AnyOutputColumn[],
  R extends readonly AnyOutputColumn[],
> = L extends readonly [
  infer H extends AnyOutputColumn,
  ...infer T extends readonly AnyOutputColumn[],
]
  ? R extends readonly [
      infer RH extends AnyOutputColumn,
      ...infer RT extends readonly AnyOutputColumn[],
    ]
    ? readonly [
        OutputColumn<H["name"], OutputValue<H> | OutputValue<RH>>,
        ...MergeOutputs<T, RT>,
      ]
    : never
  : readonly [];
type FoldOutputs<
  O extends readonly AnyOutputColumn[],
  A extends readonly AnySimpleSelect[],
> = A extends readonly [
  infer H extends AnySimpleSelect,
  ...infer T extends readonly AnySimpleSelect[],
]
  ? FoldOutputs<MergeOutputs<O, H["outputs"]>, T>
  : O;
type CompoundOutputs<A extends readonly AnySimpleSelect[]> =
  A extends readonly [
    infer H extends AnySimpleSelect,
    ...infer T extends readonly AnySimpleSelect[],
  ]
    ? FoldOutputs<H["outputs"], T>
    : never;

/**
 * Combines reads without deduplication. Output domains must agree by position;
 * nullability widens across arms and names come from the first arm. Supply simple
 * SELECT arms without their own ordering, limit or WITH; attach CTE definitions
 * around the compound instead. Bind requirements and outer dependencies
 * remain attached across arms.
 * See docs/design.md sec."Compound SELECT construction".
 */
export function unionAll<
  const A extends readonly [
    AnySimpleSelect,
    AnySimpleSelect,
    ...AnySimpleSelect[],
  ],
>(
  ...arms: A &
    MatchingArms<NoInfer<A>> &
    CompatibleRequirements<CollectRequirements<NoInfer<A>>>
): CompoundSelectStatement<CollectRequirements<A>, CompoundOutputs<A>> {
  return compoundSelect<A>("UNION ALL", arms);
}

/**
 * Removes duplicates using the complete projected row, including SQL's NULL
 * equality for compound results. Domain, source, arm-shape and bind obligations
 * are identical to unionAll; result order is unspecified without ordering.
 * See docs/design.md sec."Compound SELECT construction".
 */
export function union<
  const A extends readonly [
    AnySimpleSelect,
    AnySimpleSelect,
    ...AnySimpleSelect[],
  ],
>(
  ...arms: A &
    MatchingArms<NoInfer<A>> &
    CompatibleRequirements<CollectRequirements<NoInfer<A>>>
): CompoundSelectStatement<CollectRequirements<A>, CompoundOutputs<A>> {
  return compoundSelect<A>("UNION", arms);
}

// Compound operators share the same arm and output checks; only duplicate handling
// differs, so extending one cannot silently bypass the other's domain checks.
function compoundSelect<
  const A extends readonly [
    AnySimpleSelect,
    AnySimpleSelect,
    ...AnySimpleSelect[],
  ],
>(
  operator: "UNION" | "UNION ALL",
  arms: A,
): CompoundSelectStatement<CollectRequirements<A>, CompoundOutputs<A>> {
  if (arms.length < 2)
    throw new Error(`query-builder: ${operator} needs SELECT arms`);
  // D1's limit is lower than SQLite's; reject it before producing executable
  // SQL (SQLITE_MAX_COMPOUND_SELECT, which D1 sets to 5).
  if (arms.length > 5)
    throw new Error(`query-builder: ${operator} exceeds D1's SELECT arm limit`);
  for (const arm of arms) {
    assertSelect(arm);
    // Read as unknown: an untyped caller can pass a compound SELECT as an arm.
    const armKind: unknown = arm.tree.kind;
    if (
      armKind !== "select" ||
      arm.ctes.length !== 0 ||
      arm.tree.orderBy.length !== 0 ||
      arm.tree.limit !== null
    )
      throw new Error(
        "query-builder: compound arms must be SELECTs without ORDER BY or LIMIT and without WITH",
      );
  }
  const first = arms[0].outputs;
  for (const arm of arms) {
    if (arm.outputs.length !== first.length)
      throw new Error("query-builder: compound output arity mismatch");
  }
  const outputs = Object.freeze(
    first.map((output, position) => {
      const base = nonNullableDomain(output.domain);
      let domain = output.domain;
      for (const arm of arms) {
        const candidate = arm.outputs[position];
        if (candidate === undefined)
          throw new Error("query-builder: compound output arity mismatch");
        if (nonNullableDomain(candidate.domain) !== base)
          throw new Error("query-builder: compound output domain mismatch");
        if (candidate.domain.nullable) domain = nullable(base);
      }
      return Object.freeze({ name: output.name, domain });
    }),
  ) as CompoundOutputs<A>;
  return statement(
    {
      kind: "compound-select",
      operator,
      arms: Object.freeze([...arms]),
      outputs,
      limit: null,
    },
    arms,
    arms.flatMap((arm) => arm.sources),
  );
}

type LimitedRequirements<
  S extends AnySelect,
  L extends LimitExpression,
> = readonly [...RequirementsOf<S>, ...RequirementsOf<L>];

/**
 * Limits the complete read, including a compound, while retaining its output
 * and scope information. The count must be source-free and non-aggregate, and an
 * existing limit cannot be overwritten. Its bind follows the read's binds. A
 * limited aggregate no longer qualifies for aggregateSubquery's row guarantee.
 * See docs/design.md sec."Compound SELECT construction".
 */
export function limitRows<S extends AnySelect, L extends LimitExpression>(
  query: S,
  limit: L &
    CompatibleRequirements<LimitedRequirements<NoInfer<S>, NoInfer<L>>>,
): Statement<LimitedRequirements<S, L>, StatementRow<S>, S["tree"]> {
  assertSelect(query);
  assertLimit(limit);
  if (query.tree.limit !== null)
    throw new Error("query-builder: SELECT already has a LIMIT");
  return statement(
    { ...query.tree, limit },
    [query, limit],
    query.sources,
    query.ctes,
  );
}

/**
 * Declare correlated sources in outer using the exact source occurrences from
 * the enclosing query. Declaring them permits construction; embedding must still
 * resolve them, and buildQuery rejects unresolved outer sources. Projection and
 * clause validation preserves source scope and aggregate row guarantees before
 * the statement can be used as a nested value.
 * See docs/design.md sec."Subquery construction boundary".
 */
export function select<const I extends SelectInput>(
  input: I & CompatibleRequirements<SelectRequirements<NoInfer<I>>>,
): SelectStatement<SelectRequirements<I>, I["columns"]> {
  const body = new SelectBody(input);
  return statement(body.tree, body.nodes, body.sources);
}

function checkedReturning<I extends MutationInput>(
  input: I,
  source: TableSource,
): ReturningColumns<I> {
  const columns = input.returning;
  if (columns !== undefined && columns.length === 0)
    throw new Error("query-builder: RETURNING needs a destination column");
  const names = new Set<string>();
  for (const column of columns ?? []) {
    if (!isColumn(column) || column.source !== source)
      throw new Error("query-builder: RETURNING must name destination columns");
    const name = column.name.toLowerCase();
    if (names.has(name))
      throw new Error("query-builder: duplicate RETURNING column");
    names.add(name);
  }
  return Object.freeze([...(columns ?? [])]) as ReturningColumns<I>;
}

/**
 * Assignments and RETURNING belong to the destination occurrence; reads may
 * use that occurrence, including as an outer source for a correlated SELECT.
 * Omitting where targets the whole table.
 * See docs/design.md sec."Projection types and executor rows".
 */
export function update<const I extends UpdateInput>(
  input: I & CompatibleRequirements<UpdateRequirements<NoInfer<I>>>,
): Statement<
  UpdateRequirements<I>,
  ReturningRow<I>,
  MutationTree<ReturningColumns<I>>
> {
  const source = sourceOf(input.table);
  if (source.kind !== "table")
    throw new Error(
      "query-builder: mutation target must be a physical table without an index hint",
    );
  if (source.nullExtended)
    throw new Error(
      "query-builder: optional source cannot be a mutation target",
    );
  const set = checkedAssignments(input.set, source, [source]);
  const where = ReadScope.where(input.where, [source]);
  const returning = checkedReturning(input, source);
  return statement({ kind: "update", source, set, where, returning }, [
    ...set,
    ...(where === null ? [] : [where]),
  ]);
}

/**
 * Use an unaliased physical destination and destination-owned RETURNING columns.
 * Omitting where deletes the whole table, so callers must supply the intended
 * predicate explicitly.
 * See docs/design.md sec."Composable expressions and statements".
 */
export function deleteFrom<const I extends MutationInput>(
  input: I & CompatibleRequirements<OptionalRequirements<NoInfer<I>, "where">>,
): Statement<
  OptionalRequirements<I, "where">,
  ReturningRow<I>,
  MutationTree<ReturningColumns<I>>
> {
  const source = sourceOf(input.table);
  if (source.kind !== "table")
    throw new Error(
      "query-builder: mutation target must be a physical table without an index hint",
    );
  if (source.nullExtended)
    throw new Error(
      "query-builder: optional source cannot be a mutation target",
    );
  if (source.alias !== null)
    throw new Error("query-builder: DELETE target aliases are not supported");
  const where = ReadScope.where(input.where, [source]);
  const returning = checkedReturning(input, source);
  return statement(
    { kind: "delete", source, where, returning },
    where === null ? [] : [where],
  );
}

/**
 * The destination grants assignment ownership, not read visibility: values and
 * where read only declared FROM/join sources or self-contained subqueries. Use an
 * unaliased physical destination. A FROM read with ON CONFLICT needs an explicit
 * where to disambiguate SQLite's ON parsing. Choose OR IGNORE or a targeted
 * conflict clause.
 * See docs/design.md sec."Conflict-arm construction" and
 * sec."Projection types and executor rows".
 */
export function insert<const I extends InsertInput>(
  input: I & CompatibleRequirements<InsertRequirements<NoInfer<I>>>,
): Statement<
  InsertRequirements<I>,
  ReturningRow<I>,
  MutationTree<ReturningColumns<I>>
> {
  const source = sourceOf(input.table);
  if (source.kind !== "table")
    throw new Error(
      "query-builder: mutation target must be a physical table without an index hint",
    );
  if (source.nullExtended)
    throw new Error(
      "query-builder: optional source cannot be a mutation target",
    );
  if (source.alias !== null)
    throw new Error("query-builder: INSERT target aliases are not supported");
  // The destination does not grant read scope; values read only FROM and joins.
  const scope = new ReadScope(input.from, input.joins ?? [], []);
  const { source: from, visible, joins } = scope;
  const values = checkedAssignments(input.values, source, visible);
  const where = ReadScope.where(input.where, visible);
  const returning = checkedReturning(input, source);
  const onConflict = input.onConflict ?? null;
  // Read as unknown: an untyped caller reaches this check, and the field's type
  // does not constrain what it passes.
  const orIgnore: unknown = input.orIgnore;
  if (orIgnore !== undefined && orIgnore !== true)
    throw new Error("query-builder: invalid INSERT OR IGNORE policy");
  if (onConflict !== null) {
    assertConflict(onConflict, source);
    if (input.orIgnore === true)
      throw new Error(
        "query-builder: INSERT OR IGNORE cannot combine with ON CONFLICT",
      );
    // Without WHERE, SQLite can parse ON as belonging to the SELECT's join.
    if (from !== null && where === null)
      throw new Error(
        "query-builder: INSERT FROM with ON CONFLICT needs WHERE",
      );
  }
  return statement(
    {
      kind: "insert",
      source,
      from,
      joins,
      values,
      where,
      onConflict,
      orIgnore: input.orIgnore === true,
      returning,
    },
    [
      ...values,
      { requirements: sourceRequirements(from) },
      ...joins,
      ...(where === null ? [] : [where]),
      ...(onConflict === null ? [] : [onConflict]),
    ],
  );
}
