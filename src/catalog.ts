// The one source catalog every table, alias, CTE and derived source is minted
// in. Statement construction accepts only this catalog's columns and sources, so
// a structurally identical descriptor from anywhere else is refused.

import { SchemaSourceCatalog, type TableReference } from "./source-catalog";
import type { BrandOf } from "./column-catalog";
export type { Column, ColumnReference, BrandOf } from "./column-catalog";
export type {
  DefinedTable,
  NullableTable,
  TableReference,
  TableSource,
  CteDefinition,
  CteReference,
  CteRequirements,
  SourceRequirements,
  SourceColumn,
} from "./source-catalog";

const catalog = new SchemaSourceCatalog();
export const defineTable = catalog.defineTable.bind(catalog);
export const tableSource = catalog.tableSource.bind(catalog);
export const aliasTable = catalog.aliasTable.bind(catalog);
export const nullableAliasTable = catalog.nullableAliasTable.bind(catalog);
export const indexedBy = catalog.indexedBy.bind(catalog);
export const excludedTable = catalog.excludedTable.bind(catalog);
export const cte = catalog.cte.bind(catalog);
export const derived: SchemaSourceCatalog["derived"] =
  catalog.derived.bind(catalog);
export const jsonEachSource: SchemaSourceCatalog["jsonEach"] =
  catalog.jsonEach.bind(catalog);
export const cteDefinition = catalog.cteDefinition.bind(catalog);
export const isColumn = catalog.isColumn.bind(catalog);

// The row a table's columns describe, keyed by column name.
export type RowOf<T extends TableReference> = {
  -readonly [K in keyof T as K extends string ? K : never]: BrandOf<T[K]>;
};
