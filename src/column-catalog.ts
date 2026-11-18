// Nominal column construction owns the membership set used to reject copied
// or forged descriptors. The package's one source catalog (catalog.ts) holds
// its column catalog privately, so a descriptor made by another catalog cannot
// enter the checked query graph.

import { assertDomain, type Domain, type ScalarDomain } from "./scalars";
import type { TableSource } from "./source-catalog";
import { assertSqlIdentifier } from "./identifiers";

const COLUMN: unique symbol = Symbol("SchemaColumn");

export interface ColumnReference {
  readonly [COLUMN]: true;
  readonly table: string;
  readonly name: string;
  readonly source: TableSource;
  readonly domain: ScalarDomain;
}

export interface Column<
  T,
  Name extends string = string,
> extends ColumnReference {
  readonly name: Name;
  readonly domain: Domain<T>;
}

export type BrandOf<C> = C extends Column<infer T> ? T : never;

export class SchemaColumnCatalog {
  private readonly columns = new WeakSet<object>();

  /** Registers the descriptor only with this catalog, never a global authority. */
  create<T, Name extends string>(
    source: TableSource,
    name: Name,
    domain: Domain<T>,
  ): Column<T, Name> {
    assertSqlIdentifier(name, "column");
    // A copied descriptor has the right shape and none of the identity the
    // domain checks compare, so it is refused at the column it would type.
    assertDomain(domain);
    const result = Object.freeze({
      [COLUMN]: true as const,
      table: source.table,
      name,
      source,
      domain,
    });
    this.columns.add(result);
    return result;
  }

  /** Identity membership rejects copied descriptors and foreign catalog output. */
  has(value: unknown): value is ColumnReference {
    return (
      typeof value === "object" && value !== null && this.columns.has(value)
    );
  }
}
