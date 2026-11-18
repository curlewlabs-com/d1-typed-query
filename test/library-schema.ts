// An invented lending-library schema the tests author queries against: its
// domains, the relations between them, its tables, one declared operation and
// one declared conversion, and the DDL the rendered SQL is prepared against.

import {
  SqliteScalars,
  conversion,
  defineTable,
  domain,
  nullable,
  operation,
  refinement,
  type Brand,
  type RowOf,
} from "@curlewlabs-com/d1-typed-query";

export type AuthorId = Brand<number, "AuthorId">;
export type MemberId = Brand<number, "MemberId">;
export type BookId = Brand<ArrayLike<number>, "BookId">;
export type EditionId = Brand<ArrayLike<number>, "EditionId">;
export type Isbn = Brand<string, "Isbn">;
export type Pages = Brand<number, "Pages">;
export type Genre = "fiction" | "history" | "poetry";
// 1 on loan, 2 returned, 3 lost.
export type LoanStatus = 1 | 2 | 3;

declare module "@curlewlabs-com/d1-typed-query" {
  interface DomainRelations {
    storedUuid: BookId | EditionId;
    refinements: [Genre, string];
  }
}

export const Library = Object.freeze({
  ...SqliteScalars,
  authorId: domain<AuthorId>("AuthorId", "integer"),
  memberId: domain<MemberId>("MemberId", "integer"),
  bookId: domain<BookId>("BookId", "blob", { storedUuid: true }),
  editionId: domain<EditionId>("EditionId", "blob", { storedUuid: true }),
  isbn: domain<Isbn>("Isbn", "text"),
  pages: domain<Pages>("Pages", "integer"),
  genre: refinement<Genre, string>("Genre", SqliteScalars.text),
  loanStatus: domain<LoanStatus>("LoanStatus", "integer"),
});

export const Authors = defineTable("authors", {
  id: Library.authorId,
  name: Library.text,
  born_at: nullable(Library.epochSeconds),
});
export type AuthorsRow = RowOf<typeof Authors>;

export const Books = defineTable("books", {
  id: Library.bookId,
  author_id: Library.authorId,
  title: Library.text,
  isbn: Library.isbn,
  genre: nullable(Library.text),
  pages: Library.pages,
  // The first edition's id is the book's own id; later editions get their own.
  current_edition_id: nullable(Library.editionId),
  published_at: Library.epochSeconds,
});

export const Members = defineTable("members", {
  id: Library.memberId,
  display_name: Library.text,
  joined_at: Library.epochSeconds,
});

export const Loans = defineTable("loans", {
  book_id: Library.bookId,
  member_id: Library.memberId,
  lent_at: Library.epochSeconds,
  due_at: Library.epochSeconds,
  returned_at: nullable(Library.epochSeconds),
  status: Library.loanStatus,
  renewals: Library.count,
});

export const addPages = operation(
  "+",
  Library.pages,
  Library.pages,
  Library.pages,
);
export const firstEdition = conversion(Library.bookId, Library.editionId);

export const LIBRARY_DDL = `
CREATE TABLE authors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  born_at INTEGER
) STRICT;
CREATE TABLE books (
  id BLOB PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  title TEXT NOT NULL,
  isbn TEXT NOT NULL UNIQUE,
  genre TEXT,
  pages INTEGER NOT NULL,
  current_edition_id BLOB,
  published_at INTEGER NOT NULL
) STRICT;
CREATE INDEX books_by_author ON books(author_id, published_at);
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  joined_at INTEGER NOT NULL
) STRICT;
CREATE TABLE loans (
  book_id BLOB NOT NULL REFERENCES books(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  lent_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  returned_at INTEGER,
  status INTEGER NOT NULL CHECK (status IN (1, 2, 3)),
  renewals INTEGER NOT NULL DEFAULT 0 CHECK (renewals >= 0),
  PRIMARY KEY (book_id, member_id)
) STRICT;
CREATE INDEX open_loans_by_due ON loans(due_at) WHERE returned_at IS NULL;
`;
