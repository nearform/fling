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

**Share link** — `s--<token>.<sites domain>`: serves a site to anyone with the link, whatever its
access level (a restricted one, only the owner's included: handing out the link is the owner's
choice). The address
is the secret, so responses on a share host say `Referrer-Policy: no-referrer` and the browser
sends it to no one (`siteResponseHeaders` in `packages/shared/src/site-routing.ts`). Known limits:
a page's own `<meta name="referrer">` still wins, and on AWS only the responses the CloudFront
Function makes itself carry the header; the files S3 serves keep the browser's default
(`strict-origin-when-cross-origin`, which sends the origin cross-site).

**Site page** — `/sites/<name>` on the app origin (`apps/web/src/pages/Site.tsx`): everything about
one of your sites (overview, access, versions, archive and delete), in sections under
`components/site/`. The site list links each row to it.

**Site order** — how site lists are sorted, the same in every client: `sortSites`
(`packages/shared/src/site-sort.ts`), last updated first by default, or created (newest first) or
name (A–Z). The web list keeps it in `?sort=`, `fling ls` takes `--sort` and `fling_list` `sort`.

**Access level** — who can open a site, one of five, narrowest first: **only you** (`only_me`, the
owner alone), **teams** (`groups`) and **specific people** (`people`), both an audience (one site may
name groups and addresses; its level is `people` when it names an address), **everyone signed in**
(`members`) and **public** (`public`). The contract (names, labels, descriptions, the mapping onto
visibility, restriction and audience, the CLI's and MCP's words) is
`packages/shared/src/access.ts`; `applyAccess` and `initialAccess` in `apps/api/src/sites.ts` set
it. A new site gets the level its first deploy names (`access` on `POST …/deploys`, `fling deploy
--access`, `access` on `fling_deploy` and `fling_publish`), else the instance's default,
`SITE_DEFAULT_ACCESS` (`only_me` unless set to `members`), published as `defaultAccess` in the
metadata. A re-deploy never changes it. `PATCH /api/sites/<name> { access, audience? }`, `fling
access --only-me | --members | --public`, `fling_set_access` and the site's Access section change
it; the `accessLevels` capability.

**Private** — not public: open to every signed-in member of the instance, unless it is
restricted. **Public** — anyone can open the site itself; its review page and comments still need
sign-in (`comment.*` in `policy.ts` is for signed-in users only). Making a public site private gives
it back the access it had (only you, its audience, or every member).

**Restricted** — a private site only its owner and its audience see, and only they take part in its
comments (`SiteRecord.restricted`; `isRestricted` in `policy.ts`). With an empty audience, only its
owner: the `only_me` level. A record from before access levels has no `restricted`, and is
restricted exactly when its audience names someone, so every existing site keeps its access.

**Audience** — the people, besides its owner, who may see a restricted site: addresses, each one the
instance's email policy admits, and groups (`SiteRecord.audience`, `apps/api/src/sites.ts`;
contract in `packages/shared/src/audience.ts`). Clients name a group by its slug; the audience
stores its id. Editing the audience alone (`PATCH { audience }`, `fling access --add`,
`fling_set_audience`) restricts the site when it names someone and opens it to every member when
it is emptied; the `only_me` and `members` levels empty it. The audience is kept, and ignored,
while the site is public. Each address also gets a
**direct grant** (`USER#<email>/SHARED#<siteId>`), a projection for listing the sites shared with
someone; each group a group-site item (`GROUP#<id>/SITE#<siteId>`), so deleting the group can take
it out of every audience. Both carry the site's **listing** (`SharedListing` in
`apps/api/src/store/types.ts`): its id, name, owner, when it was created and updated, and whether
it is archived, live and restricted, rewritten by `putSite` whenever one of those changes. Set with `PATCH /api/sites/<name> { audience }`, `fling access` and
`fling_set_audience`; the `audiences` capability.

**Group** — a named list of people, such as a team, that any audience may name
(`apps/api/src/groups.ts`; contract in `packages/shared/src/groups.ts`): a slug unique on the
instance (a claim, `GROUPNAME#<slug>`), a display name, an **owner** (who made it) and up to 500
members, each an address the email policy admits. Every member of the instance lists groups, sees
who is in one and uses it in their sites' audiences; only the owner renames it, changes its members
or deletes it (`canGroup` in `policy.ts`; no co-managers, and admins get nothing extra). Each
member has a **membership** item (`USER#<email>/GROUP#<id>`), what policy reads for a restricted
site. Deleting a group never widens who sees a site: it leaves the audiences that name others too,
and where it was the only entry its id stays, matching nobody, so the site is the owner's alone
(shown as "a deleted group", `#<id>`) until they change it. The groups of exactly a given set of
people (`GET /api/groups?members=…`, `fling groups --members`, `fling_groups { members }`) come
from the memberships, intersected, then compared with each group's member count, never a scan:
how clients suggest a group that already holds the people listed. `/api/groups`, `fling groups`,
the `fling_group*` tools and the web's group editor (`apps/web/src/components/GroupEditor.tsx`,
opened from the Groups page and a site's Access section); the `groups` capability.

**Shared with me** — the restricted sites of others that someone may see because the audience
names them, by address or through a group they are a member of (`listShared` in
`apps/api/src/sites.ts`; `SharedSite` in `packages/shared/src/api.ts`). Read from index items
alone, one query per source (their direct grants, their memberships, each group's site items),
and from the listing those items carry, so no site is read; a group counts only while they are in
it. Archived sites, sites with no current version, their own sites and private sites every member
sees anyway are left out. An item the audience no longer backs (two saves of a site racing) can
list a site's name, nothing more: opening the site still goes through policy and the site pass. A
sharee sees the name, URL, review page, owner, when it was updated and how it reached them,
nothing of the owner's (versions, share link, audience). `GET /api/shared`, `fling ls --shared`,
`fling_list { shared: true }` and the Sites page's Shared with me tab; the `audiences` capability.

**Site pass** — how the edge lets someone into a restricted site (only the owner's included)
without holding its audience: a
host-only `fling_pass` cookie, signed with the site HMAC key, naming the site's id and the viewer,
for 5 minutes (`packages/shared/src/site-cookie.ts`). The edge sends a visitor without one to
`/auth/login`, where the API asks policy and sends a viewer to `/_fling-pass?t=<handoff>` on the
site's host (a 60-second signed **handoff**), and anyone else to the same path with a **deny
handoff** naming only the site. The edge turns the handoff into the pass, and the deny handoff into
a `fling_pass` that says the site refused them (`SITE_DENIED_TTL_SECONDS`, 10 seconds): while it
lasts, the site answers as a missing one, its 404 page at the address asked for. An expired pass
renews through the same redirects, so taking someone out of an audience shuts them out within 5
minutes, and someone added gets in within 10 seconds.

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
**owner** (holds it), **viewer** (a signed-in user in its audience, by address or through a
group), **member** (any other
signed-in user), **share** (holds its current share link), **anonymous**. What a role may do depends
on the site's access: public, private, or restricted. `site.view` and the comment actions reach
beyond the owner (on a restricted site, only to its viewers and share-link holders; on an `only_me`
one, to share-link holders alone). A refusal looks
like a missing site (404). Groups have their own, smaller table, `canGroup(actor, action, group)`:
anyone signed in may read one, its owner may change or delete it, and a refusal is a 403 (groups
are not secret).

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
their pointers on the same page. The **comments panel** sits beside the frame while the frame
keeps most of the width, and over the site as a sheet from the bottom when it can't (a container
query in `theme.css`); the header's toggle shows and hides it, the choice is kept per browser
(`panelOpen`, `apps/web/src/lib/review.ts`), and a thread link or a clicked pin shows it. Its
threads scroll as one list with the new-comment box at the top, one line until it is used. On a
narrow header the path bar, reload, open, presence and theme fold behind one button. It needs the sites
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

**Event** — something that happened that may concern people, such as a site shared with them or
a comment on their site, named by a stable key (`site.shared`, `comment.reply`, …). Its id is
derived from its cause, so a retried request records it once (`NOTIFY#<eventId>/EVENT`). The
**event catalogue** (`EVENT_CATALOGUE`, `packages/shared/src/notifications.ts`) lists every event
with its title, section, default per channel, whether it has a cool-down and the capability it
needs; clients build their settings from it.

**Channel** — a way a notification reaches someone: `email` so far (`ChannelId`,
`packages/shared/src/notifications.ts`). Email goes out through the **Mailer** port
(`apps/api/src/mail/types.ts`): `MemoryMailer` (tests, the e2e's Node runtime) and `FileMailer`
(`pnpm dev`, into `.fling-dev/mail/`) in the core, `SesMailer` (`platforms/aws/src/mail/ses.ts`)
and `CloudflareMailer` (`platforms/cloudflare/src/mail/email.ts`, over the `send_email` binding)
on the platforms, each built in its platform's `deps.ts`; all pass `mailerConformance`.
`MAIL_DRIVER` turns it on (the `email` capability), and with any channel on, the `notifications`
capability.

**Notification preferences** — what one person hears about: per event and channel `on` or `off`,
and a `muted` switch (`USER#<email>/NOTIFYPREFS`, keyed by address, so someone who never signed in
has them too). Only the cells they set are stored; the rest take the catalogue's defaults
(`effectivePreference`). A cell for an event the catalogue no longer has is ignored and dropped on
the next write. Everyone sees and changes theirs from every client (`GET`/`PUT
/api/me/notifications`, the web's Settings → Notifications at `/settings/notifications`,
`fling notifications`, the MCP tools `fling_notifications` and `fling_notifications_set`;
`apps/api/src/notifications/settings.ts`), with what was sent to them in the last 30 days
(`GET /api/me/notifications/sent`). An admin impersonating them may read them but not change them
(`account.notifications.change`): they are the person's consent. Nor may that admin read what was
sent to them (`account.notifications.sent`): admins never read other people's mail.

**Outbox** — notifications on their way, in Records (`apps/api/src/store/records.ts`): the event,
a fan-out marker, a **pending** notification per recipient, and batches due at a minute
(`NDUE#<minute>`), drained a minute at a time from a cursor that stays about 75 seconds behind
the clock, so a minute is complete before it is read. The outbox is the queue on every platform;
each only supplies the one-minute tick. A **batch** is what goes out as one message: one
recipient, one channel, one site (or none, for shares and groups), due 2 minutes after its first
notification, with everything that arrives meanwhile folded in. A drainer leases it (a conditional
update that sets a lease token; finishing or rescheduling it is conditioned on that token), so
overlapping drains never send it twice. A failed send is recorded (`NOTIFY/FAILURE#<id>`, no
address) for the admins' mail page, and retried with backoff or given up. After a message about comments on a site, the
recipient's next batch for that site waits out a **cool-down** (`coolDownUntil` on their batch
pointer).

**Notification hub** — `apps/api/src/notifications/`: actions call `notify` (in the request: the
event and its fan-out marker, never a send, never a failure of the action; nothing while an admin
impersonates), and each platform's one-minute tick calls `drain` (the Cloudflare cron, the AWS
scheduler's `{"fling":"notify"}`), which fans events out to their recipients (never the actor),
re-checks policy, the email policy, preferences and suppression at send time, and delivers each
batch through its channel, rendered with `TEMPLATES`. Every email carries an **unsubscribe link**,
`/notifications/unsubscribe?t=<token>` on the app origin (a token HMAC-signed with SESSION_SECRET
naming the address, event and channel; `GET` shows a page, `POST` unsubscribes, with Undo).

**Test email** — the one message Fling sends on request: an admin sends it from the mail page
(`/admin/mail`, `apps/api/src/notifications/mail-admin.ts`) to any address, straight to the
Mailer, not through the outbox, to check the sender's setup. Browser session only, at most 10 an
hour per admin (`USER#<admin>/NTEST#<hour>`). The same page shows the mail settings and the last 24
hours of sending, with no addresses or content.

**Suppression** — an address Fling does not mail, after a hard bounce or a complaint
(`SUPPRESS#<email>/SUPPRESS`); checked at send time. One the provider reported at send time
expires after 30 days (`SUPPRESSION_MS`, `apps/api/src/notifications/drain.ts`).

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

**Indexing** — sites are not indexed. `/robots.txt` on every sites host is Fling's own
`Disallow: /` (`ROBOTS_TXT`, from `apps/web/sites-robots.txt`), in place of any the site has, and
responses say `X-Robots-Tag: noindex`: all of them on Cloudflare, those the CloudFront Function
makes itself on AWS. Fling's pages on sites hosts (the 404 page, the review shell) also say
`noindex` and `no-referrer` in meta tags.

**Platform** — `platforms/<cloud>`: one cloud's entry point and adapters for the ports
(`platforms/aws`: Lambda, DynamoDB, S3, CloudFront KeyValueStore, SSM; `platforms/cloudflare`: one
Worker, D1, R2, Workers KV with D1 behind it). Every adapter, including the core's memory/fs ones,
passes the same suites from `packages/conformance`, and every platform passes the same e2e
scenario (`packages/e2e`) locally and as its post-deploy smoke test.
