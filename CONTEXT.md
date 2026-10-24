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

**Private** — visible to any signed-in Nearformer (not only the owner). **Public** — anyone.

**Core** — `apps/api`: the API with no cloud SDK in it (a lint rule bans `@aws-sdk/*` and
`cloudflare:*` there and in `packages/shared`). It talks to storage through three ports:
**Store** (records), **Blobs** (site files and manifests, including upload URLs bound to a sha256)
and **RouteTable** (the keys the edge routes site hosts by).

**Platform** — `platforms/<cloud>`: one cloud's entry point and adapters for the ports
(`platforms/aws`: Lambda, DynamoDB, S3, CloudFront KeyValueStore, SSM).
