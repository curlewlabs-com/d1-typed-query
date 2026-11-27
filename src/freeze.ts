// The freezer entry point: turns an authored registry, evaluated at build time,
// into the source of a runtime module that holds only SQL text and bind names.
// The SQL and its ordered bind names are copied as buildQuery rendered them,
// never reparsed. The authored module is imported for its types alone, so the
// runtime module keeps every bind and row type without loading the builder.

export interface FreezeInput {
  // The registry's export name, which the frozen module exports too.
  readonly exportName: string;
  // The import specifier of the authored module, as the frozen module will
  // resolve it.
  readonly authoredModule: string;
  // The authored module's export, as evaluated. It is narrowed here, because
  // it arrives from a dynamic import.
  readonly registry: unknown;
}

// The contract entry, not ./runtime: the frozen module needs only precomputed
// and GeneratedQuery, and ./runtime names D1's ambient types, which a program
// that runs its statements through its own handle does not declare.
const CONTRACT_MODULE = "@curlewlabs-com/d1-typed-query/contract";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// The frozen module declares these names itself, and the rest cannot name a
// `const`; an export name that is one of them would not load.
const UNUSABLE_EXPORT_NAMES = new Set([
  "Authored",
  "GeneratedQuery",
  "precomputed",
  ...(
    "arguments await break case catch class const continue debugger default " +
    "delete do else enum eval export extends false finally for function if " +
    "implements import in instanceof interface let new null package private " +
    "protected public return static super switch this throw true try typeof " +
    "var void while with yield"
  ).split(" "),
]);

interface FrozenQuery {
  readonly key: string;
  readonly sql: string;
  readonly paramNames: readonly string[];
}

function frozenQuery(
  exportName: string,
  key: string,
  value: unknown,
): FrozenQuery {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as { sql?: unknown; paramNames?: unknown })
      : {};
  if (
    typeof candidate.sql !== "string" ||
    !Array.isArray(candidate.paramNames) ||
    !candidate.paramNames.every((name: unknown) => typeof name === "string")
  )
    throw new Error(
      `${exportName}.${key} is not a Query (invalid sql/paramNames)`,
    );
  // An object literal reads a `__proto__:` entry as the prototype, not a key.
  if (!IDENTIFIER.test(key) || key === "__proto__")
    throw new Error(`freeze: ${exportName}.${key} is not an identifier key`);
  return { key, sql: candidate.sql, paramNames: candidate.paramNames };
}

/**
 * The frozen module's source text, without a header: the caller writes it,
 * under whatever generated-file notice its tree uses. Each entry is
 * `precomputed(sql, paramNames)` typed as GeneratedQuery of its authored entry.
 */
export function freezeRegistry(input: FreezeInput): string {
  const { exportName, authoredModule, registry } = input;
  if (!IDENTIFIER.test(exportName) || UNUSABLE_EXPORT_NAMES.has(exportName))
    throw new Error(
      `freeze: export name "${exportName}" cannot name the frozen registry`,
    );
  if (typeof registry !== "object" || registry === null)
    throw new Error(`freeze: ${exportName} is not an object`);
  const entries = Object.entries(registry)
    .map(([key, value]) => frozenQuery(exportName, key, value))
    .map((q) =>
      [
        `  ${q.key}: precomputed(`,
        `    ${JSON.stringify(q.sql)},`,
        `    ${JSON.stringify(q.paramNames)},`,
        `  ) as GeneratedQuery<(typeof Authored)[${JSON.stringify(q.key)}]>,`,
      ].join("\n"),
    )
    .join("\n\n");
  return `import type { ${exportName} as Authored } from ${JSON.stringify(authoredModule)};
import { precomputed } from "${CONTRACT_MODULE}";
import type { GeneratedQuery } from "${CONTRACT_MODULE}";

export const ${exportName} = {
${entries}
} as const;
`;
}
