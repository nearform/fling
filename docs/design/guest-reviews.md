<!-- markdownlint-disable MD013 -->

# Design: guest reviews

Status: proposal, for review. Nothing here is built yet.

A public site is open to anyone, but its review page and comments need sign-in (`comment.*` is
`signedIn` in `apps/api/src/policy.ts`). This design lets an owner open a site's review to
**guests**: people who give a name instead of signing in. The owner turns it on per site. It then
covers everyone who can open the site without signing in: anyone, on a public site, and holders of
the share link, on a private one.

Terms are CONTEXT.md's. New ones (to go into CONTEXT.md when built): **guest review** (the site
setting), **guest identity**, **guest cookie**, **guest review link**.

## 1. Goals, non-goals and terms

Goals: a per-site **Let anyone review** switch (off by default, next to visibility); guests read,
write, reply and delete their own comments in the same review page members use; the switch, and
rotating or revoking the share link, end guest access at once; rate limits, caps and owner
moderation from the start, with room for a challenge (CAPTCHA) later; parity across every client,
written once in the core.

Non-goals: guest accounts, recovering a lost guest identity, notifying guests (no address;
`docs/design/notifications.md` §1), guests resolving threads, a CAPTCHA now.

Terms:

- **Guest**: someone in review mode without a session, known by a name they typed, on one site.
- **Guest identity**: `{ site, gid, name }`. `gid` is random per site and browser; it is how the
  API recognises the same guest again.
- **Guest cookie**: the signed token carrying the guest identity on the app origin (§3).
- Unlike a signed-in reviewer, a guest is unverified, has no email, is bound to one site, cannot
  resolve, is rate-limited harder, never sees members' addresses and always wears a "guest" badge.

## 2. Where the guest reviews

Review mode is `/review/<name>` on the app origin. It frames the review shell
(`/_fling/review.html` on the site's host), which frames the site (`apps/web/src/pages/Review.tsx`,
`apps/web/src/review-shell-main.ts`, `packages/shared/src/review-bridge.ts`). Today the route sits
inside `Authenticated` (`apps/web/src/App.tsx`), and every `/api/*` route runs `requireAuth`
(`apps/api/src/auth/middleware.ts`).

**(a) The app origin serves `/review/<name>` to guests (recommended).** The guest cookie is
first-party on the app origin, HttpOnly, with `Path=/api/sites/<name>`, so only that site's API
sees it. The frame needs no cookie: a public host serves without one, and a share host skips the
sign-in and pass checks (`!target.share` in `routeSiteRequest`,
`packages/shared/src/site-routing.ts`). So guests need neither third-party cookies nor
`fling_site`, and framing works as today (same-site, nothing forbids it).

**(b) Review on the share host** (`s--<token>.<sites domain>/_fling/review…`). Rejected. A sites
host serves untrusted JavaScript (any member can publish), so a review UI and guest cookie there
would be readable and forgeable by the site itself, which is why the shell holds no data. It would
also need credentialed CORS from every sites host to the API, and a second review UI.

**Share links keep the token out of anything a server sees.** The **guest review link** is
`<app>/review/<name>#share=<token>`. A fragment never reaches a server or a `Referer`. The page
posts the token once, in the body of `POST /api/sites/<name>/guest` (§5), then drops the fragment
with `history.replaceState`; afterwards the cookie holds only a fingerprint. For a share guest the
comment list's `site.url` is the share URL (the site's own host would send them to sign in), so the
frame and the bridge use that origin. `reviewUrl` (`packages/shared/src/comments.ts`) gains an
optional `share` argument for every client.

## 3. Guest identity

**The name prompt**: "Your name", a note that everyone reviewing sees comments, and "Sign in
instead". It calls `POST /api/sites/<name>/guest { name, share? }`, which sets the cookie.

**The guest cookie**: `fling_guest`, `Path=/api/sites/<name>`, HttpOnly, Secure (as
`secureCookies`), `SameSite=Strict`, 30 days. Signed with `SESSION_SECRET` under its own prefix
(`fling-guest:`), like live tickets (`live.ts`), since the edge never reads it:

```ts
{ k: 'guest', s: siteId, g: gid, n: name, i: issuedAt, f?: shareFingerprint, x: expiry }
```

- `s`: the site's id, so a reclaimed name never honours old cookies. `g`: 128 random bits.
- `i` is compared with the site's `guestReviewSince` (§5): turning the switch off and on voids every
  earlier guest, which is what an owner wants after abuse.
- `f`: 16 bytes of `sha256(shareToken)`, only for guests who came through a share link.

**The same guest again.** `isAuthor` (`policy.ts`) compares site and `gid`, so two guests called
"Sam" are different authors. Renaming re-issues the cookie with the same `gid`; earlier comments
keep their name. **A lost cookie** is a new guest: the old comments stay and only the owner can
delete them. The prompt says so; there is no recovery.

**Name rules** (`GuestNameSchema`, `packages/shared/src/comments.ts`): 1 to 40 characters after
trimming and NFC; no control or format characters (bidi overrides, zero-width), no `@` (so it
cannot pass for an address on an allowed domain), no `://`; not `owner`, `admin` or the instance
name. A name proves nothing, so the protection is the badge: every client shows `<name> (guest)`
(`authorLabel` already does), and the web adds a badge styled unlike members'.

## 4. Policy changes

The actor carries everything, so `can` stays pure:

```ts
| { kind: 'guest'; siteId: string; gid: string; name: string; issuedAt: string; share?: string }
```

`PolicySite` gains `guestReviewSince`. One new role, **`guest`**, which `roleOf` gives when the
actor's `siteId` is the site's, the switch is on and `issuedAt >= guestReviewSince`, and the site
is public **or** `actor.share` matches the fingerprint of the current `shareToken`
(`shareFingerprint`, pure, in `packages/shared`). Otherwise a guest actor is `anonymous`.

**The same switch gates share links.** A share link today means "view"; letting every link already
handed out comment would quietly change what it means. One switch, one answer: "people who can open
it without signing in may review it", everyone on a public site, link holders on a private one.

**Restricted sites** are open to guests only through the share link with the switch on. That
follows `site.view`, which already lets link holders in: the link is the owner's deliberate way
round the audience.

Rules:

| Action | guest | Why |
|---|---|---|
| `comment.read` | yes | They need the conversation to take part in it |
| `comment.create` | yes | The point of the feature |
| `comment.resolve` | no | Resolving closes a thread for everyone. It is the owner's and the team's workflow, and an easy target for vandalism |
| `comment.delete.own` | yes | `isAuthor` matches the `gid` |
| `comment.delete` | no | Owner only, as today |
| `site.view` | yes | Implied by how they got the role. It keeps the policy test's edge agreement whole |
| everything else | no | |

`ACTIONS` gains **`site.guestReview`** (`ownerOnly`): `PATCH /api/sites/:name { guestReview }`,
`fling_set_guest_review`. The header comment's "Share-link holders get nothing yet" is rewritten.

**Ending access at once.** Policy reads the site on every request; the cookie says who the guest
is, never what they may do. Switching off, rotating or revoking the link (the fingerprint no longer
matches) and making the site private all bite on the next request. Live rooms need one more step
(§5).

**Policy tests** (`apps/api/tests/policy.test.ts`): the role × access × action table with `guest`;
`roleOf` for another site's guest, a cookie older than `guestReviewSince`, the switch off, a
private site without the link, the link rotated and revoked, a restricted site with and without
it; `canDeleteComment` for two same-named guests; and the edge agreement test mapping `guest` to
an anonymous request on the public host or one on the share host.

## 5. Data and API

**The site setting.** `SiteRecord.guestReviewSince: string | null` (when last switched on; null:
off). Site record v3, with an upgrade in `store/evolution.ts` (`?? null`) as v2 did for
`audience`; a v2 reader tolerates v3 and passes the field through, and a rollback is safe because
old code has no guest actor. The edge does not need it (guests open sites as anonymous or share
visitors do), so no route-table change. `Site` and `UpdateSiteRequestSchema`
(`packages/shared/src/api.ts`) gain `guestReview: boolean`; switching on when already on keeps
`since`.

**Comment author.** `CommentAuthorSchema` already has `{ kind: 'guest', name }`, never written
today. Add `gid`, which is harmless to show (the cookie is signed) and tells same-named guests
apart. No comment `v` bump: no guest author exists yet. A guest is never `resolvedBy`.

**What a guest reads.** Guests were never trusted with members' addresses: in their responses a
user author becomes `{ kind: 'member', name }` (`peerName` over the user record), a view-only kind.

**Routes**, in a Hono group mounted before `requireAuth`, whose `resolveActor` tries a Bearer key,
the session, the guest cookie, then anonymous:

| Route | Who | Notes |
|---|---|---|
| `POST /api/sites/:name/guest { name, share?, challenge? }` | anonymous or guest | Policy asks `can(would-be guest, 'comment.create', site)`. 201 sets the cookie; every refusal is 404. Rate-limited per network. Renaming goes through the same route and keeps the `gid` |
| `GET /api/sites/:name/guest` | guest | `{ name, gid }` or 404, so the page knows who it is |
| `DELETE /api/sites/:name/guest` | guest | Forgets the cookie ("Stop reviewing as Sam") |
| `GET`/`POST …/comments`, `DELETE …/comments/:id`, `POST …/live` | guests too | As today, through `comments.ts` and `live.ts` with the guest actor |

A session wins over a guest cookie, except when policy refuses the user `comment.read` (say,
someone outside a restricted site's audience sent the guest review link): then their guest cookie
is used. Policy makes that choice, where actors are resolved (`resolveSite`, `sites.ts`).

**CSRF.** `SameSite=Strict`, and every guest request other than GET or HEAD must carry
`Origin: <APP_ORIGIN>`, as `requireAuth` demands of sessions. No CORS on guest routes.

**Live rooms.** `issueLiveTicket` accepts a guest as the peer `{ name, colour: peerColour(gid),
guest: true }`, without a picture (`LivePeerSchema` gains `guest?`). The core's `broadcast` strips
other peers' pictures from what guests receive. To end access at once, `LiveRoom` gains
`close(conn)`, and switching off or rotating or revoking the link publishes `{ type: 'guests-off' }`,
on which the core's room logic closes every guest connection. Each hub implements `close`
(memory, the Durable Object, API Gateway's `DeleteConnection`); guests who still qualify reconnect.

## 6. Abuse

**Rate limits**, once in the core (`apps/api/src/guest-limits.ts`) over `Table`, no new port: `put`
`{ n: 1, expiresAt }` `ifAbsent`, else `update` `add: { n: 1 }` `ifExists`, retrying the `put` if it
expired in between (expired items count as absent, `table/types.ts`). Keys sit in the site
partition where they can, so deleting the site removes them.

| Limit | Key | Default |
|---|---|---|
| Comments per guest | `SITE#<id>/GRATE#g#<gid>#<10-min window>` | 10 per 10 minutes |
| | `SITE#<id>/GRATE#g#<gid>#<day>` | 50 per day |
| Guest comments per site | `SITE#<id>/GRATE#site#<hour>` | 100 per hour |
| Guest comments per network | `GUESTNET#<net>/RATE#<hour>` | 30 per hour, across sites |
| New guest identities per network | `GUESTNET#<net>/ID#<hour>` | 10 per hour |
| Guest comments on the instance | `GUESTS/RATE#<minute>` | 300 per minute |

`<net>` is a keyed HMAC of the client's IPv4 /24 or IPv6 /64, so no address is stored. Each
platform's entry point sets `clientIp` on the request context (`cloudfront-viewer-address` on AWS,
`cf-connecting-ip` on Cloudflare); the core never asks which cloud it is on. Over a limit: 429
`rate_limited` with `Retry-After`. Defaults live in `packages/shared/src/limits.ts`, with one
config override (`GUEST_RATE_LIMITS`).

**Caps**, checked in `addComment` from the list it already reads (no new index):

| Cap | Default |
|---|---|
| Characters in a guest's comment | 2000 (members: `COMMENT_MAX_CHARS`, 4000) |
| Open threads per guest per site | 20 |
| Guest comments per site, in total | 200, so guests can never fill the site's 1000 and lock members out |
| Guest name | 40 characters (§3) |

Guest bodies are never turned into links, in any client or email.

**Owner moderation**: delete any guest comment (`comment.delete`); **delete everything from this
guest** (`DELETE /api/sites/:name/comments?guest=<gid>`); switch off, which voids every guest
cookie for good (§3). A block list waits: clearing cookies defeats it, so network limits do more.

**Logging without personal data**: one line per guest comment, refusal and limit hit, with
`siteId`, `gid`, the `<net>` hash, action and outcome; never the name, body or IP. Switching on or
off logs `siteId` and the state. No `AUDIT` items (those are for admins).

**Notifications** (`docs/design/notifications.md` §2): a guest's thread notifies the owner ("Sam
(guest) commented on …", escaped, 300 characters) and a guest's reply the members in the thread.
Guests are never recipients: the hub skips `kind: 'guest'` participants. The per-site limit also
caps the email guests can cause.

**Room for a challenge**: a `ChallengeVerifier` port (`verify(token, clientIp)`), `none` by
default. A Turnstile adapter is a plain `fetch`, so it lives in the core. `GUEST_CHALLENGE` (plus
its secret) publishes `guestChallenge: { kind, siteKey }` in the metadata; the name prompt shows the
widget and `POST …/guest` requires `challenge`. Only creating an identity is challenged.

## 7. Clients, with parity

**Capability** `guestReviews`: `GUEST_REVIEWS` and comments both on (`apps/api/src/instance.ts`,
`InstanceMetadataSchema`). Without it clients hide the feature, and the API refuses the setting and
ignores guest cookies. It follows the config checklist in `.claude/rules/config-and-branding.md`.

**Web.** The Access section (`components/site/SiteAccess.tsx`) gets **Let anyone review**,
explained per site ("Anyone who opens the site can comment with a name", or "People with the share
link can…", warning when there is none), plus **Copy guest review link**. `review/:name` renders
outside `Authenticated` when the capability is on: name prompt, then the review, with "Sam
(guest)", "Change name", "Stop" and "Sign in" in place of `UserMenu`, and no resolve buttons
(`can.resolve` is false). Guest comments carry the badge, and the owner gets "Delete all from Sam
(guest)". `badges.tsx` marks sites open to guests.

**MCP, both servers** (`packages/shared/src/mcp-tools.ts`): a new `fling_set_guest_review { name,
on }`, not a flag on `fling_set_visibility`, since the switch also covers private sites through
share links; `fling_info` shows it; `fling_share` returns the guest review link; `fling_comments_list`
shows `Sam (guest)`; `fling_comment_delete` takes `guest` (a `gid`). `fling_set_visibility`'s
description, the server instructions and `SKILL.md` stop saying review always needs sign-in.

**CLI** (`apps/cli/src/cli.ts`): `fling guests <name> [on|off]` (no argument shows it), for the same
reason not a `fling visibility` flag. `fling share` prints the guest review link, `fling info` the
setting, `fling comments` labels guests, and `fling uncomment <name> --guest <gid>` deletes one
guest's comments.

## 8. Security and privacy

- **Share tokens** travel only in the link's fragment and one unlogged POST body, never a path,
  query or cookie, and `replaceState` clears the address bar. Fragments never reach a `Referer`
  (the app already sends `strict-origin-when-cross-origin`, `apps/api/src/middleware.ts`). Out of
  scope, and true today: a share-hosted site's own third-party requests send its `s--<token>`
  origin as `Referer`; `Referrer-Policy: no-referrer` on share hosts is a separate routing change.
- **Untrusted names and bodies** are shown as text: React escapes them (never
  `dangerouslySetInnerHTML`), the shell draws peer names with `textContent`, emails HTML-escape,
  and CLI and MCP output strip control characters (terminal-escape injection) even though
  validation refuses them.
- **No enumeration.** Every refusal is `resolveSite`'s 404, `POST …/guest` included (private site,
  wrong token, switched off); it is rate-limited per network, and 20-character share tokens
  (`site-labels.ts`) are not guessable.
- **Restricted sites** stay closed to guests except through the current link with the switch on.
- **Site pass**: no interplay. Guests never get `fling_site` or `fling_pass`; the share host skips
  both, and policy and the edge already agree the link opens a restricted site.
- **Impersonating admins** see guest comments as their target does; guest identities belong to no
  account, so nothing outlives the session.

## 9. Testing

- **Unit**: cookie sign, verify and tamper; `GuestNameSchema`; `shareFingerprint`; the limiter over
  the memory Table with a fake clock (windows, expiry, the put-then-add race); caps; redaction.
- **Policy**: §4. **API** (`apps/api/tests/helpers.ts`): `Origin` checks, session versus cookie and
  the fallback, 404 parity, 429 with `Retry-After`, `?guest=` deletion.
- **Conformance**: the counter uses existing Table semantics; add a case (ifAbsent over an expired
  item, `add`, update on an expired item fails) if `packages/conformance/src/table.ts` lacks one.
  Hub tests cover `LiveRoom.close`.
- **E2E** (`packages/e2e/src/scenario.ts`, both local runtimes and the smoke test), over HTTP with
  a cookie jar, skipped without the capability:
  1. The owner publishes a throwaway site, makes it public and turns on guest review (CLI).
  2. A guest posts `…/guest`, comments, lists comments (member authors redacted), and deletes their
     own comment. A second guest cannot delete it.
  3. The owner makes the site private and creates a share link. A guest without the link gets 404.
     A guest with the link enters through `share`, comments, and sees the share URL as `site.url`.
  4. The owner rotates the link: the share guest's next request is 404. The owner turns the switch
     off: the public-path guest gets 404, even after the switch goes back on.
  5. Eleven comments in a row from one guest: the eleventh is 429.
  6. Clean up by deleting the site.

## 10. Phases

| Phase | What | Size |
|---|---|---|
| 1 | Policy (`guest` role, `site.guestReview`); site v3; guest cookie and routes; `resolveActor`; CSRF; author redaction; rate limits and caps; `?guest=` deletion; capability and config on both platforms; web switch, name prompt and badges; `fling guests`, `fling_set_guest_review` and the comment-tool changes; guest review link in every client; docs (CONTEXT.md, SKILL.md, CLI README, deploy guides); policy, API and e2e tests | Large: about 1.5 weeks |
| 2 | Live rooms for guests: tickets, tailored peers, `LiveRoom.close` on all three hubs, `guests-off` | Medium: about 3 days |
| 3 | Notifications for guest comments, once notifications phase 1 ships | Small |
| 4 | `ChallengeVerifier` with Turnstile, if abuse appears | Small |

Phase 1 is shippable alone. Guests' review pages refetch comments without a live room, because
`useLive` is off for guests until phase 2.

## 11. Open questions

1. **Instance default.** Should `GUEST_REVIEWS` default to off, so an admin opts the instance in
   before any owner can, or to on, since owners still opt in per site? The proposal is off.
2. **Site name in the guest review link.** `/review/<name>#share=…` shows a private site's name to
   share-link holders (the review header shows it too). Is that acceptable? If not, the link becomes
   `/review#share=…` and the API finds the site from the token, which needs a share-token index item.
3. **Members' addresses.** Guests see members as display names only (§5). Agree, or is showing
   addresses to guests fine on your instances?
4. **Guests resolving their own threads.** The proposal says no in the first release. Do you want
   it?

## Sources

Fling files: `CLAUDE.md`; `CONTEXT.md`; `.claude/rules/*.md`; `docs/design/notifications.md`;
`apps/api/src/{policy,comments,live,sites,middleware,instance}.ts`;
`apps/api/src/auth/middleware.ts`; `apps/api/src/routes/api.ts`;
`apps/api/src/store/{types,evolution,records}.ts`; `apps/api/src/table/types.ts`;
`packages/shared/src/{comments,review-live,review-bridge,site-routing,site-cookie,site-labels,api,mcp-tools}.ts`;
`apps/web/src/pages/Review.tsx`; `apps/web/src/App.tsx`; `apps/cli/src/cli.ts`.
