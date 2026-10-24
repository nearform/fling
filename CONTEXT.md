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
verified email listed in `ALLOWED_EMAILS` or on a domain in `ALLOWED_EMAIL_DOMAINS` (production
needs at least one; the public metadata names the domains, never the addresses). A user is their
email; the issuer's `sub` is not stored.

**Admin** — a user listed in `ADMIN_EMAILS` (checked on every request; never published), who
must still be admitted to sign in. Admins see every user (`USERS/USER#<email>` index items, with the
last sign-in) and may **impersonate** one: from a browser session only, they act as that user for
at most 60 minutes, with a banner on every page, and stop to return to their own session. They get
no rights over anyone's site except by impersonating, and while impersonating can create nothing
that outlives the session (no API keys or `fling login`, no OAuth approvals, no further
impersonation). Every start and stop is audited (`AUDIT` items, kept 180 days, and a log line).
The `admin.*` actions are in `policy.ts` (`canAdmin`).

**Policy** — who may do what to a site: `can(actor, action, site)` in `apps/api/src/policy.ts`, a
pure function every site route and MCP tool goes through. Actors resolve to a role on the site:
**owner** (holds it), **member** (any other signed-in user), **share** (holds its current share
link), **anonymous**. `site.view` and the comment actions reach beyond the owner. A refusal looks like a
missing site (404).

**Comment** — a note on one page of a site (`COMMENT#<id>` in the site's partition, ids sortable by
time): a **thread** or a one-level **reply** to one. It records the page **path** and the version
being served when it was written, so it outlives new versions; an optional **pin** is a point in
the frame's viewport (percentages), not in the document. Owners and members read, write and
resolve; authors delete their own, owners any. The author is a user (`{ kind: 'user', email }`) or,
later, a **guest** (`{ kind: 'guest', name }`, a share-link viewer with a signed per-site cookie).

**Review mode** — `/review/<name>` on the app origin: the site in an iframe, untouched (the edge
only rewrites), beside its comments. The frame is another origin, so the page owns the path the
comments attach to (its path bar) and cannot follow the frame's navigation or scroll. It needs
the sites domain under the app's registrable domain: the `fling_site` cookie is on that parent, a
same-site frame sends it, and nothing in front of the sites may forbid framing (the e2e checks).
`COMMENTS=false` turns comments off (the `comments` capability).

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

**Site routing** — how a request to a sites host becomes a site version's file, a sign-in redirect
or the 404 page: one pure decision, `routeSiteRequest` (`packages/shared/src/site-routing.ts`).
The edge only rewrites: the CloudFront Function (`edge/`, generated around it) and the Cloudflare
Worker's sites host are thin shells that do the lookups and map the decision to their runtime.

**Platform** — `platforms/<cloud>`: one cloud's entry point and adapters for the ports
(`platforms/aws`: Lambda, DynamoDB, S3, CloudFront KeyValueStore, SSM; `platforms/cloudflare`: one
Worker, D1, R2, Workers KV with D1 behind it). Every adapter, including the core's memory/fs ones,
passes the same suites from `packages/conformance`, and every platform passes the same e2e
scenario (`packages/e2e`) locally and as its post-deploy smoke test.
