// Parameter provenance for build-time query composition. Requirements keep their
// order until exact duplicate-name validation, before deriving the bind object.
// Collapsing the tuple into a union earlier would erase incompatible duplicates.

import type { ScalarDomain } from "./scalars";

const REQUIREMENTS: unique symbol = Symbol("QueryRequirements");

export type Requirements = readonly (readonly [string, unknown])[];

export interface RuntimeRequirement {
  readonly name: string;
  readonly domain: ScalarDomain;
}

export interface Parameterized<P extends Requirements> {
  readonly [REQUIREMENTS]?: P;
  readonly requirements: readonly RuntimeRequirement[];
}

export type RequirementsOf<N> =
  N extends Parameterized<infer P> ? P : readonly [];

export type CollectRequirements<
  N extends readonly Parameterized<Requirements>[],
> = N extends readonly [infer Head, ...infer Tail]
  ? Tail extends readonly Parameterized<Requirements>[]
    ? readonly [...RequirementsOf<Head>, ...CollectRequirements<Tail>]
    : never
  : number extends N["length"]
    ? RequirementsOf<N[number]> extends readonly []
      ? readonly []
      : Requirements
    : readonly [];

export type SameType<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type ConflictingName<
  P extends Requirements,
  Seen extends Record<string, unknown> = Record<never, never>,
> = number extends P["length"]
  ? "parameter requirements must retain their tuple"
  : P extends readonly [
        readonly [infer Name extends string, infer Value],
        ...infer Rest extends Requirements,
      ]
    ? string extends Name
      ? "parameter name must remain a literal"
      : Name extends keyof Seen
        ? SameType<Seen[Name], Value> extends true
          ? ConflictingName<Rest, Seen>
          : Name
        : ConflictingName<Rest, Seen & Record<Name, Value>>
    : never;

const CONFLICT: unique symbol = Symbol("IncompatibleQueryParameters");

export type CompatibleRequirements<P extends Requirements> = [
  ConflictingName<P>,
] extends [never]
  ? unknown
  : { readonly [CONFLICT]: ConflictingName<P> };

// Only constructors that check CompatibleRequirements expose this final shape.
export type BindParams<P extends Requirements> = {
  [R in P[number] as R[0]]: R[1];
};

export function collectRequirements(
  nodes: readonly Parameterized<Requirements>[],
): readonly RuntimeRequirement[] {
  const requirements = nodes.flatMap((node) => node.requirements);
  const byName = new Map<string, ScalarDomain>();
  for (const requirement of requirements) {
    const previous = byName.get(requirement.name);
    if (previous !== undefined && previous !== requirement.domain) {
      throw new Error(
        `query-builder: incompatible domains for parameter "${requirement.name}"`,
      );
    }
    byName.set(requirement.name, requirement.domain);
  }
  return requirements;
}
