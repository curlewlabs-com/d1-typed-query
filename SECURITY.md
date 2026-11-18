# Security policy

Report suspected vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/curlewlabs-com/d1-typed-query/security/advisories/new).
Include the affected release or commit, reproduction steps and the observed
impact. Keep credentials, account identifiers and personal data out of public
issues.

Curlew Labs maintains this repository; Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) is the release
and security contact through GitHub. Reports are reviewed on a best-effort basis
without a guaranteed response time. Fixes target the latest release; older
release lines have no promised backport window.

## Trust boundary

The builder and the freezer run at build time, on your queries, and write
nothing themselves: the freezer returns text for your build to write. The
runtime entry runs in your Worker and makes no call of its own; it prepares and
binds statements on the D1 handle you pass. Values reach D1 only as bound
parameters. SQL text comes only from the constructors, which accept identifiers
as unquoted tokens and encode literals, so a value cannot become SQL unless your
code builds a query from it at build time.
