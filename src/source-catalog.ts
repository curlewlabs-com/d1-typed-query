// Nominal source construction owns table occurrences, projection-derived reads,
// and the column catalog. The package holds one instance (catalog.ts); a
// foreign instance cannot mint a source or column that instance accepts.

import {
  jsonArrayDomain,
  nullable,
  SqliteScalars,
  type Domain,
  type DomainValue,
  type ScalarDomain,
} from "./scalars";
import { assertSourceName, assertSqlIdentifier } from "./identifiers";

import type { AnyOutputColumn, OutputValue } from "./projections";
import type {
  Requirements,
  RequirementsOf,
  RuntimeRequirement,
} from "./params";
import type { JsonArrayOf, NumericLiteral } from "./json-array";
import { assertSelect, type AnySelect } from "./statements";

import {
  SchemaColumnCatalog,
  type Column,
  type ColumnReference,
} from "./column-catalog";

const CTE_PARAMETERS: unique symbol = Symbol("CteParameters");
const INLINE_PARAMETERS: unique symbol = Symbol("InlineParameters");
declare const DERIVED_COLUMN: unique symbol;

export interface CteDefinition {
  readonly name: string;
  readonly query: AnySelect;
  readonly form: "select" | "values";
  readonly materialization: "default" | "materialized";
}
export interface CteReference<
  P extends Requirements = Requirements,
> extends TableReference<readonly []> {
  readonly [CTE_PARAMETERS]: P;
}
export type CteRequirements<C> = C extends CteReference<infer P> ? P : never;
type CteColumns<O extends readonly AnyOutputColumn[]> = {
  readonly [C in O[number] as Extract<C["name"], string>]: Column<
    OutputValue<C>,
    Extract<C["name"], string>
  >;
};

const TABLE_SOURCE: unique symbol = Symbol("TableSource");
const SOURCE_IDENTITY: unique symbol = Symbol("SourceIdentity");

interface SourceIdentity {
  readonly [SOURCE_IDENTITY]: true;
  readonly table: string;
  readonly alias: string | null;
  readonly columnNames: readonly string[];
  readonly nullExtended: boolean;
}

export type TableSource = SourceIdentity &
  (
    | { readonly kind: "table" }
    | { readonly kind: "indexed-table"; readonly index: string }
    | { readonly kind: "excluded"; readonly target: TableSource }
    | { readonly kind: "cte"; readonly definition: CteDefinition }
    | { readonly kind: "derived"; readonly query: AnySelect }
    | {
        readonly kind: "json-each";
        readonly param: RuntimeRequirement;
        readonly element: ScalarDomain;
        readonly maxLength: number;
      }
  );

export interface TableReference<P extends Requirements = Requirements> {
  readonly [TABLE_SOURCE]: TableSource;
  readonly [INLINE_PARAMETERS]: P;
}
export type SourceRequirements<T> =
  T extends TableReference<infer P> ? P : readonly [];
export type SourceColumn = ColumnReference & {
  readonly [DERIVED_COLUMN]?: never;
};
type DerivedColumns<O extends readonly AnyOutputColumn[]> = {
  readonly [K in keyof CteColumns<O>]: CteColumns<O>[K] & {
    readonly [DERIVED_COLUMN]: true;
  };
};

// What jsonEach returns: the FROM occurrence, carrying its bind, and its value
// column, which is not a FROM input on its own (the same marker as a derived
// source's columns).
export type JsonEachReference<
  N extends string,
  T,
  Max extends number,
> = TableReference<readonly [readonly [N, JsonArrayOf<T, Max>]]> & {
  readonly value: Column<T | string, "value"> & {
    readonly [DERIVED_COLUMN]: true;
  };
};

export type DefinedTable<D extends Record<string, ScalarDomain>> = {
  readonly [K in keyof D]: Column<DomainValue<D[K]>, K & string>;
} & TableReference<readonly []>;

export type NullableTable<T extends TableReference> = {
  readonly [K in keyof T as K extends string ? K : never]: T[K] extends Column<
    infer V,
    infer N
  >
    ? Omit<T[K], "domain"> & Column<V | null, N>
    : never;
} & Pick<T, Exclude<keyof T, string>>;

export class SchemaSourceCatalog {
  // A CTE in scope shadows a table of the same name for every read inside
  // that scope, so neither name may take the other's, whichever comes first.
  private readonly physicalTableNames = new Set<string>();
  private readonly cteNames = new Set<string>();
  private readonly columnCatalog = new SchemaColumnCatalog();
  private readonly tablesCreated = new WeakSet<object>();

  /** Schema declarations mint columns only in their own catalog's authority. */
  defineTable<const D extends Record<string, ScalarDomain>>(
    table: string,
    domains: D,
  ): DefinedTable<D> {
    assertSourceName(table, "table");
    if (this.cteNames.has(table.toLowerCase()))
      throw new Error("query-builder: table cannot take a CTE's name");
    this.physicalTableNames.add(table.toLowerCase());
    const source: TableSource = Object.freeze({
      [SOURCE_IDENTITY]: true as const,
      kind: "table" as const,
      table,
      alias: null,
      nullExtended: false,
      columnNames: Object.freeze(Object.keys(domains)),
    });
    const columns = Object.fromEntries(
      Object.entries(domains).map(([name, domain]) => [
        name,
        this.columnCatalog.create(source, name, domain),
      ]),
    );
    // The symbol metadata is excluded from the column enumeration that derives
    // complete schema registries. Every string key above is constructed together
    // with its source and domain, so the mapped type follows this single boundary.
    const result = Object.freeze({
      ...columns,
      [TABLE_SOURCE]: source,
      [INLINE_PARAMETERS]: Object.freeze([]),
    });
    this.tablesCreated.add(result);
    return result as DefinedTable<D>;
  }

  /** Matching shape or SQL text cannot substitute for a registered occurrence. */
  tableSource(table: TableReference): TableSource {
    if (!this.tablesCreated.has(table)) {
      throw new Error("query-builder: table must come from the schema model");
    }
    return table[TABLE_SOURCE];
  }

  private aliasedTable<T extends TableReference>(
    table: T,
    alias: string,
    nullExtended: boolean,
  ): T | NullableTable<T> {
    assertSourceName(alias, "table alias");
    const original = this.tableSource(table);
    if (original.kind === "excluded")
      throw new Error("query-builder: excluded source cannot be aliased");
    // A json_each source takes its alias at construction (jsonEach), where its
    // FROM text is rendered from it.
    if (original.kind === "json-each")
      throw new Error("query-builder: json_each source cannot be aliased");
    const source: TableSource = Object.freeze({
      ...original,
      table: original.table,
      alias,
      nullExtended: nullExtended || original.nullExtended,
      columnNames: original.columnNames,
    });
    return this.sourceOccurrence(table, source);
  }

  private sourceOccurrence<T extends TableReference>(
    table: T,
    source: TableSource,
  ): T {
    const columns = Object.fromEntries(
      Object.entries(table).map(([name, value]: [string, unknown]) => {
        if (!this.isColumn(value)) {
          throw new Error(
            `query-builder: table field "${name}" is not a column`,
          );
        }
        return [
          name,
          this.columnCatalog.create(
            source,
            name,
            source.nullExtended ? nullable(value.domain) : value.domain,
          ),
        ];
      }),
    );
    const result = Object.freeze({
      ...table,
      ...columns,
      [TABLE_SOURCE]: source,
    });
    this.tablesCreated.add(result);
    return result;
  }

  /**
   * Pins a physical read occurrence to an index without changing its column
   * domains. Use the returned columns: this creates a fresh source identity.
   * Aliases retain the hint; mutation targets and replacing a hint are rejected.
   * The identifier is checked here; D1 preparation checks index membership and
   * whether the query can use it, including partial-index predicates.
   * See docs/design.md sec."Joined source construction".
   */
  indexedBy<T extends TableReference>(table: T, index: string): T {
    assertSqlIdentifier(index, "index");
    const original = this.tableSource(table);
    if (original.kind !== "table")
      throw new Error(
        "query-builder: INDEXED BY needs an unpinned physical read source",
      );
    return this.sourceOccurrence(
      table,
      Object.freeze({
        ...original,
        kind: "indexed-table" as const,
        index,
      }),
    );
  }

  /** EXCLUDED retains its physical destination identity for conflict-arm checks. */
  excludedTable<T extends TableReference>(table: T): T {
    const target = this.tableSource(table);
    if (target.kind !== "table" || target.alias !== null || target.nullExtended)
      throw new Error("query-builder: excluded needs a physical insert target");
    return this.sourceOccurrence(
      table,
      Object.freeze({
        [SOURCE_IDENTITY]: true as const,
        kind: "excluded" as const,
        target,
        table: target.table,
        alias: "excluded",
        nullExtended: false,
        columnNames: target.columnNames,
      }),
    );
  }

  /** Fresh columns keep equal alias text from merging unrelated occurrences. */
  aliasTable<T extends TableReference>(table: T, alias: string): T {
    return this.aliasedTable(table, alias, false) as T;
  }

  /** Optional rows widen outputs while retaining the source's input contract. */
  nullableAliasTable<T extends TableReference>(
    table: T,
    alias: string,
  ): NullableTable<T> {
    return this.aliasedTable(table, alias, true) as NullableTable<T>;
  }

  /**
   * Derives named columns from a checked SELECT instead of accepting independent
   * column-domain declarations. Outer-row capture is rejected. VALUES is limited
   * to a source-free, unfiltered, non-aggregate projection without a tail or WITH,
   * so changing its form cannot discard clauses. Attach this definition with
   * withCtes; constructing a reference alone does not put it in SQL scope.
   * Materialization is an explicit planning fence, retained in the definition;
   * callers must verify the access plan when requesting it.
   * See docs/design.md sec."CTE definition identity and scope".
   */
  cte<S extends AnySelect>(
    name: string,
    query: S,
    options: {
      readonly form?: "select" | "values";
      readonly materialization?: "default" | "materialized";
    } = {},
  ): CteReference<RequirementsOf<S>> & CteColumns<S["outputs"]> {
    assertSourceName(name, "CTE");
    assertSelect(query);
    if (this.physicalTableNames.has(name.toLowerCase()))
      throw new Error("query-builder: CTE cannot shadow a physical table");
    if (query.sources.length !== 0)
      throw new Error("query-builder: CTE cannot capture outer sources");
    const form = options.form ?? "select";
    if (form !== "select" && form !== "values")
      throw new Error("query-builder: invalid CTE form");
    const materialization = options.materialization ?? "default";
    if (materialization !== "default" && materialization !== "materialized")
      throw new Error("query-builder: invalid CTE materialization");
    const tree = query.tree;
    if (
      form === "values" &&
      (tree.kind !== "select" ||
        tree.source !== null ||
        tree.where !== null ||
        tree.orderBy.length !== 0 ||
        tree.limit !== null ||
        query.ctes.length !== 0 ||
        tree.columns.some((item) => item.value.hasAggregate))
    )
      throw new Error(
        "query-builder: VALUES CTE needs a source-free projection",
      );
    const outputs = query.outputs.map((output) => {
      if (output.name === null)
        throw new Error("query-builder: CTE needs named output columns");
      return { name: output.name, domain: output.domain };
    });
    const definition: CteDefinition = Object.freeze({
      name,
      query,
      form,
      materialization,
    });
    this.cteNames.add(name.toLowerCase());
    const source: TableSource = Object.freeze({
      [SOURCE_IDENTITY]: true as const,
      kind: "cte" as const,
      definition,
      table: name,
      alias: null,
      nullExtended: false,
      columnNames: Object.freeze(outputs.map((output) => output.name)),
    });
    const columns = Object.fromEntries(
      outputs.map((output) => [
        output.name,
        this.columnCatalog.create(source, output.name, output.domain),
      ]),
    );
    // The checked output tuple supplies every field; no query-local domain is
    // admitted while assigning its mapped column type.
    const result = Object.freeze({
      ...columns,
      [TABLE_SOURCE]: source,
      [CTE_PARAMETERS]: query.requirements,
      [INLINE_PARAMETERS]: Object.freeze([]),
    });
    this.tablesCreated.add(result);
    return result as unknown as CteReference<RequirementsOf<S>> &
      CteColumns<S["outputs"]>;
  }

  /**
   * Embeds a checked read as a source while retaining its complete bind tuple.
   * Named outputs provide the columns; outer-row capture is not legal in this
   * FROM position. Use the complete returned source in FROM and its columns in
   * expressions. Aliasing and LEFT JOIN preserve the nested requirements.
   * See docs/design.md sec."Derived read sources".
   */
  derived<S extends AnySelect>(
    alias: string,
    query: S,
  ): TableReference<RequirementsOf<S>> & DerivedColumns<S["outputs"]> {
    assertSourceName(alias, "derived source alias");
    assertSelect(query);
    if (query.sources.length !== 0)
      throw new Error(
        "query-builder: derived source cannot capture outer sources",
      );
    const outputs = query.outputs.map((output) => {
      if (output.name === null)
        throw new Error(
          "query-builder: derived source needs named output columns",
        );
      return { name: output.name, domain: output.domain };
    });
    const source: TableSource = Object.freeze({
      [SOURCE_IDENTITY]: true as const,
      kind: "derived" as const,
      query,
      table: alias,
      alias,
      nullExtended: false,
      columnNames: Object.freeze(outputs.map((output) => output.name)),
    });
    const columns = Object.fromEntries(
      outputs.map((output) => [
        output.name,
        this.columnCatalog.create(source, output.name, output.domain),
      ]),
    );
    const result = Object.freeze({
      ...columns,
      [TABLE_SOURCE]: source,
      [INLINE_PARAMETERS]: query.requirements,
    });
    this.tablesCreated.add(result);
    // Column markers are erased; source.kind enforces the same shorthand
    // rejection at runtime. The immutable output tuple supplies every domain.
    return result as unknown as TableReference<RequirementsOf<S>> &
      DerivedColumns<S["outputs"]>;
  }

  /**
   * A json_each(:name) source over a JSON array of `element` values, bound with
   * jsonArrayOf (json-array-param.ts). Its one column, `value`, holds the
   * element as JSON carries it: the element domain itself, or its hex TEXT for
   * a blob element, which jsonEach (query-json-each.ts) decodes. The bind
   * belongs to the FROM occurrence, as a derived source's do.
   * See docs/design.md sec."JSON array sources".
   */
  jsonEach<const N extends string, T, const Max extends number>(
    alias: string,
    name: N,
    element: Domain<T>,
    maxLength: Max & NumericLiteral<Max>,
  ): JsonEachReference<N, T, Max> {
    assertSourceName(alias, "json_each source alias");
    assertSqlIdentifier(name, "parameter");
    const param: RuntimeRequirement = Object.freeze({
      name,
      domain: jsonArrayDomain<T, Max>(element, maxLength),
    });
    const source: TableSource = Object.freeze({
      [SOURCE_IDENTITY]: true as const,
      kind: "json-each" as const,
      param,
      element,
      maxLength,
      table: alias,
      alias,
      nullExtended: false,
      columnNames: Object.freeze(["value"]),
    });
    const result = Object.freeze({
      value: this.columnCatalog.create(
        source,
        "value",
        (element.storage === "blob"
          ? SqliteScalars.text
          : element) as ScalarDomain,
      ),
      [TABLE_SOURCE]: source,
      [INLINE_PARAMETERS]: Object.freeze([param]),
    });
    this.tablesCreated.add(result);
    // The column marker is erased; sourceOf enforces the same FROM-shorthand
    // rejection at runtime, as for a derived source.
    return result as unknown as JsonEachReference<N, T, Max>;
  }

  /** WITH declares the definition; aliased or optional read occurrences cannot. */
  cteDefinition(reference: CteReference): CteDefinition {
    const source = this.tableSource(reference);
    if (source.kind !== "cte" || source.alias !== null || source.nullExtended)
      throw new Error("query-builder: WITH needs an unaliased CTE definition");
    return source.definition;
  }

  /** Foreign catalog output is structurally valid but outside this authority. */
  isColumn(value: unknown): value is ColumnReference {
    return this.columnCatalog.has(value);
  }
}
