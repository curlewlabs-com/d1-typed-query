# Contributing

Thanks for your interest in improving `d1-typed-query`. The bar for a change is
whether it keeps every query an application runs on D1 checked at build time and
frozen to SQL the builder never ships with. Bug fixes, statement shapes SQLite
supports that the constructors do not build yet, sharper construction errors,
and clearer docs are all welcome.

Use [Bun](https://bun.sh) 1.4.4. Keep changes on a branch and open a pull
request that says what behavior changes and how you verified it.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The tests prepare and run the rendered SQL against SQLite through `bun:sqlite`;
they need no Cloudflare account.

## Maintainership and review

Curlew Labs maintains this project. Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) reviews changes
and approves the releases that [need approval](#releases). Use issues for
reproducible defects and proposals; use
[private vulnerability reporting](SECURITY.md) for security concerns.

Changes land through pull requests with passing CI and maintainer review. Every
dependency is pinned to an exact version.

## Before a large change

Open an issue describing the problem first. A few choices carry the guarantee
and are easy to undo by accident: nodes are accepted by identity, never by
shape; there is no raw-SQL expression; a bind's type comes from its column or a
declared domain, never from the call site; and the runtime entry imports no
builder module. [docs/design.md](docs/design.md) is the model. A short
discussion up front saves rework.

## What a change owes

- A test for the behavior it adds or fixes. A construction a caller must not be
  able to write gets a `@ts-expect-error` case, and a runtime refusal where
  untyped code could still reach it.
- Rendered SQL that SQLite prepares: the tests run it.
- Comments that say why, not what.

## Releases

A patch or minor release needs no approval: whoever cuts it follows the steps
below in order, on a `main` commit whose required checks have passed. A major
version, a 1.0, or a minor before 1.0 that changes an interface consumers use
needs the maintainer's explicit approval before its tag is pushed.

1. Set `version` in `package.json` on `main`, and point the README's install
   line at the new tarball.
2. Push the tag `vX.Y.Z` at that commit. The Release workflow runs CI, packs the
   tarball and opens a draft release with it attached.
3. Check the draft, then publish it. Releases are immutable: a published
   release's tag and assets cannot be changed, so a fix is a new version.

## License

By submitting a contribution for inclusion in this project, you agree that it is
licensed under the MIT and Apache-2.0 licenses, as the README's License section
describes, without any additional terms or conditions.
