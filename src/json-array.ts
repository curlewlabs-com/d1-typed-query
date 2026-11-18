// The bind value a json_each source reads (jsonEach, json-each.ts): one
// JSON array of a single element domain's values, no longer than the maximum
// the source declares. It is minted only here, and its type carries the element
// type and that maximum, so a statement that reads keys cannot be bound with
// timestamps, and a list minted against another maximum does not type-check.
// The maximum is enforced here, at run time: a longer list is refused rather
// than bound, which is what bounds the rows a json_each source walks. A blob
// element travels as lowercase hex, because JSON has no byte
// string; the source decodes it with unhex() on the SQL side.

declare const ELEMENT: unique symbol;
declare const MAX_LENGTH: unique symbol;
export type JsonArrayOf<T, Max extends number> = string & {
  readonly [ELEMENT]: T;
  readonly [MAX_LENGTH]: Max;
};

type JsonArrayElement = number | string | ArrayLike<number>;

type IsUnion<T, U = T> = T extends unknown
  ? [U] extends [T]
    ? false
    : true
  : never;
type RoundTrips<N extends number> = `${N}` extends `${infer V extends number}`
  ? [V] extends [N]
    ? [N] extends [V]
      ? true
      : false
    : false
  : false;
// A maximum's type must be one numeric literal - not `number`, not a union,
// not a branded number - or two different maxima would share a type and a list
// minted against one would bind where the other is declared.
export type NumericLiteral<N extends number> = number extends N
  ? never
  : true extends IsUnion<N>
    ? never
    : [Exclude<keyof N, keyof number>] extends [never]
      ? RoundTrips<N> extends true
        ? N
        : never
      : never;

function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) =>
    (byte & 0xff).toString(16).padStart(2, "0"),
  ).join("");
}

export function jsonArrayOf<
  T extends JsonArrayElement,
  const Max extends number,
>(
  values: readonly T[],
  maxLength: Max & NumericLiteral<Max>,
): JsonArrayOf<T, Max> {
  if (!Number.isInteger(maxLength) || maxLength <= 0)
    throw new RangeError(
      `jsonArrayOf: the maximum must be a positive integer, got ${maxLength}`,
    );
  if (values.length > maxLength)
    throw new RangeError(
      `jsonArrayOf: ${values.length} elements exceed the source's declared maximum of ${maxLength}`,
    );
  // JSON.stringify writes NaN, an infinity and a missing position as null, and
  // the source would yield a NULL its non-null element domain cannot hold.
  const elements: (number | string)[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!(index in values))
      throw new RangeError(`jsonArrayOf: element ${index} is missing`);
    const value = values[index] as T;
    if (typeof value === "number" && !Number.isFinite(value))
      throw new RangeError(
        `jsonArrayOf: element ${index} is ${value}, which JSON cannot carry`,
      );
    elements.push(
      typeof value === "number" || typeof value === "string"
        ? value
        : hex(value),
    );
  }
  return JSON.stringify(elements) as JsonArrayOf<T, Max>;
}
