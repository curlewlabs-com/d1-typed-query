// Validation of the SQL identifiers query construction accepts.

// SQL identifiers are authored tokens rather than SQL fragments. Keeping this
// boundary shared prevents schema, alias, and parameter constructors from
// accepting different identifier grammars.

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSqlIdentifier(token: string, kind: string): void {
  if (!SQL_IDENTIFIER.test(token)) {
    throw new Error(
      `query-builder: ${kind} "${token}" is not a SQL identifier`,
    );
  }
}
