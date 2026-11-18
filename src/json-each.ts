// The json_each source primitive: a FROM occurrence over one bound JSON array
// whose elements share a declared domain and whose length has a declared
// maximum, and the typed expression for its element. The array is minted by
// jsonArrayOf (json-array-param.ts), which refuses a longer list, so the bind's
// element type and maximum are checked like any other bind.

import type { Domain } from "./scalars";
import type { Expression } from "./expressions";
import type { JsonEachReference } from "./source-catalog";
import type { NumericLiteral } from "./json-array";
import { jsonEachSource } from "./catalog";
import { jsonEachElement } from "./expressions";

/**
 * `source` goes in FROM or a join and carries the bind `name`; `element` is the
 * current element in `element`'s domain. A blob element is decoded with
 * unhex(), so it can drive an index seek on a blob column. `maxLength` bounds
 * the list: the bind's type carries it, jsonArrayOf enforces it, and the
 * rendered query records it with the occurrence (renderQuery).
 * See docs/design.md sec."JSON array sources".
 */
export function jsonEach<const N extends string, T, const Max extends number>(
  alias: string,
  name: N,
  element: Domain<T>,
  maxLength: Max & NumericLiteral<Max>,
): {
  source: JsonEachReference<N, T, Max>;
  element: Expression<T, readonly []>;
} {
  const source = jsonEachSource<N, T, Max>(alias, name, element, maxLength);
  return { source, element: jsonEachElement(source.value, element) };
}
