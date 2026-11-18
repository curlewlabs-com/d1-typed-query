// Renders a checked statement into SQL text and its positional bind names.

// SQL text and positional bind names are emitted by the same traversal. Literal
// contents never re-enter a SQL tokenizer, so punctuation inside text cannot
// invent a bind slot or change a node's structure.

import type { ColumnReference, TableSource, CteDefinition } from "./catalog";
import type { AnyExpression, AnyPredicate } from "./expressions";
import { tableSource } from "./catalog";
import type { AnyProjection, AnyOrder } from "./projections";
import { assertStatement, type AnyStatement } from "./statements";
import { sqlName } from "./identifiers";

export interface RenderedQuery {
  readonly sql: string;
  readonly paramNames: readonly string[];
  // Every json_each occurrence the SQL renders, in order, with its bind and the
  // maximum length its source declared: what the boundedness gate reads
  // (virtual-table-bounds.test.ts) instead of a table of its own.
  readonly jsonEachSources: readonly JsonEachOccurrence[];
}

export interface JsonEachOccurrence {
  readonly alias: string;
  readonly bind: string;
  readonly maxLength: number;
}

// A column of the statement's one FROM source, when that source has no alias
// and is not a CTE, renders as its bare name. `local` is that source, or null
// when the statement joins.
export function rendersBare(
  column: ColumnReference,
  local: TableSource | null,
): boolean {
  return (
    column.source.alias === null &&
    column.source === local &&
    column.source.kind !== "cte"
  );
}

function columnSql(column: ColumnReference, local: TableSource | null): string {
  const qualifier = rendersBare(column, local)
    ? null
    : (column.source.alias ?? column.table);
  const name = sqlName(column.name);
  return qualifier === null ? name : `${sqlName(qualifier)}.${name}`;
}

export function renderQuery(statement: AnyStatement): RenderedQuery {
  assertStatement(statement);
  if (statement.sources.length !== 0)
    throw new Error(
      "query-builder: standalone query has unresolved outer sources",
    );
  const paramNames: string[] = [];
  const jsonEachSources: JsonEachOccurrence[] = [];
  function sourceSql(
    source: TableSource,
    scope: readonly CteDefinition[],
    explicitAlias = false,
  ): string {
    if (source.kind === "derived")
      return `(${statementSql(source.query, scope)}) ${sqlName(source.alias ?? source.table)}`;
    if (source.kind === "json-each") {
      // One alias names one json_each occurrence, so a plan row walking that
      // alias maps to exactly one declared maximum.
      if (jsonEachSources.some((seen) => seen.alias === source.table))
        throw new Error(
          `query-builder: json_each alias "${source.table}" is used more than once in one statement`,
        );
      jsonEachSources.push(
        Object.freeze({
          alias: source.table,
          bind: source.param.name,
          maxLength: source.maxLength,
        }),
      );
      paramNames.push(source.param.name);
      return `json_each(?) ${sqlName(source.table)}`;
    }
    if (source.kind === "cte" && !scope.includes(source.definition))
      throw new Error("query-builder: CTE reference has no visible definition");
    const table =
      source.alias === null
        ? sqlName(source.table)
        : `${sqlName(source.table)}${explicitAlias ? " AS" : ""} ${sqlName(source.alias)}`;
    return source.kind === "indexed-table"
      ? `${table} INDEXED BY ${sqlName(source.index)}`
      : table;
  }
  function valuesSql(
    local: TableSource | null,
    scope: readonly CteDefinition[],
  ) {
    function expression(value: AnyExpression, parentPrecedence = 0): string {
      const tree = value.tree;
      switch (tree.kind) {
        case "function":
          return `${tree.name}(${tree.values.map((item) => expression(item)).join(", ")})`;
        case "case":
          return `CASE ${tree.arms.map(([condition, value]) => `WHEN ${predicate(condition)} THEN ${expression(value)}`).join(" ")} ELSE ${expression(tree.fallback)} END`;
        case "aggregate":
          return `${tree.name}(${tree.value === null ? "*" : expression(tree.value)})`;
        case "conversion":
          return expression(tree.value, parentPrecedence);
        case "unary":
          return `${tree.name}(${expression(tree.value)})`;
        case "binary": {
          const precedence = { "|": 1, "+": 2, "-": 2, "*": 3, "%": 3 }[
            tree.operator
          ];
          const text = `${expression(tree.left, precedence)} ${tree.operator} ${expression(tree.right, precedence + 1)}`;
          return precedence < parentPrecedence ? `(${text})` : text;
        }
        case "subquery":
          return `(${statementSql(tree.query, scope)})`;
        case "exists":
          return `EXISTS (${statementSql(tree.query, scope)})`;
        case "column":
          return columnSql(tree.column, local);
        case "parameter":
          paramNames.push(tree.name);
          return "?";
        case "literal":
          if (tree.value === null) return "NULL";
          return typeof tree.value === "number"
            ? String(tree.value)
            : `'${tree.value.replaceAll("'", "''")}'`;
        case "now":
          return "unixepoch('now')";
        case "uuid":
          return "randomblob(16)";
      }
    }
    function predicate(value: AnyPredicate, parentPrecedence = 0): string {
      const tree = value.tree;
      switch (tree.kind) {
        case "exists":
          return `${tree.negate ? "NOT " : ""}EXISTS (${statementSql(tree.query, scope)})`;
        case "in-query":
          return `${expression(tree.value)} IN (${statementSql(tree.query, scope)})`;
        case "in-values":
          return `${expression(tree.value)} IN (${tree.values.map((value) => expression(value)).join(", ")})`;
        case "like":
          return `${expression(tree.value)} ${tree.negate ? "NOT " : ""}LIKE '${tree.pattern.replaceAll("'", "''")}'`;
        case "comparison":
          return `${expression(tree.left)} ${tree.operator} ${expression(tree.right)}`;
        case "null-check":
          return `${expression(tree.expression)} IS ${tree.negate ? "NOT " : ""}NULL`;
        case "group":
          return `${tree.negate ? "NOT " : ""}(${predicate(tree.predicate)})`;
        case "junction": {
          const precedence = tree.operator === "AND" ? 2 : 1;
          const text = tree.predicates
            .map((item) => predicate(item, precedence))
            .join(` ${tree.operator} `);
          return precedence < parentPrecedence ? `(${text})` : text;
        }
      }
    }
    function projection(value: AnyProjection): string {
      const text = expression(value.value);
      return value.alias === null ? text : `${text} AS ${sqlName(value.alias)}`;
    }
    function where(value: AnyPredicate | null): string {
      return value === null ? "" : ` WHERE ${predicate(value)}`;
    }
    function ordering(order: AnyOrder): string {
      let value: string;
      switch (order.tree.kind) {
        case "expression":
          value = expression(order.tree.value);
          break;
        case "projection":
          // Every output name is quoted here, keyword or not, and it always
          // names an output of this SELECT, so SQLite resolves it to that
          // output and its string fallback (sqlName) cannot apply.
          value = `"${order.tree.projection.name}"${order.tree.isNotNull ? " IS NOT NULL" : ""}`;
          break;
      }
      return `${value}${order.direction === null ? "" : ` ${order.direction}`}`;
    }
    return { expression, predicate, projection, where, ordering };
  }
  function statementSql(
    node: AnyStatement,
    outer: readonly CteDefinition[] = [],
  ): string {
    const scope = [...outer];
    const names = new Set(
      outer.map((definition) => definition.name.toLowerCase()),
    );
    const definitions: string[] = [];
    for (const definition of node.ctes) {
      const name = definition.name.toLowerCase();
      if (names.has(name))
        throw new Error("query-builder: duplicate or shadowed CTE name");
      names.add(name);
      const materialization =
        definition.materialization === "materialized" ? " MATERIALIZED" : "";
      let sql: string;
      if (definition.form === "values") {
        const tree = definition.query.tree;
        if (tree.kind !== "select")
          throw new Error(
            "query-builder: VALUES CTE needs a simple projection",
          );
        const { expression } = valuesSql(null, scope);
        // cte() refuses an unnamed output, so every name here is a string.
        const columns = definition.query.outputs.map((output) =>
          sqlName(output.name as string),
        );
        sql = `${sqlName(definition.name)}(${columns.join(", ")}) AS${materialization} (VALUES (${tree.columns.map((column) => expression(column.value)).join(", ")}))`;
      } else {
        sql = `${sqlName(definition.name)} AS${materialization} (${statementSql(definition.query, scope)})`;
      }
      definitions.push(sql);
      scope.push(definition);
    }
    const prefix =
      definitions.length === 0 ? "" : `WITH ${definitions.join(", ")} `;
    return prefix + bodySql(node, scope);
  }
  function bodySql(
    node: AnyStatement,
    scope: readonly CteDefinition[],
  ): string {
    const tree = node.tree;
    if (tree.kind === "compound-select") {
      const sql = tree.arms
        .map((arm) => statementSql(arm, scope))
        .join(` ${tree.operator} `);
      const { expression } = valuesSql(null, scope);
      return (
        sql + (tree.limit === null ? "" : ` LIMIT ${expression(tree.limit)}`)
      );
    }
    const localSource = tree.kind === "insert" ? tree.from : tree.source;
    const joins =
      tree.kind === "select" || tree.kind === "insert" ? tree.joins : [];
    const local = joins.length === 0 ? localSource : null;
    const { expression, predicate, projection, where, ordering } = valuesSql(
      local,
      scope,
    );
    function joinSql(): string {
      return joins
        .map((clause) => {
          const source = sourceSql(tableSource(clause.source), scope);
          switch (clause.kind) {
            case "comma":
              return `, ${source}`;
            case "cross":
              return ` CROSS JOIN ${source}`;
            case "inner":
              return ` JOIN ${source} ON ${predicate(clause.on)}`;
            case "left":
              return ` LEFT JOIN ${source} ON ${predicate(clause.on)}`;
          }
        })
        .join("");
    }
    let sql: string;
    switch (tree.kind) {
      case "select": {
        sql = `SELECT ${tree.columns.map(projection).join(", ")}${tree.source === null ? "" : ` FROM ${sourceSql(tree.source, scope)}`}${joinSql()}${where(tree.where)}`;
        if (tree.orderBy.length > 0) {
          sql += ` ORDER BY ${tree.orderBy.map(ordering).join(", ")}`;
        }
        if (tree.limit !== null) sql += ` LIMIT ${expression(tree.limit)}`;
        break;
      }
      case "update":
        sql = `UPDATE ${sourceSql(tree.source, scope, true)} SET ${tree.set.map((item) => `${sqlName(item.column.name)} = ${expression(item.value)}`).join(", ")}${where(tree.where)}`;
        break;
      case "delete":
        sql = `DELETE FROM ${sourceSql(tree.source, scope)}${where(tree.where)}`;
        break;
      case "insert":
        sql = `INSERT${tree.orIgnore ? " OR IGNORE" : ""} INTO ${sourceSql(tree.source, scope)} (${tree.values.map((item) => sqlName(item.column.name)).join(", ")}) SELECT ${tree.values.map((item) => expression(item.value)).join(", ")}${tree.from === null ? "" : ` FROM ${sourceSql(tree.from, scope)}`}${joinSql()}${where(tree.where)}`;
        if (tree.onConflict !== null) {
          const { target, action } = tree.onConflict;
          const targetSql = valuesSql(target.source, scope);
          sql += ` ON CONFLICT (${target.columns.map((column) => sqlName(column.name)).join(", ")})${targetSql.where(target.where)}`;
          if (action.kind === "nothing") {
            sql += " DO NOTHING";
          } else {
            const arm = valuesSql(null, scope);
            sql += ` DO UPDATE SET ${action.set.map((item) => `${sqlName(item.column.name)} = ${arm.expression(item.value)}`).join(", ")}${arm.where(action.where)}`;
          }
        }
        break;
    }
    if (tree.kind !== "select" && tree.returning.length !== 0)
      sql += ` RETURNING ${tree.returning.map((column) => sqlName(column.name)).join(", ")}`;
    return sql;
  }
  const sql = statementSql(statement);
  return {
    sql,
    paramNames: Object.freeze(paramNames),
    jsonEachSources: Object.freeze(jsonEachSources),
  };
}
