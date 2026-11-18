# The construction model

How a query is built, what each constructor checks, and what crosses from build
time to run time. The README says what the package is for and how to use it;
this document is the model the source comments cite by section.

## Ownership and construction checks

The parameter algebra owns ordered requirements and exact duplicate-name
validation. Composition keeps a tuple until that validation completes, and only
then is the bind-object type derived. An incompatible name fails at the
constructor that combines its fragments. Runtime requirements keep the domain,
nullability and refinement, so construction checks the same agreement without
relying on TypeScript alone.

Domain descriptors own semantic compatibility. The core expression, the closed
arithmetic and the SELECT-to-value constructors each own their domain checks,
source references and private node membership. No owner exposes a generic node
factory. The SELECT body owns normalized read clauses, source visibility,
aggregate cardinality and ordering constraints. Statement construction grants
nominal identity and whole-statement parameter agreement, and mutation
construction also checks destination-column outputs. The renderer owns emitted
SQL and its ordered bind names together.

One catalog, held by the package, constructs every column and source and owns
their membership. A foreign catalog cannot supply accepted columns even when it
reuses a table name and domain. Table metadata is carried apart from enumerable
column keys, so a row type and a complete column registry derive from the same
definition. An alias wraps a table with a fresh source identity and a checked
SQL alias; it never mutates the definition.

Ordering by a named projection references the checked projection object in the
same SELECT, never an alias string, and emits the output name without repeating
the projection's parameters. A NULL-ordering expression refuses an output name
that matches a visible input column, since the expression could resolve to the
input instead. Output references are quoted, so a name such as `current_time`
stays an identifier. SQLite's
[SELECT rules](https://www.sqlite.org/lang_select.html) distinguish direct
output-name ordering from ordinary ordering expressions.

An ordering expression keeps the meaning it was built with. A term that renders
as a bare column name, as a single-source read's columns do, is refused when an
output alias of that name projects something else, since SQLite would order by
the alias. A term that renders as an integer constant is refused, since SQLite
would read it as an output position. A qualified column is never read as an
alias, so a joined or aliased read orders by its input column as written.

### Identity

- **Reused parameter.** Exact authored name, domain, nullability and refinement.
  Column location is excluded, because reuse across compatible columns is
  intended. Positional occurrences stay separate.
- **Source occurrence.** Fresh object identity, source kind, underlying table
  and optional SQL alias. Equal alias text does not merge independently created
  sources.
- **Pinned-index source.** A fresh read occurrence keeps its table, exact index
  identifier, alias and null extension. Neither matching table text nor matching
  index text merges identities. Whether the index exists and applies is for the
  database to say when the SQL is prepared.
- **Alias collision.** SQLite's case-insensitive identifier comparison within
  the visible scope, refused before rendering. Case folding detects a collision
  and never establishes identity.
- **Projection identity.** An explicit output name, checked for duplicates
  before a derived row is constructed. An ordering reference keeps the
  projection object's identity; another projection with the same name is not a
  member.
- **SQL identifiers.** Constructors accept unquoted identifier tokens only:
  whitespace, quoted names, hyphens and punctuation fail closed. The renderer
  double-quotes a name that is an SQLite keyword and writes every other name as
  given. Bare, a keyword column would read as the keyword (`current_time` as the
  clock) and a source aliased `left` would make the next join a LEFT JOIN. A
  bind renders as `?`, so its name never reaches the SQL text. A source name is
  refused when it is `excluded`, which in a conflict arm names the incoming row
  whatever the quoting.
- **SQL literal contents.** Literal encoding escapes strings and refuses
  non-finite and non-integer numbers, and text holding NUL or a lone surrogate,
  which a statement cannot carry. Text inside a string is data, never parsed as
  SQL.

## Composable expressions and statements

Queries are a build-time syntax tree, with closed discriminated unions for
expressions, predicates, sources, projections and statements. An expression
carries its value type, its parameter requirements and the sources it
references. Public constructors create nominal nodes. There is no raw-SQL
expression or string fragment that can claim an arbitrary result type.

A table definition is distinct from a source occurrence. Aliasing creates a
source whose columns keep their domains and take that alias's scope, and one
table may appear under several aliases. Construction checks visibility: a
correlated subquery may reference its declared outer scope, but an unrelated
alias cannot escape into another statement. Duplicate aliases in a scope and
duplicate projection names fail construction. An `excluded` source exists only
inside its insert's conflict arm.

Statement nodes own clause order. SELECT, UPDATE, DELETE and INSERT share
expression and predicate nodes rather than each building strings of its own.

## Domains the application declares

A domain is a canonical object compared by identity: `domain()` makes a new one,
`refinement()` a narrower one whose values may stand where its base is read, and
`nullable()` the nullable form of either. The package holds the generic SQLite
domains (`SqliteScalars`), among them the time algebra's instant
(`epochSeconds`) and duration (`seconds`). An application spreads them into its
own set, so the package's internal checks and the application's columns use the
same objects.

Two relations cannot be read from the domain objects at the type level, because
only a value's type survives once it flows through an expression: which value
types are stored UUIDs, and which refinement pairs exist. The application
declares both by augmenting `DomainRelations`. Subtyping alone would not do,
since a branded `number` is a subtype of `number` and would enter every `number`
slot.

## Conflict-arm construction

A conflict clause owns its target columns, an optional partial-index predicate,
its assignments and its update predicate. Its excluded-row source is a fresh
occurrence bound to the destination table. It keeps that table's domains and
nullability, and cannot become a FROM source, an alias or a mutation target. A
correlated SELECT may declare it as an outer dependency, which must resolve
inside that conflict arm before the INSERT can render.

Target columns and assignments must belong to the same destination occurrence,
and an INSERT's read sources do not enter its conflict scope. Partial-index
targets accept column and literal comparisons, null tests and boolean
composition. Parameters, subqueries and computed expressions are refused there,
because a SQLite [partial index](https://www.sqlite.org/partialindex.html) needs
a static predicate over the indexed table. The renderer keeps the explicit
target predicate rather than inferring an index from it.

The conflict arm takes part in whole-INSERT parameter agreement, after the
insert projection and the source predicate in positional order. An INSERT with a
FROM source and an upsert clause needs an explicit WHERE, to resolve SQLite's
[ON parsing ambiguity](https://www.sqlite.org/lang_insert.html). INSERT OR
IGNORE is a separate conflict policy, exclusive of an upsert clause.

RETURNING accepts destination columns and derives its output row from their
ordered domains. It refuses foreign sources, expressions, duplicate columns and
an empty list; omitting it leaves a rowless mutation. A mutation with returned
rows is still not a SELECT, and cannot be used as a scalar, IN or EXISTS
subquery.

Predicate negation groups a checked predicate without rewriting its comparisons,
so SQL NULL behavior, bind order and source dependencies survive unchanged.

## Parameter provenance

A parameter used as a column value or comparison operand takes its type from
that column. Its name is a string literal in the type system and a validated SQL
identifier at construction. Requirements are collected from the whole tree,
including subqueries, projections, conflict arms and CTEs, so no query supplies
a hand-written parameter type.

A parameter with no column takes a declared domain (`scalarParam`). Counts take
`count`, durations take `seconds`, and an application's own value sets take its
own domains. Those domains also type literals and computed expressions. A
query-local `param<T>` is not part of the API.

Column parameters default to the column's non-null domain. A nullable parameter
is explicit, and is accepted only where the consuming expression or assignment
accepts NULL. A refined parameter narrows a column-derived parameter after an
assignability check against the column's domain. The check is directional: the
destination cannot widen the parameter, and the parameter cannot widen the
destination.

Declare a parameter once and reuse the node wherever the same value appears.
Independent fragments may use the same name only when their parameter types are
equal, nullability and refinement included. Combining different types is a
compile error, not a union. The emitted positional list repeats the name for
each occurrence, and the caller supplies the value once.

## CTE definition identity and scope

A CTE is a read source whose column names and domains come from a checked
SELECT's outputs. Its definition is immutable and distinct from every alias
occurrence, and no caller supplies a column-domain bag. CTE column references
keep their qualifier even in a single-source read, so a projected name such as
`current_time` cannot silently resolve to SQLite's built-in value.

`withCtes` attaches an ordered definition list to a checked statement and puts
the definitions' parameter requirements before the body's. SELECT and VALUES
forms are explicit. The optional materialized mode emits `AS MATERIALIZED` for
either form, an optimization fence kept inside the definition's identity;
omitting it leaves planning to SQLite. VALUES is restricted to a source-free,
unfiltered, non-aggregate projection with no ordering or limit, so changing the
form cannot discard clauses. Definitions cannot capture an outer row.

Rendering walks lexical CTE scope alongside SQL and bind emission. A reference
must resolve to the exact definition, through an alias or a nested query too. An
absent or forward definition is refused before SQL can execute. Duplicate names
and nested shadowing are refused case-insensitively, and a CTE and a table never
share a name, whichever is defined first. These restrictions keep SQL's textual
resolution consistent with the tree's nominal column identity.

## Derived read sources

A derived source embeds a checked SELECT in FROM, without naming a CTE. Its
named outputs supply column domains, compound nullability included. The source
owns the nested statement's ordered requirements: projection binds precede FROM
binds, and a joined source's binds precede its ON predicate. Using the source in
another occurrence repeats its positional binds. FROM requires the complete
derived source, since a column alone cannot carry its bind contract. Derived
reads cannot capture an outer row.

## JSON array sources

A statement whose input is a list of varying length cannot take it as separate
binds, because a rendered statement has a fixed number of placeholders.
`jsonEach(alias, name, element, maxLength)` gives it one: a `json_each(?)`
source whose single bind is a JSON array of at most `maxLength` `element`
values.

The maximum must be a single numeric literal (not `number`, a union or a branded
number) at the declaration and at the mint, so two different maxima never share
a type. The bind's domain is keyed by the element descriptor and the maximum,
and its value type, `JsonArrayOf<T, Max>`, is minted only by
`jsonArrayOf(values, maxLength)`. That mint refuses a maximum that is not a
positive integer, and a longer list, at run time rather than binding it. It also
refuses NaN, an infinity and a missing array position, which JSON would carry as
`null`. The element must be non-null. Mint against the same constant the source
declares, so the bound has one owner.

`jsonEach` returns the FROM occurrence and the element as an expression in the
element's domain. JSON has no byte string, so a blob element travels as hex and
the element expression is `unhex(alias.value)`; a seek on a blob column then
compares like for like. The element reader accepts only a `json_each` source's
own `value` column, in the element domain that source declared, so it cannot
relabel another column's domain. The bind belongs to the FROM occurrence and is
emitted at its position. FROM takes the complete source, never its `value`
column alone.

`buildQuery` records every occurrence it renders, with its alias, bind and
declared maximum, on the authored query (`jsonEachSources`). It refuses an alias
used for more than one occurrence in a statement, so an alias names exactly one
bound. A query-plan check can then require every virtual-table scan in a plan to
be one of these declared, bounded occurrences.

## Constants and scalar algebra

Literal nodes carry the type of their value or of their checked destination
column. Literal encoding owns escaping and integer validation. Identifiers have
their own validation, and neither accepts preformatted SQL text. NULL requires a
nullable target, the SQLite clock (`unixepoch('now')`) produces `EpochSeconds`,
and `randomblob(16)` requires a stored-UUID target.

Time operations enforce an affine algebra. An instant plus or minus a duration
is an instant, an instant minus an instant is a duration, and adding two
instants is not expressible. Generic numeric arithmetic does not accept an id or
an instant merely because its brand extends `number`. Instant, duration and
offset arithmetic propagate nullable operands, and a duration remainder is
nullable even with required operands, since a zero divisor yields NULL.
`elapsedSinceUnixOrigin` reads an instant as the duration since the epoch, so a
time of day can be taken with `remainderSeconds`; it emits no SQL of its own.

An application closes arithmetic on its own domains with `operation()`, which
fixes an operator's operand and result domains, and with `conversion()`, which
declares that one domain's values may be read as another's and renders the
operand unchanged. A call site never names a result domain.

`COALESCE` and CASE arms must share a domain, with nullability computed from
their operands. Scalar MIN and MAX keep that domain. Aggregates and scalar
subqueries include NULL when an empty input can produce it, and a LEFT JOIN
makes its optional source's projected columns nullable. Nullability is not
inferred from WHERE predicates. Where a predicate or schema invariant
establishes a value, `requiredColumnValue` refines a column to non-null. It
keeps the brand and emits the same SQL, and it cannot remove NULL from an input
parameter.

## Scalar construction boundary

Scalar composition keeps each operand's requirements and source identity.
Predicates own their membership and their tree composition. CASE references
checked predicates, and predicates reference checked expressions. Statement
construction refuses aggregates in mutation values, WHERE and LIMIT, and an
aggregate constructor refuses a nested aggregate. Projection and ordering may
contain aggregates.

## Subquery construction boundary

A SELECT keeps its projection tuple, so a scalar or IN subquery needs a single
output, checked at compile time and at construction. An ordinary scalar lookup
adds NULL for the no-row case. `aggregateSubquery` keeps the projected domain
only after checking for an aggregate projection with no row-suppressing LIMIT;
aggregate MIN and MAX still keep their value nullability. An aggregate result
row refuses a bare column whose non-null domain would be false for an empty
input. EXISTS is a non-null flag when projected and a predicate when used as a
guard.

A correlated SELECT declares its outer source occurrences. Construction refuses
undeclared references and case-insensitive qualifier collisions, including
shadowing a declared outer source. Only referenced outer sources escape as the
subquery's dependencies, and embedding validates them against the enclosing
scope. A standalone query cannot keep an unresolved outer dependency.

Nested statements share the enclosing renderer's ordered parameter collector.
Each aggregate operand must be source-free or reference its own SELECT's local
source. An operand naming only outer sources is refused, because SQLite would
move that aggregation into the outer scope, change its cardinality, and void the
scalar's row guarantee. UPDATE aliases qualify reads while assignment
destinations stay bare column names, as SQLite requires.

## Joined source construction

A join owns a nominal clause and its predicate's requirements. A read scope owns
the ordered local sources and the declared outer sources. It refuses qualifier
collisions, and checks each ON against only the sources visible at that point.

LEFT JOIN creates a fresh occurrence with nullable columns. The callback that
builds ON, and every later consumer, receive that occurrence, so an earlier
required alias cannot stand in for the optional row. Nullable occurrences cannot
be mutation destinations. Rendering keeps authored join order, and emits ON
binds between projection binds and WHERE binds. Several local sources require
qualified column references, while single-source reads stay unqualified. CROSS
JOIN keeps its explicit planner-ordering constraint rather than becoming a comma
join; it has no ON clause, and filters belong in WHERE.

`indexedBy` makes an access-path requirement part of a read occurrence. It
accepts a table occurrence and keeps the index through aliasing and optional
joins, and it refuses CTEs, excluded rows and replacing an existing hint.
Rendering places `INDEXED BY` after the table alias. Preparing the SQL against
the database checks that the index exists and that the query can use it.

## Compound SELECT construction

A checked read carries output descriptors apart from its projection expressions.
Scalar and IN consumers read those descriptors, so a compound result can widen
nullability without pretending that an arm's expression changed domain. Each
descriptor keeps the first arm's output name and the position's domain.

UNION and UNION ALL take ordered SELECT arms with matching arity and non-null
domains, at most five of them: D1 refuses a compound SELECT of more terms.
Construction widens only nullability and keeps every arm's ordered requirements
and outer dependencies. Neither operator promises an order. Arm-local ordering,
limits and WITH are refused; definitions attach around the compound instead.
`limitRows` applies a source-free count to a complete read, and its bind follows
the read's binds. A compound cannot be an aggregate scalar, because it cannot
promise a row.

## Ordered expression lists

COALESCE keeps each fallback in authored order, and becomes required only when
an operand guarantees a value. IN lists accept checked expressions of the
compared domain; a NULL keeps SQLite's unknown comparison. COALESCE and IN keep
every source and ordered bind, including operands after a required fallback,
because unreachable evaluation does not remove a positional slot.

## Rendering

The renderer is deterministic and performs no optimization. It preserves
projection order, source and join order, comparison operators, predicate
grouping, subquery placement, compound form, conflict-target predicates,
`INDEXED BY` and `AS MATERIALIZED`. It uses one whitespace layout, and keeps
explicit grouping nodes available for parentheses an author wants. It never
rewrites CASE as OR, or a scalar subquery as a join.

## Output and execution boundary

The renderer emits positional SQL and ordered parameter names together, in one
traversal. Repeated parameter nodes emit repeated placeholders and names, which
`precomputed` and `.bound()` consume; `precomputed` keeps a frozen copy of the
names, so the bind-name check and the binding read one list. The freezer copies
that pair into a runtime module without parsing it, and the module refers to the
authored query's type through an import that is erased.

The name check in `.bound()` is a runtime failure detector for untyped input.
Its name set is allocated on a query's first bind, so loading a registry does
not allocate it for queries the running path never binds.

## Projection types and executor rows

Projection types are derived inside the builder. A scalar subquery takes the
type of its projected expression, and a CTE's or derived source's columns take
their projection types.

INSERT ... SELECT declares its read source independently of its destination, and
the destination does not become readable. Each source expression is checked
against its destination column, and compound arms agree by position and domain,
widening only nullability.

`Query<TParams, Row>` and `BoundQuery<Row>` carry the statement's output row,
and frozen registries keep it through their erased imports. `lowerToD1` returns
a `D1Query<Row>` whose `run`, `all` and `first` have no free row argument.
`batchD1` keeps each statement's own row in a heterogeneous batch. Where a row
is needed as a type, `QueryRow` names it from a registry entry, so a projection
that drops or retypes a column fails to compile in every consumer. A mutation
without RETURNING yields `never` rows.
