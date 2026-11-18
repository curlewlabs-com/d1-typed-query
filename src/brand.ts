// The package's own domain types and the brand convention they are written in.

// The nominal brand convention the package's own domain types use. The marker
// is a string-keyed phantom property rather than a module-private unique
// symbol: a symbol key cannot be named in an emitted declaration (TS4023), and
// the builder's generics expand brands structurally all the time. Two brands
// with the same tag are assignable to each other, but the builder's exact type
// comparisons tell them apart, so a program that names these two types imports
// them from this package rather than declaring its own.
export type Brand<T, B extends string> = T & { readonly __brand: B };

// An absolute instant in whole seconds since the Unix epoch, as SQLite's
// unixepoch() returns it.
export type EpochSeconds = Brand<number, "EpochSeconds">;
// A duration in seconds. Distinct from an instant: an instant plus a duration
// is an instant, an instant minus an instant is a duration, and an instant plus
// an instant is not expressible.
export type Seconds = Brand<number, "Seconds">;
