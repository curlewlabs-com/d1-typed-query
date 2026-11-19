// Semantic domains for schema columns and column-free expressions: the
// constructors an application declares its own domains with, the generic
// SQLite domains every application shares, and the type-level relations an
// application declares between its domains.
//
// A domain is a canonical object, compared by identity. A descriptor that was
// not made by domain(), refinement() or nullable() is refused, so two domains
// with the same name and storage never stand in for each other.

import type { EpochSeconds, Seconds } from "./brand";
import type { DomainRelations } from "./index";
import type { JsonArrayOf, NumericLiteral } from "./json-array";

const DOMAIN: unique symbol = Symbol("SqlDomain");
const VALUE: unique symbol = Symbol("SqlDomainValue");
const domains = new WeakSet();

type Relation<K extends string> = DomainRelations extends {
  readonly [P in K]: infer V;
}
  ? V
  : never;
export type StoredUuid = Relation<"storedUuid">;
export type DomainRefinements = Relation<"refinements">;

function canonical<D extends ScalarDomain>(value: D): D {
  domains.add(value);
  return Object.freeze(value);
}

export function assertDomain(value: ScalarDomain): void {
  if (!domains.has(value))
    throw new Error(
      "query-builder: domain must come from the central scalar definitions",
    );
}

export interface ScalarDomain {
  readonly [DOMAIN]: true;
  readonly name: string;
  readonly storage: "integer" | "text" | "blob";
  readonly nullable: boolean;
  readonly nonNull: ScalarDomain | null;
  readonly refines: ScalarDomain | null;
  readonly storedUuid: boolean;
}

export interface Domain<T> extends ScalarDomain {
  readonly [VALUE]?: (value: T) => T;
}

export type DomainValue<D> = D extends Domain<infer T> ? T : never;

/**
 * A new semantic domain, distinct from every other even where the stored
 * representation matches. `storedUuid` marks a blob domain whose values are 16
 * random bytes: only such a domain accepts randomBlob16() and storedUuidHex().
 * Declare each value type marked this way in DomainRelations["storedUuid"].
 */
export function domain<T>(
  name: string,
  storage: ScalarDomain["storage"],
  options: { readonly storedUuid?: boolean } = {},
): Domain<T> {
  const storedUuid = options.storedUuid ?? false;
  return canonical({
    [DOMAIN]: true as const,
    name,
    storage,
    nullable: false,
    nonNull: null,
    refines: null,
    storedUuid,
  });
}

/**
 * A narrower domain whose values are also values of `base`: a refined bind may
 * be written where `base` is read, never the other way round. Declare the pair
 * in DomainRelations["refinements"] as [T, Base].
 */
export function refinement<T extends Base, Base>(
  name: string,
  base: Domain<Base>,
): Domain<T> {
  assertDomain(base);
  // Nullability belongs to a column or a bind, never to a refinement's base:
  // acceptsDomain compares non-null descriptors, which a nullable base is not.
  if (base.nullable)
    throw new Error("query-builder: a refinement's base must be non-null");
  return canonical({
    [DOMAIN]: true as const,
    name,
    storage: base.storage,
    nullable: false,
    nonNull: null,
    refines: base,
    storedUuid: base.storedUuid,
  });
}

// The domains every application shares. `count` is a non-negative quantity, a
// LIMIT and the result of COUNT(*); `flag` is a 0/1 boolean; `one` is a
// singleton row key; `epochSeconds` and `seconds` are the time algebra's
// instant and duration.
export const SqliteScalars = Object.freeze({
  integer: domain<number>("integer", "integer"),
  count: domain<number>("count", "integer"),
  text: domain<string>("text", "text"),
  bytes: domain<ArrayLike<number>>("bytes", "blob"),
  flag: domain<0 | 1>("flag", "integer"),
  one: domain<1>("one", "integer"),
  epochSeconds: domain<EpochSeconds>("EpochSeconds", "integer"),
  seconds: domain<Seconds>("Seconds", "integer"),
} as const);

const nullableDomains = new WeakMap<ScalarDomain, ScalarDomain>();

// The domain of a json_each source's bind (json-each.ts): a JSON array of at
// most `maxLength` `element` values, stored as TEXT. One canonical domain per
// element descriptor and maximum - keyed by the descriptor itself, never its
// name - so sources over the same element and maximum share a compatible bind.
const jsonArrayDomains = new WeakMap<ScalarDomain, Map<number, ScalarDomain>>();
export function jsonArrayDomain<T, const Max extends number>(
  element: Domain<T>,
  maxLength: Max & NumericLiteral<Max>,
): Domain<JsonArrayOf<T, Max>> {
  assertDomain(element);
  if (element.nullable)
    throw new Error("query-builder: JSON array element must be non-null");
  if (!Number.isInteger(maxLength) || maxLength <= 0)
    throw new Error(
      "query-builder: JSON array maximum length must be a positive integer",
    );
  let byMax = jsonArrayDomains.get(element);
  if (byMax === undefined) {
    byMax = new Map();
    jsonArrayDomains.set(element, byMax);
  }
  let array = byMax.get(maxLength);
  if (array === undefined) {
    array = domain<JsonArrayOf<T, Max>>(
      `JsonArray<${element.name}, ${maxLength}>`,
      "text",
    );
    byMax.set(maxLength, array);
  }
  return array;
}

export function nullable<D extends ScalarDomain>(
  original: D,
): Domain<DomainValue<D> | null> {
  assertDomain(original);
  if (original.nullable) return original;
  const existing = nullableDomains.get(original);
  if (existing !== undefined) return existing;
  const result = canonical({
    ...original,
    nullable: true,
    nonNull: original,
  });
  nullableDomains.set(original, result);
  return result;
}

export function nonNullableDomain<D extends ScalarDomain>(
  original: D,
): Domain<NonNullable<DomainValue<D>>> {
  assertDomain(original);
  return original.nonNull ?? original;
}

export function acceptsDomain(
  destination: ScalarDomain,
  source: ScalarDomain,
): boolean {
  assertDomain(destination);
  assertDomain(source);
  if (source.nullable && !destination.nullable) return false;
  const target = destination.nonNull ?? destination;
  let candidate: ScalarDomain | null = source.nonNull ?? source;
  while (candidate !== null) {
    if (candidate === target) return true;
    candidate = candidate.refines;
  }
  return false;
}
