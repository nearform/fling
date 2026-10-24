# Fling — domain glossary

**Site** — a named folder of static files served at `<name>.<sites domain>`. Names are one global
namespace, first come first served. A site has many versions and at most one current version.

**Version** — one immutable set of files, identified by a hash of its manifest (path + sha256 of
every file). `pending` until it passes publication, then `complete`. Rollback only ever points a
site at a complete version.

**Manifest** — the list of files in a version: path, sha256, size, content type.

**Publication** — the only way a version becomes live (`apps/api/src/publication.ts`). It owns:

- **Admission** — whether a manifest may be published at all, checked in a fixed order: size
  limits (413), path rules (400 `dotfile` / `secret_file`), then the schema (400).
- **Staging** — for bytes the server never sees (CLI): upload URLs that only accept the exact
  bytes named in the manifest (sha256 signed into the URL) and expire quickly.
- **Publishing** — staged bytes are read back and scanned for secrets before the version goes
  live; bytes the server holds (remote MCP) are scanned before they are written. There is no way
  to skip the scan.

**Never published** — dotfiles, gitignored files, secret files (keys, certificates, credentials)
and files containing secrets. The CLI and local MCP check first for early, specific messages;
Publication is the guarantee.

**Share link** — `s--<token>.<sites domain>`: serves a site to anyone with the link.

**Private** — visible to any signed-in member of the instance (not only the owner). **Public** — anyone.

**Sign-in** — one OpenID Connect issuer per instance (`OIDC_ISSUER`), behind the
`IdentityProvider` interface (`apps/api/src/auth/oidc.ts`), which proves who someone is. The
**email policy** (`admitIdentity`, `auth/identity.ts`), kept apart from it, decides who gets in: a
verified email in `ALLOWED_EMAIL_DOMAINS`. A user is their email; the issuer's `sub` is not stored.

**Policy** — who may do what to a site: `can(actor, action, site)` in `apps/api/src/policy.ts`, a
pure function every site route and MCP tool goes through. Actors resolve to a role on the site:
**owner** (holds it), **member** (any other signed-in user), **share** (holds its current share
link), **anonymous**. Today only `site.view` reaches beyond the owner. A refusal looks like a
missing site (404).

**Core** — `apps/api`: the API with no cloud SDK in it (a lint rule bans `@aws-sdk/*`,
`cloudflare:*` and `@cloudflare/*` there and in `packages/shared`). It talks to storage through three
ports:
**Table** (keyed items: get, prefix query, conditional put/update/delete, transactions, expiry),
**Blobs** (site files and manifests, including upload URLs bound to a sha256) and **RouteTable**
(the keys the edge routes site hosts by).

**Records** — the domain persistence (users, keys, sites, versions, OAuth, uploads), written once
over Table and exposed to routes as the `Store` interface. Every record carries `v`, the version of
its shape; reads upgrade older records and tolerate one version ahead. Keys are site-centric: a
site's partition (`SITE#<id>`) holds its record and versions; a user's sites are index items
(`USER#<email>/SITE#<name>`); a site is found by name through its name claim.

**Migration** — a one-off rewrite of stored data, written once against Table
(`apps/api/src/migrations/NNNN-*.ts`), idempotent and resumable, with its checkpoint and lock in
`MIGRATION#NNNN` items. Deploys run the pending ones (`runMigrations`); they are the only code that
scans the table.

**Platform** — `platforms/<cloud>`: one cloud's entry point and adapters for the ports
(`platforms/aws`: Lambda, DynamoDB, S3, CloudFront KeyValueStore, SSM; `platforms/cloudflare`: D1,
R2, Workers KV). Every adapter, including the core's memory/fs ones, passes the same suites from
`packages/conformance`.
