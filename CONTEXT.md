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

**Site page** — `/sites/<name>` on the app origin (`apps/web/src/pages/Site.tsx`): everything about
one of your sites (overview, access, versions, archive and delete), in sections under
`components/site/`. The site list links each row to it.

**Site order** — how site lists are sorted, the same in every client: `sortSites`
(`packages/shared/src/site-sort.ts`), last updated first by default, or created (newest first) or
name (A–Z). The web list keeps it in `?sort=`, `fling ls` takes `--sort` and `fling_list` `sort`.

**Private** — visible to any signed-in member of the instance (not only the owner), unless it has
an audience. **Public** — anyone.

**Audience** — the people, besides its owner, who may see a private site: addresses (and, later,
groups), each one the instance's email policy admits (`SiteRecord.audience`, `apps/api/src/sites.ts`;
contract in `packages/shared/src/audience.ts`). Empty means every member. A private site with an
audience is **restricted**: only its owner and audience see it, and only they take part in its
comments. The audience is kept, and ignored, while the site is public. Each address also gets a
**direct grant** (`USER#<email>/SHARED#<siteId>`), a projection for listing the sites shared with
someone. Set with `PATCH /api/sites/<name> { audience }`, `fling access` and `fling_set_audience`;
the `audiences` capability.

**Site pass** — how the edge lets someone into a restricted site without holding its audience: a
host-only `fling_pass` cookie, signed with the site HMAC key, naming the site's id and the viewer,
for 15 minutes (`packages/shared/src/site-cookie.ts`). The edge sends a visitor without one to
`/auth/login`, where the API asks policy and sends a viewer to `/_fling-pass?t=<handoff>` on the
site's host (a 60-second signed **handoff**), and anyone else to the sites' 404 page. The edge turns
the handoff into the pass. An expired pass renews through the same redirects, so taking someone out
of an audience shuts them out within 15 minutes.

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
**owner** (holds it), **viewer** (a signed-in user in its audience), **member** (any other
signed-in user), **share** (holds its current share link), **anonymous**. What a role may do depends
on the site's access: public, private, or restricted. `site.view` and the comment actions reach
beyond the owner (on a restricted site, only to its viewers and share-link holders). A refusal looks
like a missing site (404).

**Comment** — a note on one page of a site (`COMMENT#<id>` in the site's partition, ids sortable by
time): a **thread** or a one-level **reply** to one. It records the page **path** and the version
being served when it was written, so it outlives new versions; an optional **pin** marks the spot
it is about, recorded as an anchor. Owners and members read, write and
resolve; authors delete their own, owners any. The author is a user (`{ kind: 'user', email }`) or,
later, a **guest** (`{ kind: 'guest', name }`, a share-link viewer with a signed per-site cookie).

**Review mode** — `/review/<name>` on the app origin (`apps/web/src/pages/Review.tsx`): the site,
untouched (the edge only rewrites), in a frame beside its comments. The frame holds the review
shell, which reports where the frame is; comments attach to that path and the path bar follows it.
Clicking a pin selects its thread, and selecting a thread scrolls to its pin. With a live room,
the header shows who else is reviewing (one circle per person, you first) and the shell draws
their pointers on the same page. It needs the sites
domain under the app's registrable domain: the `fling_site` cookie is on that parent, a same-site
frame sends it (and a restricted site's pass is set within the frame), and nothing in front of the sites may forbid framing (the e2e checks).
`COMMENTS=false` turns comments off (the `comments` capability). Publish results (CLI, both MCP
servers) lead with the review page as the link to share for feedback (`reviewUrl`).

**Review shell** — `/_fling/review.html`, a static page served on every sites host
(`apps/web/src/review-shell-main.ts`; `routeSiteRequest` passes it through like the 404 page). It
frames the site on the site's own origin, so it can see what the app can't: the path and hash
route (SPA navigation included), scroll and the element under a click. It keeps the frame on the
site (an other-origin link or form is stopped and the review page offers to open it in a new
tab), turns a click (a spot) or a drag (a box) into an anchor while placing a pin, reports text the
reviewer selects as an anchor with its quote (the review page pins the new comment to it unless a
pin was placed), and draws pins (the selected one with its area)
and other reviewers' pointers. It talks to the review page over the **review bridge**
(`packages/shared/src/review-bridge.ts`), postMessage with each side accepting only the other's
origin; the shell holds no data.

**Anchor** — where a pin points (`CommentAnchorSchema`, `packages/shared/src/comments.ts`):
viewport percentages (`x`, `y`, always present, the last resort), and when the shell made it, a
CSS selector for the element plus the point inside it, the document point, the scroll and
viewport at the time, and the page's hash route. An **area** (a drawn box or selected text) adds
its size in the element and the document, with the spot as its top-left corner; selected text
also keeps its **quote**, which the shell finds again inside the element first. The shell
resolves it in that order (`apps/web/src/lib/review-shell.ts`), so a pin lands on the same element
on another screen size.

**Live room** — a site's realtime channel in review mode (`apps/api/src/live.ts`, protocol in
`packages/shared/src/review-live.ts`): everyone with the site's review page open is a **peer**
(`{id, name, colour}`; one per connection, named from their profile, coloured from their email)
who sees the others' pointers and hears `comments` when any comment changes, then refetches the
list through policy. A **live ticket** (`POST /api/sites/:name/live`, `comment.read`) is a 60-second
HMAC-signed pass naming the room and the peer; the client opens `${url}?ticket=…`, says `hello`
and is answered `welcome`. The core publishes through the **LiveHub** port (`publish(siteId,
message)`); the room logic (`relay`, `joinRoom`, `receive`, `leaveRoom`) is the core's and every
hub only keeps connections: in memory locally (`live-memory.ts`), a Durable Object per site on
Cloudflare, API Gateway WebSockets with live connection records (`SITE#<id>/LIVE#<connectionId>`)
on AWS. `LIVE_URL` says where clients connect; `LIVE=false` turns rooms off (the `live`
capability).

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
