<!-- markdownlint-disable MD013 -->

# Design: notifications (email first)

Status: reviewed 2026-10-28, ready to build. Nothing here is built yet.

Fling tells people when something happens that concerns them: a site is shared with them (directly
or through a group), they are added to a group, someone comments on their site or replies to their
thread. One **notification hub** in the core takes domain events, decides who hears about them and
fans them out to **channels**. Email is the first channel, sent through each cloud's own email
service from a sender the operator already has. An in-app inbox, webhooks and Slack can follow
without touching the hub.

Terms are CONTEXT.md's. New ones this design adds (to go into CONTEXT.md when built): **event**,
**event catalogue**, **channel**, **notification preferences**, **outbox**, **batch**,
**cool-down**, **suppression**.

## 1. Goals and non-goals

Goals:

- Tell people about the events in §2 by email, on both platforms, with each cloud's native sender
  (Cloudflare Email Service on Cloudflare, SES on AWS), using a sending identity the operator
  manages in their own infrastructure (§6).
- Write it once: the hub, the catalogue, preferences, the outbox, folding, templates and the
  send-time policy check are core code over the existing ports plus one new port, `Mailer`.
- The recipient decides. Whether someone hears about an event depends only on their preferences,
  never on the client the actor used or a choice the actor made.
- Let each person choose what they hear about, per event and channel, from every client (web, CLI,
  both MCP servers), and unsubscribe from an email without signing in.
- Let admins check the mail setup without sending anything automatically (§10.2).
- Never reveal a restricted site to someone who may not see it, and never become a spam or
  phishing relay.

Non-goals (for now):

- Marketing or bulk mail, localisation, per-user time zones.
- Inbound email (reply-by-email to comment).
- @mentions in comments (the catalogue has room; §2).
- An in-app inbox, webhooks, Slack (designed for, built later; §12).
- Notifying guests (share-link viewers, `docs/design/guest-reviews.md`): they have no address.
- Provisioning a sending identity. The operator brings one (§6).

## 2. Events: the catalogue

One registry, `packages/shared/src/notifications.ts`, browser-safe like the other contracts. Each
entry is data the hub, the preferences and every client read, so a new event needs no client
change:

```ts
export interface EventDefinition {
  key: EventKey              // stable forever: stored in preferences and unsubscribe tokens
  title: string              // "Someone shares a site with you"
  description: string        // one line for the settings page and `fling notifications`
  section: 'sharing' | 'groups' | 'comments'
  defaults: Record<ChannelId, Delivery>   // 'on' | 'off' ('digest' once digests exist)
  coolDown: boolean          // later batches for the same recipient and site wait (§5.4)
  capability?: string        // only on instances with this capability ('comments')
}
```

Templates are not in the shared registry (they render server data and would bloat the web bundle).
They live in the core as `TEMPLATES: { [K in EventKey]: Record<ChannelId, Template<K>> }`, so the
type checker refuses an event without a template for every channel.

| Key | Fires when | Who is notified | Email says | Link | Default (email) | Ships |
|---|---|---|---|---|---|---|
| `site.shared` | An owner adds an address to a site's audience (`applyAudience`, `sites.ts`) | Each address added, not the owner | "Ana shared *q3-report* with you on Acme Fling" | Review page `/review/<name>` (sign-in first if needed) | on | 1 |
| `site.shared_via_group` | An owner adds a group to a site's audience | Each member of the group who can see the site, not the owner | "Ana shared *q3-report* with *Design team*, which you are in" | Review page | on | 1 |
| `group.member_added` | A group's owner adds people (`createGroup`, `changeMembers`, `groups.ts`) | Each address added, not the owner | "Ana added you to *Design team*", plus the sites it opens to you that you can see | Group page `/groups/<slug>` | on | 1 |
| `comment.created` | A thread is started on a site (`addComment`, `comments.ts`) | The site's owner, unless they wrote it | "Ben commented on *q3-report* /docs/: <first 300 characters>" | Review page at the thread, `/review/<name>?path=…&thread=<id>` | on | 1 |
| `comment.reply` | A reply is added to a thread | The thread's author and everyone who replied in it, except the replier | "Ben replied in a thread on *q3-report*: …" | Review page at the thread | on | 1 |
| `comment.mention` | Later: `@address` in a body | The address mentioned, if it can read the comments | — | Review page at the thread | on | later |

Rules that hold for every event:

- **The recipient decides.** There is no actor option to send quietly. An action notifies whoever
  it concerns, subject only to their preferences (§4), the send-time checks (§9) and the limits
  (§5.5).
- **Never about your own action.** The actor is removed from the recipients before anything is
  queued.
- **Only what changed.** Share and group events name the addresses (or groups) added by this
  change. Saving an audience or a group with the same people notifies nobody.
- **One email per recipient per cause.** A site owner who is also in the thread gets
  `comment.reply` only (the more specific event wins). Someone added to a site directly and
  through a group in the same change gets `site.shared` only.
- **Removing someone** (from an audience or a group) notifies nobody.
- **Large fan-outs are fine, and visible.** One audience change can reach `AUDIENCE_GROUPS_MAX`
  (10) × `GROUP_MEMBERS_MAX` (500) people (`packages/shared/src/audience.ts`, `groups.ts`). The
  request writes one event; the drainer fans out over as many ticks as it takes (§5.1). An event
  with more than 100 recipients is logged (event key and count, no addresses).
- Links use the existing pages: `reviewUrl` (`packages/shared/src/comments.ts`, which already takes
  `?path=`) and `/groups/:slug` (`apps/web/src/App.tsx`). Opening a thread from an email needs
  one small web change: the review page reads `&thread=<id>` and selects it.
- Comment events exist only while the `comments` capability is on.

## 3. Recipients who have never signed in

Audiences and groups may name any address the email policy admits (`checkEmails` in `sites.ts`),
whether or not it has signed in (`knownEmails`, the `USERS` index). They are emailed like anyone
else:

- They get the catalogue's defaults: preferences are keyed by address (`USER#<email>/NOTIFYPREFS`),
  not by user record, so a person can set them (through an unsubscribe link) before they ever sign
  in, and they are still there after.
- The link goes to the review or group page. The web sends them through sign-in, which the email
  policy admits, because `checkEmails` already refused any address it would not. The email says
  "sign in with your <issuer display name> account <address>" so they know which account to use.
- The email names only the actor, the site or group and the instance.
- Fling can only ever mail people the instance would let sign in: production refuses to start
  without `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS` (`apps/api/src/config.ts`), and an address
  that later stops being admitted (the instance narrows its allowlist) is dropped at send time,
  because the hub re-runs the email policy (`emailAllowed`) on every recipient.

## 4. Preferences

### 4.1 Model

Per recipient, a matrix of event × channel, each cell `on` or `off` (`digest` arrives with
digests, §12), plus a global `muted` switch. Effective value, first that applies:

1. `muted` → off for everything.
2. The recipient's own cell, if set.
3. The catalogue's `defaults`.

Stored as one record, `USER#<email>` / `NOTIFYPREFS`:

```ts
{ v: 1, muted: false, cells: { 'comment.created': { email: 'off' } }, updatedAt }
```

Only overrides are stored. A cell for an event the catalogue no longer has is ignored (and dropped
on the next write); a new event takes its default. So growing the catalogue needs no migration,
and `v` only moves if the record's shape does (`store/evolution.ts`).

Actions taken while an admin impersonates someone never notify, and preferences cannot be changed
while impersonating (CONTEXT.md: nothing may outlive the session, and preferences are the user's
consent).

### 4.2 Unsubscribe without signing in

Every email carries a link to `/notifications/unsubscribe?t=<token>` and the RFC 8058 headers
`List-Unsubscribe: <https://…?t=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

- The token is HMAC-signed with `SESSION_SECRET`, domain-separated (`fling-unsubscribe:` prefix,
  as `live.ts` does for tickets), and names the address, the event and the channel. It does not
  expire and cannot be revoked: the most a leaked link can do is turn email off for one address,
  which the page lets them undo.
- `GET` shows a small page on the app origin: "Stop emails about comments on your sites" with a
  button, and "stop all email from <instance>". Only `POST` changes anything, so mail scanners
  that follow links unsubscribe nobody. The one-click `POST` from the mail client turns that
  event's email cell off.
- After unsubscribing, the page offers **Undo** (the same token, `POST` with `undo`), and, for a
  signed-in visitor, a link to the settings page.
- Any well-formed but invalid token gets the same neutral page, so the endpoint reveals nothing.

## 5. Delivery

### 5.1 The flow

```text
 route / MCP tool (sites.ts, groups.ts, comments.ts)
   └─ notify(deps, event)                       core, in the request: one transact, 2 writes
        └─ the EVENT item (ifAbsent) + a fan-out marker due now
 tick (every minute: Cloudflare cron, AWS EventBridge Scheduler)
   └─ drain(deps)                               core
        1. fan out each new event: recipients(event) − actor (group members read here),
           one PENDING item per recipient, folded into that recipient's open batch (resumable)
        2. for each due batch (recipient × channel × site):
          lease → load pending items → for each: re-check policy, email policy, preferences,
          suppression → render one message (one event, or several folded) → channel.deliver
          → mark sent / schedule retry / give up
```

`notify` never sends anything itself. A request never waits on a provider and never fails because
one is down. A share with a 500-member group costs the request two writes, not a thousand: the
drainer fans out.

### 5.2 The ports

The **Channel** is core code; the **Mailer** is the port a platform implements.

```ts
// apps/api/src/notifications/channel.ts
export type ChannelId = 'email' /* | 'inbox' | 'webhook' later */

export interface Channel {
  id: ChannelId
  /** Deliver one batch to one recipient: one message, however many events it folds. */
  deliver(batch: DeliveryBatch, deps: Deps): Promise<DeliveryResult>
}

export type DeliveryResult =
  | { ok: true; providerId?: string }
  | { ok: false; retry: boolean; reason: 'throttled' | 'transient' | 'rejected' | 'suppressed' }

// apps/api/src/mail/types.ts — the port
export interface Mailer {
  send(message: MailMessage): Promise<MailResult>
}

export interface MailMessage {
  to: string
  from: { address: string; name: string }
  replyTo?: string                 // MAIL_REPLY_TO, the operator's; never the actor's
  subject: string                  // CR/LF stripped
  text: string
  html: string
  headers: Record<string, string>  // List-Unsubscribe, List-Unsubscribe-Post
  /** the batch id: adapters tag the message with it (SES tag, a header on Cloudflare) */
  batchId: string
  /** event keys, for provider analytics; never personal data */
  tags: string[]
}

export type MailResult =
  | { ok: true; providerId?: string }
  | { ok: false; retry: boolean; reason: 'throttled' | 'transient' | 'rejected' | 'suppressed' }
```

The email channel renders the batch with `TEMPLATES` and the instance metadata, then calls
`deps.mailer.send`. `Deps` gains `mailer?: Mailer` beside `live?`; `buildDeps` takes it from the
platform for the `ses` and `cloudflare` drivers and refuses a cloud driver without one, as it does
for the other ports (`apps/api/src/deps.ts`).

| Adapter | Where | Used by |
|---|---|---|
| `MemoryMailer` | `apps/api/src/mail/memory.ts` | unit tests; the e2e's Node runtime |
| `FileMailer` | `apps/api/src/mail/file.ts`: writes `.eml` and `.html` under `.fling-dev/mail/` | `pnpm dev`; listed at `/dev/mail` (dev login only) |
| `SesMailer` | `platforms/aws/src/mail/ses.ts`: SES v2 `SendEmail`, one call per recipient | AWS |
| `CloudflareMailer` | `platforms/cloudflare/src/mail/email.ts`: the Email Service `send_email` binding | Cloudflare, and `wrangler dev`, where the binding is simulated (§6) |

Errors map onto `MailResult` in the adapter: SES `Throttling`/`TooManyRequests` and Cloudflare
`E_RATE_LIMIT_EXCEEDED` → `throttled`; Cloudflare `E_DAILY_LIMIT_EXCEEDED` and an SES daily
sending quota → `throttled` with a `quota` flag (§5.5); Cloudflare `E_RECIPIENT_SUPPRESSED` →
`suppressed`; SES `MessageRejected`, Cloudflare `E_RECIPIENT_NOT_ALLOWED` and
`E_SENDER_NOT_VERIFIED` → `rejected` (and an error log, because they mean misconfiguration).

The in-app inbox, when it comes, is a Channel with no port: it writes `USER#<email>/NOTE#<id>`
items through Records and, through a per-user LiveHub room, tells open tabs to refetch.

### 5.3 The outbox in Records

All keys are reached by key or prefix query; nothing scans.

| pk | sk | Item |
|---|---|---|
| `NOTIFY#<eventId>` | `EVENT` | The event, written `ifAbsent`. The idempotency key: a retried request makes the same `eventId`, finds it and queues nothing. Expires after 30 days |
| `NDUE#<minute>` | `FANOUT#<eventId>` | An event still to fan out (with how far it got), written with the event |
| `USER#<email>` | `NPEND#<channel>#<eventId>` | A pending notification for one recipient (event key, site id, actor, a short excerpt). Expires after 7 days |
| `USER#<email>` | `NBATCH#<channel>#<siteId or ->` | The pointer to the recipient's open batch for that site (`-` for events with no site): its due minute, and `coolDownUntil` after a send. How fan-out finds the batch to fold into |
| `NDUE#<minute>` | `<channel>#<email>#<siteId or ->` | The **batch**: due at `<minute>` (UTC, `2026-10-28T14:05`), with `state`, `attempts`, `leaseUntil` |
| `NOTIFY` | `CURSOR` | The last minute fully drained |
| `NOTIFY` | `STATS#<hour>` | Counters for the admin page (§10.2): sent, retrying, given up, suppressed, and the last few failure reasons with batch id and event key. Expires after 48 hours |
| `USER#<email>` | `NSENT#<sortable id>` | What was sent: event keys, subject, provider id, when. Expires after 30 days. Delivery status for the e2e and the user |
| `SUPPRESS#<email>` | `SUPPRESS` | Suppressed after a hard bounce or complaint (§5.6) |
| `USER#<email>` | `NOTIFYPREFS` | Preferences (§4) |

Event ids are derived, not random, so the same cause makes the same id:
`comment.created:<siteId>:<commentId>`, `site.shared:<siteId>:<site updatedAt>` (naming the
addresses and groups added), `group.member_added:<groupId>:<group updatedAt>`.

Folding: fan-out reads the recipient's `NBATCH` pointer. If it points at a batch still `due`, the
pending item joins it. Otherwise it opens a batch at `max(now + 2 minutes, coolDownUntil)` and
writes the pointer and the batch in one `transact` (the pointer `ifAbsent` or on its previous
value, so two fan-outs racing for one recipient open one batch).

The drainer queries `NDUE#<minute>` for each minute from the cursor to now, so a missed tick only
delays mail. A batch is leased with a conditional update (`fieldEquals('state','due')` or an expired
`leaseUntil`), so overlapping ticks never send twice. After a send it deletes the pending items
and the batch, sets the pointer's `coolDownUntil` (for cool-down events, §5.4) in one `transact`,
and writes `NSENT`. A failed send with `retry` moves the batch to a later minute with backoff (1,
5, 15, 60 minutes; given up after 6 attempts and logged), except for quota throttling (§5.5);
`rejected` or `suppressed` drops it.

The provider call is the one place a send could be duplicated: neither SES nor the Cloudflare
binding documents an idempotency key, so a crash after the provider accepted a message but before
the batch is deleted sends it again on the next lease. The lease is longer than any send, so only
that crash window remains. That is acceptable for notifications.

### 5.4 Folding and the cool-down

- A batch is due **2 minutes** after its first item. Anything else that arrives for that recipient
  and site meanwhile folds into it, so a quick burst is one email ("Ben and Ana left 4 comments on
  *q3-report*").
- **Cool-down** (comment events): after an email about a site, the recipient's next batch for that
  site is due no sooner than **15 minutes** later. A 40-minute review session with 25 comments is
  about 3 emails, not 10.
- Batches are per recipient, channel and site, so activity on two sites never folds into one email.
  Share and group events have their own batch (`-`) with no cool-down.
- Digests (a daily summary per recipient, the `digest` cell value) are phase 2.

### 5.5 Rate limits

There is no per-actor limit. The email policy already confines recipients to people the instance
admits (§3), and an action's notifications go out in full or not at all. The limits protect
recipients and the provider:

| Limit | Key | Default | Over the limit |
|---|---|---|---|
| Emails per recipient per hour | `USER#<email>/NRATE#<hour>` | 10 | the batch moves to the next hour and keeps folding |
| Instance sends per minute | `NOTIFY/RATE#<minute>` | below the provider's rate (§6) | the drainer stops and the next tick goes on |
| Provider daily quota (`throttled` with `quota`) | — | the provider's | the batch moves to the next UTC day without using an attempt; it is dropped only when its pending items expire (7 days). The first quota hit each day logs a warning |

Counters are items with `expiresAt` and the Table's atomic `add` (`table/types.ts`, `Patch.add`).

### 5.6 Bounces and complaints (phase 2)

A hard bounce or a complaint writes `SUPPRESS#<email>`, and a complaint also turns the address's
email off. Suppressed addresses are skipped at send time. Both providers also keep their own
suppression list, the guard until then. The handler, `recordDeliveryEvent(deps, {email, kind})`,
is core code. Events reach it differently on each platform:

- **Cloudflare** refuses a suppressed recipient at once (`E_RECIPIENT_SUPPRESSED`), so Fling learns
  of suppression from the send itself. Bounce and complaint events reach a Worker only through a
  Queue (Email Service event subscriptions), so phase 2 adds a queue and a `queue` handler that
  calls `recordDeliveryEvent`.
- **SES** accepts a send to a suppressed address and silently drops it. The operator's
  configuration set already publishes bounces and complaints somewhere; the module takes an
  optional `mail.events_topic_arn` (an SNS topic the configuration set publishes to) and subscribes the
  API Lambda to it, which calls `recordDeliveryEvent` like the non-HTTP `{"fling":"migrate"}`
  event, with no public endpoint.

### 5.7 Running the drainer

**The outbox in Records is the queue on both platforms, and each platform only supplies a
one-minute tick that calls the core's `drain(deps)`.**

| | Cloudflare | AWS |
|---|---|---|
| Tick | A second cron, `* * * * *`, in the existing `scheduled` handler (`platforms/cloudflare/src/worker.ts`, `wrangler.jsonc` `triggers.crons`) | EventBridge Scheduler, `rate(1 minute)`, invoking the API Lambda with `{"fling":"notify"}`: the same pattern as `{"fling":"migrate"}` (`platforms/aws/src/lambda.ts`) |
| Sooner than the tick | none needed: a batch waits 2 minutes anyway | none needed |
| Overlap | the batch lease | the batch lease |

Why not Cloudflare Queues or SQS for delivery:

- They would add a second source of truth beside the outbox.
- Each needs a new resource and binding per platform.
- Their retry semantics differ between platforms.
- The outbox already gives idempotency, retries and folding. That is core code, and the conformance
  suites run it on every Table adapter.

Why not `ctx.waitUntil` either: it lasts at most 30 seconds after the response, and has no
counterpart on Lambda. The tick is cheap:

- On Cloudflare, Workers Paid allows 250 crons, and the Worker already has one.
- On AWS, about 43,000 scheduled invocations a month is well inside EventBridge Scheduler's
  14 million free invocations.

If volume ever outgrows a one-minute drain, a queue can carry batch ids so they drain in parallel,
with no change to the core.

## 6. The providers: bring your own sender

The operator owns the sending identity: its domain, DKIM, SPF, DMARC and reputation usually serve
other apps too, and live in the operator's infrastructure (typically a domain identity, a
configuration set it uses by default and an SNS topic for bounces). Fling's infrastructure only grants itself permission to send, and is told the addresses.

Checked against the providers' documentation on 2026-10-28 (Sources).

### The sending domain and the sites domain

`MAIL_FROM`'s domain must not be the sites domain itself. Onboarding a domain puts records on
subdomains of it (`cf-bounce.<domain>` on Cloudflare; a custom MAIL FROM subdomain on SES), and on
the sites domain those names would shadow the wildcard and break any site of the same name. Send
from a subdomain such as `mail.<sites domain>`: `mail` is in `RESERVED_SITE_NAMES`
(`packages/shared/src/site-labels.ts`), so it is never a site, and the records under it are two
labels deep. Production refuses to start otherwise (§8).

### AWS: SES v2, an existing identity

| | |
|---|---|
| Sandbox | Per region: verified recipients only, 200 messages a day, 1 a second. Production access is a request (console or `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL …`), answered within about 96 hours. The identity's owner does this |
| Price | À la carte $0.10 per 1,000. **New accounts start on the Essentials plan ($0.16 per 1,000) from 2026-07-21**; switch to à la carte explicitly |
| Quotas | Per account and region, raised through support; counted in recipients. One `SendEmail` per recipient |
| Region | The identity must be in the Lambda's region |

The module (`platforms/aws/infra/mail.tf`) takes an optional `mail` variable; null means no email:

```hcl
mail = {
  from                   = "fling@example.test"       # on the identity's domain
  from_name              = optional(string)           # default INSTANCE_NAME
  reply_to               = optional(string)
  identity_arn           = string                     # an existing SES v2 identity
  configuration_set_name = optional(string)           # unset: the identity's default applies
  events_topic_arn       = optional(string)           # phase 2: bounces and complaints (§5.6)
}
```

With it, the module:

- grants the API role `ses:SendEmail` on the identity **and** the configuration set, when one is
  named (the developer guide names only identities; including the configuration set is the safe
  reading), with a `ses:FromAddress` condition of `from`;
- sets `MAIL_DRIVER=ses`, `MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` and
  `SES_CONFIGURATION_SET` on the function;
- adds the `aws_scheduler_schedule` `rate(1 minute)` → the API Lambda with `{"fling":"notify"}`,
  with its role and an `aws_lambda_permission`.

It creates no SES resources. DEPLOY.md gives a recipe for an operator without an identity (domain
identity with Easy DKIM, custom MAIL FROM, DMARC, a configuration set with suppression on).

Neither provider needs a secret: the Worker uses a binding and the Lambda its role.

### Cloudflare: Email Service (Email Sending), through the `send_email` binding

Email Service's Email Sending is the only Cloudflare-native way to send to arbitrary recipients.
The older Email Routing `send_email` binding sends only to verified destination addresses (at most
200 per account); it has been folded into Email Service, and the same binding sends to any
recipient once the account has onboarded a sending domain. Fling depends on it while it is in
beta, with no fallback adapter; the `Mailer` port leaves room for one if the quota ever hurts.

| | |
|---|---|
| Status | **Public beta** since 2026-04-16; no GA announcement found. Workers Paid only, which Fling already needs |
| Recipients | Any, once a sending domain is onboarded. Before that, verified destination addresses only |
| Price | 3,000 emails a month included, then $0.35 per 1,000. Hard bounces count; API rejections (suppressed recipients included) don't |
| Limits | A daily quota that starts conservative and grows; the number is not published (§5.5 handles hitting it). 50 recipients and 5 MiB a message; custom headers 16 KB in total |
| Domain | Must use Cloudflare DNS. Onboarding (dashboard: Email Service → Email Sending → Onboard Domain) adds SPF and MX on a `cf-bounce` subdomain, DKIM and DMARC |
| Bounces | Hard bounces are suppressed automatically. Events (`delivered`, `bounced`, `complained`, …) go only to a Queue, per sending domain; no webhooks |
| Local | `wrangler dev` simulates the binding: messages are logged and saved to local files, not sent |

How it fits:

- The deploy config gains a top-level `MAIL: { FROM, FROM_NAME?, REPLY_TO? }`, beside `INSTANCE`
  rather than in it, because `scripts/render-config.mjs` needs `FROM` for the binding.
- **wrangler.jsonc** gains `"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["<MAIL.FROM>"] }]`
  and the crons `["17 * * * *", "* * * * *"]`; `render-config.mjs` fills them in and sets
  `MAIL_DRIVER=cloudflare` and the `MAIL_*` vars. No `MAIL` block: no binding, no email.
- Onboarding the sending domain is a one-time dashboard step in DEPLOY.md: the docs show no API or
  wrangler command for it.
- `CloudflareMailer` builds the message (`to`, `from`, `replyTo`, `subject`, `text`, `html`,
  `headers`) and calls `env.EMAIL.send()`, which returns `{ messageId }` or throws an `Error` with
  a `code`.

## 7. Templates

- Written once in `apps/api/src/notifications/templates/`: a plain-text and a simple HTML part per
  event (table layout, inline styles, no external CSS, no tracking pixel, no click tracking). Every
  inserted value is escaped; comment bodies are plain text, cut to 300 characters, never rendered
  as Markdown or links by Fling (mail clients may still link a URL in the text, which is why guest
  comments carry no excerpt; §9).
- Branded from the instance metadata (`instanceMetadata(config)`, `apps/api/src/instance.ts`): the
  instance `name` in the subject and as a styled text header, `brand.colors.primary` and
  `primaryContent` for the button, `ink` for text. No logo: most mail clients render neither the
  `data:` URLs `BRAND_LOGO_URL` allows nor SVG. No instance literal appears, and the de-branding
  check (`scripts/check-names.mjs`) covers the templates.
- Each email's footer: why you got it ("because Ana shared a site with you on <instance>"), the
  one-click unsubscribe for that event, and a link to the settings page. Comment emails add
  "Reply on the review page; replies to this email are not posted".
- English only.

## 8. Configuration and capabilities

New values in `apps/api/src/config.ts`, documented in `platforms/aws/DEPLOY.md`'s Instance
configuration table. They come from the platform's infrastructure (the Terraform `mail` variable,
the Cloudflare deploy config's `MAIL`), not from `INSTANCE`:

| Key | Default | What |
|---|---|---|
| `MAIL_DRIVER` | unset (no email) | `ses`, `cloudflare`, `file`, `memory`. `file` and `memory` are refused in production |
| `MAIL_FROM` | — | The sender address, e.g. `fling@mail.example.test`. Required with a driver. Never published |
| `MAIL_FROM_NAME` | `INSTANCE_NAME` | The sender's display name |
| `MAIL_REPLY_TO` | unset | The operator's reply-to address, on every email. Never published |
| `SES_CONFIGURATION_SET` | unset | AWS: the configuration set to name on each send; unset uses the identity's default |

Capabilities in `/.well-known/fling`: `notifications` (the hub and settings are on: at least one
channel is configured) and `email` (the email channel is on: `MAIL_DRIVER` set). With email the
only channel they are equal; clients gate the settings on `notifications` and the email column on
`email`, so the inbox needs no client change. The preferences endpoint (§10) lists only the
channels that are on.

Defaults are the catalogue's. Instance-wide defaults can come later as config if someone needs
them.

Production checks: `MAIL_DRIVER` is `ses` or `cloudflare`; `MAIL_FROM` is set, a valid address,
and its domain is not `SITES_DOMAIN` (§6); `MAIL_REPLY_TO`, if set, is a valid address.

Docs that change: `platforms/aws/DEPLOY.md` (Instance configuration table; Infrastructure, for the
`mail` variable and the scheduler; a new "Email" section: bringing an identity, the recipe for
creating one, production access, checking from the admin page; Costs),
`platforms/cloudflare/DEPLOY.md` (Requirements, One-time setup, The deploy config, Costs, Local
development), CONTEXT.md, README, `apps/cli/README.md`, the plugin's `SKILL.md`,
`docs/development.md` (reading local mail).

## 9. Security and privacy

- **Policy at send time.** The drainer asks `can()` again for each pending item: `site.view` for
  `site.shared*`, `comment.read` for comment events, with the recipient as a user actor and their
  memberships loaded (`requireSite`'s way). If the owner has since narrowed the audience, the
  recipient has left the group, the comment was deleted or the site made restricted, the item is
  dropped. This is the one guarantee that an email never reveals a site to someone who cannot see
  it.
- **No enumeration.** The actor's response never says who will be emailed, who is suppressed or
  who unsubscribed. The unsubscribe page answers the same for any token. Notification failures
  never change the action's response.
- **Content.** Emails carry what the recipient may already see: the site name, the actor's name and
  address, a comment excerpt for comment events. Never the audience, other recipients, versions or
  the share link.
- **No phishing relay.** A comment by a guest (author kind `guest`, guest-reviews.md) is unverified,
  so its email carries no excerpt and no guest name: "A guest left 3 comments on *q3-report*", with
  the button to the review page, where the guest badge shows. Excerpts come only from signed-in
  members, who are attributable and inside the allowlist.
- **Reply-To** is the operator's fixed address or none, never the actor's, so a reply never goes
  somewhere the recipient did not expect.
- **Header injection.** Subjects and display names have CR/LF stripped; addresses are the
  validated ones.
- **Logs.** Never an address or a comment body in a log line: the batch id, event keys and a short
  hash of the address (`sha256(email)` first 12 hex characters) only.
- **Audit.** `NSENT` items keep what was sent for 30 days; the user sees theirs
  (`GET /api/me/notifications/sent`). Admins see totals and failure reasons (§10.2), never other
  people's mail.

## 10. Clients, with parity

### 10.1 Everyone

Every client gates on `notifications` (and `email` for the email column).

| | API | MCP (both servers, `packages/shared/src/mcp-tools.ts`) | CLI | Web |
|---|---|---|---|---|
| Read the catalogue and my preferences | `GET /api/me/notifications` → `{ channels, events, muted, cells }` with effective values | `fling_notifications` | `fling notifications` (a table) | Settings → Notifications: a matrix generated from the catalogue |
| Change them | `PUT /api/me/notifications { muted?, cells? }` | `fling_notifications_set` | `fling notifications set <event> <channel> on\|off`, `fling notifications mute\|unmute` | the same page |
| What was sent to me | `GET /api/me/notifications/sent` | — | `fling notifications sent` | the same page |
| Unsubscribe | `GET`/`POST /notifications/unsubscribe?t=` (no session) | — | — | the page it serves, with Undo |

Sharing, group changes and comments need no client change: they notify through the core.

The in-app inbox, later, adds `GET /api/me/inbox`, `POST /api/me/inbox/read`, `fling_inbox`,
`fling inbox` and a bell in the header.

### 10.2 Admins: `/admin/mail`

Beside `/admin/users`, behind `canInstance`; API and web, like the other admin pages.

- **Configuration**, read only: driver, `MAIL_FROM`, from name, Reply-To, configuration set.
- **Send a test email** to any address the admin types (outside the allowlist too, so external
  deliverability checkers work). It goes straight through the channel, not the outbox, and shows
  the provider's message id or the mapped error (`rejected: sender not verified`, …). At most 10
  an hour per admin (`USER#<admin>/NTEST#<hour>`).
- **Health**: the last 24 hours of `NOTIFY/STATS#<hour>` (sent, retrying, given up, suppressed)
  and the most recent failure reasons with batch id and event key. No addresses, no content.

This is the only way Fling sends a message on request: nothing sends one automatically to check
the setup.

## 11. Testing

Nothing in CI or the deploy sends real email.

- **Mailer conformance** (`packages/conformance/src/mailer.ts`): a well-formed message is accepted
  and returns a provider id; CR/LF in the subject never reaches headers; a throttle maps to
  `retry: true`, a daily quota to `quota`; an invalid recipient to `rejected`. Run against
  `MemoryMailer`, `FileMailer`, `SesMailer` with an injected, stubbed SES v2 client, and
  `CloudflareMailer` against Miniflare's simulated `send_email` binding. The simulator cannot
  produce provider errors, so the error-mapping cases run against a stubbed binding.
- **Store conformance**: the outbox operations (idempotent event put, the batch pointer under two
  racing fan-outs, the batch lease under two concurrent drainers, folding, the cool-down, the
  cursor) on memory, DynamoDB Local and D1, so both platforms drain the same way.
- **Core tests** with a fake clock and `MemoryMailer`: every event's recipients, never the actor,
  only what changed, one email per cause (direct and group), preferences and defaults, folding,
  the cool-down, retries, quota deferral, the per-recipient limit, suppression, a site made
  restricted or a member removed before the drain (dropped), guest comments without excerpts,
  unsubscribe tokens and Undo, the `MAIL_FROM` domain check.
- **The e2e scenario**: the Node runtime uses `MemoryMailer` and the `wrangler dev` runtime the
  real `CloudflareMailer` over the simulated binding. The scenario only uses HTTP, the CLI and MCP.
  It forces a drain with `POST /dev/notify/drain` (dev login only). Then, signed in as each
  recipient, it reads `GET /api/me/notifications/sent` (the `NSENT` items, with subject and event
  keys). It asserts the share, group share, group, comment and reply emails, one email for a burst
  of comments, nothing after an opt-out, and nothing for the actor. Against a live instance the
  drain route does not exist, so these steps are skipped.
- **Post-deploy smoke test**: checks that `/.well-known/fling` advertises `email` when the deploy
  config has mail, and that `GET /api/me/notifications` answers. It sends nothing.
- **By hand**, once at setup and after any change to the mail settings: send a test email from
  `/admin/mail` to a real mailbox and check SPF, DKIM and DMARC alignment in its headers.

## 12. Phases

| Phase | What | Size |
|---|---|---|
| 1 | Catalogue; hub (`notify`, recipients, policy at send time); outbox, batch pointer, drainer, folding, cool-down, retries, quota deferral, rate limits; preferences with catalogue defaults; unsubscribe with Undo; email channel with templates; `MemoryMailer`, `FileMailer`, `SesMailer`, `CloudflareMailer`; ticks on both platforms; config, the `MAIL_FROM` check and capabilities; the Terraform `mail` variable and the Cloudflare `MAIL` block; events `site.shared`, `site.shared_via_group`, `group.member_added`, `comment.created`, `comment.reply`; settings in every client (API, web page, `fling notifications`, MCP tools); `GET /api/me/notifications/sent`; `/admin/mail`; conformance and e2e | Large: about 2–3 weeks |
| 2 | Digests (the `digest` value, a digest hour); bounce and complaint events on both platforms (a Cloudflare Queue and `queue` handler; the Lambda subscribed to `mail.events_topic_arn`) | Medium: about 1 week |
| 3 | In-app inbox channel (Records, a per-user LiveHub room, bell); mentions | Medium |
| 4 | Webhook or Slack channel; instance-wide defaults, if wanted | Small each |

## 13. Before going live

Live steps for each instance, each with the operator's go-ahead:

1. **AWS:** confirm the SES account has production access in the Lambda's region (until then only
   verified addresses receive mail), add the `mail` block to the module call with the identity's
   ARN, and apply.
2. **Cloudflare:** onboard `mail.<sites domain>` (or another domain on the account that is not the
   sites domain) in Email Service, add `MAIL` to the deploy config, and deploy.
3. On each, send a test email from `/admin/mail` to a real mailbox and check the headers.

## Sources

Fling files: `CONTEXT.md`; `.claude/rules/*.md`; `docs/development.md`; `apps/api/src/{deps,types,config,instance,live,sites,groups,comments,policy}.ts`;
`apps/api/src/store/{records,types}.ts`; `apps/api/src/table/types.ts`;
`packages/shared/src/{instance,audience,groups,comments,mcp-tools,site-labels}.ts`;
`platforms/cloudflare/{wrangler.jsonc,src/worker.ts,DEPLOY.md}`;
`platforms/aws/{src/lambda.ts,infra/*.tf,DEPLOY.md}`; `apps/web/src/{App.tsx,pages/Review.tsx}`;
`docs/design/guest-reviews.md`.

Provider documentation, all checked 2026-10-28:

- Cloudflare Email Service overview: <https://developers.cloudflare.com/email-service/>
- Email Sending public beta (changelog, 2026-04-16): <https://developers.cloudflare.com/changelog/post/2026-04-16-email-sending-public-beta/>
- Workers API: <https://developers.cloudflare.com/email-service/api/send-emails/workers-api/>
- Send bindings: <https://developers.cloudflare.com/email-service/configuration/send-bindings/>
- REST API: <https://developers.cloudflare.com/email-service/api/send-emails/rest-api/>
- Pricing: <https://developers.cloudflare.com/email-service/platform/pricing/>
- Limits: <https://developers.cloudflare.com/email-service/platform/limits/>
- Domain setup: <https://developers.cloudflare.com/email-service/get-started/send-emails/>
- Deliverability: <https://developers.cloudflare.com/email-service/concepts/deliverability/>
- Suppressions: <https://developers.cloudflare.com/email-service/concepts/suppressions/>
- Event subscriptions: <https://developers.cloudflare.com/email-service/platform/event-subscriptions/>
- Local development: <https://developers.cloudflare.com/email-service/local-development/sending/>
- Email Routing `send_email`: <https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/>
- Queues pricing and limits: <https://developers.cloudflare.com/queues/platform/pricing/>, <https://developers.cloudflare.com/queues/platform/limits/>
- Workers limits, cron triggers and `waitUntil`: <https://developers.cloudflare.com/workers/platform/limits/>, <https://developers.cloudflare.com/workers/configuration/cron-triggers/>, <https://developers.cloudflare.com/workers/runtime-apis/context/>
- SES production access: <https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html>
- SES quotas: <https://docs.aws.amazon.com/ses/latest/dg/quotas.html>
- SES Easy DKIM and MAIL FROM: <https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html>, <https://docs.aws.amazon.com/ses/latest/dg/mail-from.html>
- SES event publishing: <https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html>
- SES suppression list: <https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html>
- SES pricing: <https://aws.amazon.com/ses/pricing/>
- SES IAM: <https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html>
- EventBridge Scheduler pricing and retries: <https://aws.amazon.com/eventbridge/pricing/>, <https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html>
- Lambda with SNS: <https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html>
