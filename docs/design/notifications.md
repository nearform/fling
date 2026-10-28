<!-- markdownlint-disable MD013 -->

# Design: notifications (email first)

Status: proposal, for review. Nothing here is built yet.

Fling tells people when something happens that concerns them: a site is shared with them, they are
added to a group, someone comments on their site or replies to their thread. One **notification
hub** in the core takes domain events, decides who hears about them and fans them out to
**channels**. Email is the first channel, sent through each cloud's own email service. An in-app
inbox, webhooks and Slack can follow without touching the hub.

Terms are CONTEXT.md's. New ones this design adds (to go into CONTEXT.md when built): **event**,
**event catalogue**, **channel**, **notification preferences**, **outbox**, **batch**,
**suppression**.

## 1. Goals and non-goals

Goals:

- Tell people about the events in §2 by email, on both platforms, with each cloud's native sender
  (Cloudflare Email Service on Cloudflare, SES on AWS).
- Write it once: the hub, the catalogue, preferences, the outbox, digests, templates and the
  send-time policy check are core code over the existing ports plus one new port, `Mailer`.
- Let each person choose what they hear about, per event and channel, from every client (web, CLI,
  both MCP servers), and unsubscribe from an email without signing in.
- Let the person acting choose not to notify (a quiet share).
- Never reveal a restricted site to someone who may not see it, and never become a spam cannon.

Non-goals (for now):

- Marketing or bulk mail, localisation, per-user time zones for digests.
- Inbound email (reply-by-email to comment).
- @mentions in comments (the catalogue has room; §2).
- An in-app inbox, webhooks, Slack (designed for, built later; §12).
- Notifying guests (share-link viewers): they have no address.

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
  defaults: Record<ChannelId, Delivery>   // 'on' | 'digest' | 'off'
  digestible: boolean        // may be folded into a digest
  actorChooses: boolean      // the actor may send it quietly (§4.3)
  capability?: string        // only on instances with this capability ('comments')
}
```

Templates are not in the shared registry (they render server data and would bloat the web bundle).
They live in the core as `TEMPLATES: { [K in EventKey]: Record<ChannelId, Template<K>> }`, so the
type checker refuses an event without a template for every channel.

| Key | Fires when | Who is notified | Email says | Link | Default (email) | Ships |
|---|---|---|---|---|---|---|
| `site.shared` | An owner adds an address to a site's audience (`applyAudience`, `sites.ts`) | Each address added, not the owner | "Ana shared *q3-report* with you on Acme Fling" | Review page `/review/<name>` (sign-in first if needed) | on | 1 |
| `group.member_added` | A group's owner adds people (`createGroup`, `changeMembers`, `groups.ts`) | Each address added, not the owner | "Ana added you to *Design team*", plus the sites it opens to you that you can see | Group page `/groups/<slug>` | on | 1 |
| `site.shared_via_group` | An owner adds a group to a site's audience | Each group member who can see the site, not the owner | "Ana shared *q3-report* with *Design team*, which you are in" | Review page | digest | 2 |
| `comment.created` | A thread or reply is added on a site (`addComment`, `comments.ts`) | The site's owner, unless they wrote it | "Ben commented on *q3-report* /docs/: <first 300 characters>" | Review page at the thread, `/review/<name>?path=…&thread=<id>` | on | 1 |
| `comment.reply` | A reply is added to a thread | The thread's author and everyone who replied in it, except the replier | "Ben replied in a thread on *q3-report*: …" | Review page at the thread | on | 1 |
| `comment.mention` | Later: `@address` in a body | The address mentioned, if it can read the comments | — | Review page at the thread | on | later |

Rules that hold for every event:

- **Never about your own action.** The actor is removed from the recipients before anything is
  queued.
- **One email per recipient per cause.** A site owner who is also in the thread gets
  `comment.reply` only (the more specific event wins), and someone added to a site directly and
  through a group gets `site.shared` only.
- `site.shared_via_group` is phase 2 because of its fan-out: one audience change can reach
  `AUDIENCE_GROUPS_MAX` (10) × `GROUP_MEMBERS_MAX` (500) people
  (`packages/shared/src/audience.ts`, `groups.ts`). It defaults to digest and is rate-limited per
  actor (§5.5).
- Removing someone (from an audience or a group) notifies nobody.
- Links use the existing pages: `reviewUrl` (`packages/shared/src/comments.ts`, which already takes
  `?path=`) and `/groups/:slug` (`apps/web/src/App.tsx`). Opening a thread from an email needs
  one small web change: the review page reads `&thread=<id>` and selects it.
- Comment events exist only while the `comments` capability is on.

## 3. Recipients who have never signed in

Audiences and groups may name any address the email policy admits (`checkEmails` in `sites.ts`),
whether or not it has signed in (`knownEmails`, the `USERS` index). For them:

- They get the same email, with defaults: preferences are keyed by address
  (`USER#<email>/NOTIFYPREFS`), not by user record, so a person can set them (through an
  unsubscribe link) before they ever sign in, and they are still there after.
- The link goes to the review or group page. The web sends them through sign-in, which the email
  policy admits, because `checkEmails` already refused any address it would not. The email says
  "sign in with your <issuer display name> account <address>" so they know which account to use.
- The email names only the actor, the site or group and the instance. It is an invitation in
  effect, so it is the spam risk: the per-actor limits in §5.5 apply to unknown addresses at a
  lower rate than to known ones.
- An address that later stops being admitted (the instance narrows `ALLOWED_EMAIL_DOMAINS`) is
  dropped at send time: the hub re-runs the email policy (`emailAllowed`) on every recipient.

## 4. Preferences

### 4.1 Model

Per recipient, a matrix of event × channel, each cell `on`, `digest` or `off`, plus a global
`muted` switch. Effective value, first that applies:

1. `muted` → off for everything.
2. The recipient's own cell, if set.
3. The instance default for that cell (config, §8).
4. The catalogue's `defaults`.

Stored as one record, `USER#<email>` / `NOTIFYPREFS`:

```ts
{ v: 1, muted: false, cells: { 'comment.created': { email: 'digest' } }, tokenGen: 0, updatedAt }
```

Only overrides are stored. A cell for an event the catalogue no longer has is ignored (and dropped
on the next write); a new event takes its default. So growing the catalogue needs no migration,
and `v` only moves if the record's shape does (`store/evolution.ts`).

### 4.2 Unsubscribe without signing in

Every email carries a link to `/notifications/unsubscribe?t=<token>` and the RFC 8058 headers
`List-Unsubscribe: <https://…?t=…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

- The token is HMAC-signed with `SESSION_SECRET`, domain-separated
  (`fling-unsubscribe:` prefix, as `live.ts` does for tickets), and names the address, the event
  and the channel and `tokenGen`. It does not expire; bumping `tokenGen` (from settings, "invalidate
  old unsubscribe links") revokes every earlier one.
- `GET` shows a small page on the app origin: "Stop emails about comments on your sites" with a
  button, and "stop all email from <instance>". Only `POST` changes anything, so mail scanners that
  follow links unsubscribe nobody (the scanner-safe pattern agentic-mapper uses for magic links,
  `apps/web/src/api/routes/auth/magic-link.ts` there). The one-click `POST` from the mail client
  turns that event's email cell off.
- Any well-formed but invalid token gets the same neutral page, so the endpoint reveals nothing.

### 4.3 The actor's choice and the recipient's preferences

For events with `actorChooses` (`site.shared`, `group.member_added`, `site.shared_via_group`), the
request carries `notify: boolean`. A notification goes out only if **both** say yes: the actor
asked to notify, and the recipient's effective cell is not `off`. The actor can make a share quiet;
they can never override someone's opt-out, and they are never told whether a given person will get
an email (§9).

| Client | Where | Default |
|---|---|---|
| API | `notify` on `PATCH /api/sites/:name { audience }`, `POST /api/groups`, `POST /api/groups/:slug/members` | `false` when absent: existing clients keep today's behaviour |
| Web | "Email the people I add" checkbox in the Access section and the group editor | ticked |
| CLI | `fling access … --notify`, `fling groups create/add … --notify` | off |
| MCP (both) | `notify` on `fling_set_audience`, `fling_group_create`, `fling_group_members` | `false`; the description tells the agent to ask the user |

Comment events have no actor choice: commenting is the thing people want to hear about, and the
recipient's preferences decide.

Actions taken while an admin impersonates someone never notify, and preferences cannot be changed
while impersonating (CONTEXT.md: nothing may outlive the session, and preferences are the user's
consent).

## 5. Delivery

### 5.1 The flow

```text
 route / MCP tool (sites.ts, groups.ts, comments.ts)
   └─ notify(deps, event)                       core, in the request: one transact, 2 writes
        └─ the EVENT item (ifAbsent) + a fan-out marker due now
 tick (every minute: Cloudflare cron, AWS EventBridge Scheduler)
   └─ drain(deps)                               core
        1. fan out each new event: recipients(event) − actor (group members read here),
           one PENDING item per recipient, folded into that recipient's batch (resumable)
        2. for each due batch (recipient × channel):
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
  replyTo?: string
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
`E_RATE_LIMIT_EXCEEDED`/`E_DAILY_LIMIT_EXCEEDED` → `throttled`; Cloudflare
`E_RECIPIENT_SUPPRESSED` → `suppressed`; SES `MessageRejected`, Cloudflare
`E_RECIPIENT_NOT_ALLOWED` and `E_SENDER_NOT_VERIFIED` → `rejected` (and an error log, because they
mean misconfiguration).

agentic-mapper has a similar port (`apps/web/src/platform/types.ts` there:
`Mailer.send(OutgoingEmail)`), an SES v2 adapter with an injected client
(`apps/web/src/node/mailer.ts`) and table-layout templates with escaping
(`apps/web/src/api/services/email.ts`). Worth copying: the injected-client adapter, the template
shell, and plain text beside HTML. Worth avoiding: Resend as a separate code path outside the port,
jobs queued after the database write rather than with it (so a crash loses or duplicates mail), no
preferences, no `List-Unsubscribe`, no suppression, and brand copy written into templates.

The in-app inbox, when it comes, is a Channel with no port: it writes `USER#<email>/NOTE#<id>`
items through Records and, through a per-user LiveHub room, tells open tabs to refetch.

### 5.3 The outbox in Records

All keys are reached by key or prefix query; nothing scans.

| pk | sk | Item |
|---|---|---|
| `NOTIFY#<eventId>` | `EVENT` | The event, written `ifAbsent`. The idempotency key: a retried request makes the same `eventId`, finds it and queues nothing. Expires after 30 days |
| `USER#<email>` | `NPEND#<channel>#<eventId>` | A pending notification for one recipient (event key, site id, actor, a short excerpt). Expires after 7 days |
| `NDUE#<minute>` | `FANOUT#<eventId>` | An event still to fan out (with how far it got), written with the event |
| `NDUE#<minute>` | `<channel>#<email>` | The **batch**: due at `<minute>` (UTC, `2026-10-28T14:05`), with `state`, `attempts`, `leaseUntil`. Written `ifAbsent` when a recipient's first pending item arrives, so later items fold into it |
| `NOTIFY` | `CURSOR` | The last minute fully drained |
| `USER#<email>` | `NSENT#<sortable id>` | What was sent: event keys, provider id, when. Expires after 30 days. Delivery status for the e2e and the user |
| `SUPPRESS#<email>` | `SUPPRESS` | Suppressed after a hard bounce or complaint (§5.6) |
| `USER#<email>` | `NOTIFYPREFS` | Preferences (§4) |

Event ids are derived, not random, so the same cause makes the same id:
`comment.created:<siteId>:<commentId>`, `site.shared:<siteId>:<site updatedAt>` (naming the
addresses added), `group.member_added:<groupId>:<group updatedAt>`.

The drainer queries `NDUE#<minute>` for each minute from the cursor to now, so a missed tick only
delays mail. A batch is leased with a conditional update (`fieldEquals('state','due')` or an expired
`leaseUntil`), so overlapping ticks never send twice. After a send it deletes the pending items
and the batch in one `transact` and writes `NSENT`. A failed send with `retry` moves the batch to a
later minute with backoff (1, 5, 15, 60 minutes; given up after 6 attempts and logged); `rejected`
or `suppressed` drops it.

The provider call is the one place a send could be duplicated: neither SES nor the Cloudflare
binding documents an idempotency key, so a crash after the provider accepted a message but before
the batch is deleted sends it again on the next lease. The lease is longer than any send, so only
that crash window remains. That is acceptable for notifications.

### 5.4 Folding and digests

- **`on`**: a batch is due 2 minutes after its first item. Anything else that arrives for that
  recipient meanwhile folds into it, so ten quick comments are one email ("Ben and Ana left 10
  comments on *q3-report*").
- **`digest`**: the batch is due at the next digest hour (`NOTIFY_DIGEST_HOUR`, UTC, default 08:00)
  and lists everything since, grouped by site.
- Only `digestible` events fold. A recipient's `on` and `digest` items go in separate batches.

### 5.5 Rate limits

Counters are items with `expiresAt` and the Table's atomic `add` (`table/types.ts`, `Patch.add`):

| Limit | Key | Default | Over the limit |
|---|---|---|---|
| Emails per recipient per hour | `USER#<email>/NRATE#<hour>` | 10 | the rest fold into the next hour's batch |
| Recipients an actor notifies per day | `USER#<actor>/NACT#<day>` | 200, of which 50 never signed in | the fan-out queues no more for that actor that day (logged); the action itself always succeeded |
| Instance sends per minute | `NOTIFY/RATE#<minute>` | below the provider's rate (§6) | the drainer stops and the next tick goes on |

### 5.6 Bounces and complaints

A hard bounce or a complaint writes `SUPPRESS#<email>`, and a complaint also turns the address's
email off. Suppressed addresses are skipped at send time. Both providers also keep their own
suppression list, as a second guard. The handler, `recordDeliveryEvent(deps, {email, kind})`, is
core code. Events reach it differently on each platform (§6):

- **Cloudflare** refuses a suppressed recipient at once (`E_RECIPIENT_SUPPRESSED`), so phase 1
  learns of suppression from the send itself. Bounce and complaint events reach a Worker only
  through a Queue (Email Service event subscriptions), so phase 2 adds a queue and a `queue`
  handler that calls `recordDeliveryEvent`.
- **SES** accepts a send to a suppressed address and silently drops it, and the send still counts
  against the quota. So the configuration set publishes `BOUNCE` and `COMPLAINT` events to the
  default EventBridge bus, and a rule invokes the API Lambda with them: a non-HTTP event like
  `{"fling":"migrate"}`, with no public endpoint.

### 5.7 Running the drainer

Recommendation: **the outbox in Records is the queue on both platforms, and each platform only
supplies a one-minute tick that calls the core's `drain(deps)`.**

| | Cloudflare | AWS |
|---|---|---|
| Tick | A second cron, `* * * * *`, in the existing `scheduled` handler (`platforms/cloudflare/src/worker.ts`, `wrangler.jsonc` `triggers.crons`) | EventBridge Scheduler, `rate(1 minute)`, invoking the API Lambda with `{"fling":"notify"}`: the same pattern as `{"fling":"migrate"}` (`platforms/aws/src/lambda.ts`) |
| Sooner than the tick | none needed: `on` waits 2 minutes anyway | none needed |
| Overlap | the batch lease | the batch lease |

Why not Cloudflare Queues or SQS for delivery:

- They would add a second source of truth beside the outbox.
- Each needs a new resource and binding per platform.
- Their retry semantics differ between platforms.
- The outbox already gives idempotency, retries, folding and digests. That is core code, and the
  conformance suites run it on every Table adapter.

Why not `ctx.waitUntil` either: it lasts at most 30 seconds after the response, and has no
counterpart on Lambda. The tick is cheap:

- On Cloudflare, Workers Paid allows 250 crons, and the Worker already has one.
- On AWS, about 43,000 scheduled invocations a month is well inside EventBridge Scheduler's
  14 million free invocations.

If volume ever outgrows a one-minute drain, a queue can carry batch ids so they drain in parallel,
with no change to the core. Cloudflare does get one queue in phase 2, because Email Service
publishes bounce events only to a Queue. That queue only carries those events.

## 6. The providers

Checked against the providers' documentation on 2026-10-28 (Sources).

### Cloudflare: Email Service (Email Sending), through the `send_email` binding

**Recommendation: Cloudflare Email Service's Email Sending.** It is the only Cloudflare-native way
to send to arbitrary recipients. The older Email Routing `send_email` binding sends only to
verified destination addresses (at most 200 per account). It has now been folded into Email
Service: the same binding sends to any recipient once the account has onboarded a sending domain.

| | |
|---|---|
| Status | **Public beta** since 2026-04-16; no GA announcement found. Workers Paid only, which Fling already needs |
| Recipients | Any, once a sending domain is onboarded. Before that, verified destination addresses only |
| Price | 3,000 emails a month included, then $0.35 per 1,000. Hard bounces count; API rejections (suppressed recipients included) don't |
| Limits | A daily quota that starts conservative and grows; the number is not published. 50 recipients and 5 MiB a message; custom headers 16 KB in total |
| Domain | The sending domain must use Cloudflare DNS, which a Fling instance's zone already does (`platforms/cloudflare/DEPLOY.md`, Requirements). Onboarding (dashboard: Email Service → Email Sending → Onboard Domain) adds SPF and MX on a `cf-bounce` subdomain, DKIM and DMARC |
| Bounces | Hard bounces are suppressed automatically (no expiry for a mailbox that doesn't exist). Events (`delivered`, `bounced`, `complained`, …) go only to a Queue, per sending domain; no webhooks |
| Local | `wrangler dev` simulates the binding: messages are logged and saved to local files, not sent. `remote: true` sends for real |

How it fits:

- **wrangler.jsonc** gains `"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["<MAIL_FROM>"] }]`
  and the crons `["17 * * * *", "* * * * *"]`. `scripts/render-config.mjs` fills in the sender from
  the deploy config, as it does the routes.
- **Setup** (`scripts/setup.mjs`, a one-time live step): onboard the domain in the dashboard. The
  docs show no API or wrangler command for this that I could confirm, so DEPLOY.md gives it as a
  dashboard step.
- `CloudflareMailer` builds the message (`to`, `from`, `replyTo`, `subject`, `text`, `html`,
  `headers`) and calls `env.EMAIL.send()`, which returns `{ messageId }` or throws an `Error` with
  a `code`.

### AWS: SES v2

| | |
|---|---|
| Sandbox | Per region: verified recipients only, 200 messages a day, 1 a second. Production access is a request (console or `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL …`), answered within about 96 hours |
| Price | À la carte $0.10 per 1,000. **New accounts start on the Essentials plan ($0.16 per 1,000) from 2026-07-21**; switch to à la carte explicitly |
| Quotas | Per account and region, raised through support; counted in recipients. One `SendEmail` per recipient |
| Domain | `aws_sesv2_email_identity` with Easy DKIM (records in the instance's Route 53 zone, which the module already has as `zone_id`), a custom MAIL FROM subdomain (`aws_sesv2_email_identity_mail_from_attributes`, MX plus SPF) for SPF alignment, and a DMARC record |
| Bounces | Account-level suppression list (hard bounces and complaints) on by default. A configuration set with an EventBridge event destination (default bus only) for `BOUNCE` and `COMPLAINT` |

How it fits (new `platforms/aws/infra/mail.tf`, all optional behind a `mail` variable):

- `aws_sesv2_email_identity`, `aws_sesv2_email_identity_mail_from_attributes`, the Route 53 DKIM,
  MAIL FROM and DMARC records;
- `aws_sesv2_configuration_set` and `aws_sesv2_configuration_set_event_destination` (EventBridge);
- `aws_cloudwatch_event_rule` for `aws.ses` bounce and complaint events → the API Lambda;
- `aws_scheduler_schedule` `rate(1 minute)` → the API Lambda with `{"fling":"notify"}`, with its
  role and a `aws_lambda_permission`;
- IAM on the API role (`iam.tf`): `ses:SendEmail` on the identity ARN **and** the configuration set
  ARN (the developer guide names only identities; including the configuration set is the safe
  reading), with a `ses:FromAddress` condition of `MAIL_FROM`;
- `MAIL_DRIVER=ses`, `SES_CONFIGURATION_SET` in the function's environment from the module.

Production access stays a manual, live step in DEPLOY.md. Until it is granted, the instance can
only mail verified addresses, which is enough for the smoke test to an operator's own address.

Neither provider needs a secret: the Worker uses a binding and the Lambda its role.

## 7. Templates

- Written once in `apps/api/src/notifications/templates/`: a plain-text and a simple HTML part per
  event (table layout, inline styles, no external CSS, no tracking pixel, no click tracking). Every
  inserted value is escaped; comment bodies are plain text, cut to 300 characters, never rendered
  as Markdown or links.
- Branded from the instance metadata (`instanceMetadata(config)`, `apps/api/src/instance.ts`):
  `name` in the subject and header, `brand.colors.primary`/`primaryContent` for the button,
  `ink` for text, `brand.logoUrl` as the header image **only if it is an `https:` URL** (many mail
  clients drop `data:` images, which `BRAND_LOGO_URL` allows); otherwise the instance name as text.
  No instance literal appears, and the de-branding check (`scripts/check-names.mjs`) covers the
  templates.
- Each email's footer: why you got it ("because Ana shared a site with you on <instance>"), the
  one-click unsubscribe for that event, and a link to the settings page.
- English only.

## 8. Configuration and capabilities

New values in `apps/api/src/config.ts`, documented in `platforms/aws/DEPLOY.md`'s Instance
configuration table:

| Key | Default | What |
|---|---|---|
| `NOTIFICATIONS` | on | The hub and the preferences routes (`notifications` capability). Off: nothing is queued |
| `MAIL_DRIVER` | unset (no email) | `ses`, `cloudflare`, `file`, `memory`. `file` and `memory` are refused in production |
| `MAIL_FROM` | — | The sender address, e.g. `notifications@mail.example.test`. Required with a driver. Never published |
| `MAIL_FROM_NAME` | `INSTANCE_NAME` | The sender's display name |
| `MAIL_REPLY_TO` | unset | Optional reply-to address. Never published |
| `SES_CONFIGURATION_SET` | — | AWS: the configuration set (set by the Terraform module) |
| `NOTIFY_DIGEST_HOUR` | 8 | The UTC hour digests go out |
| `NOTIFY_DEFAULTS` | unset | Instance-wide defaults, e.g. `comment.created:email=digest,site.shared_via_group:email=off`. Unknown keys refuse to start in production |

Capabilities in `/.well-known/fling`: `notifications` (the settings exist) and `email` (the email
channel is on: `MAIL_DRIVER` set). Clients show the notify checkbox and the email column only with
`email`. The registry endpoint (§10) lists only the channels that are on, so a client renders
whatever the instance has.

Instance defaults are config, not a runtime admin page, because the repo's rule is that instance
values are configuration (`.claude/rules/config-and-branding.md`). Switching a channel off is
leaving its driver unset; the capability follows. An admin page can come later if wanted.

Production checks: `MAIL_DRIVER` is `ses` or `cloudflare`; `MAIL_FROM` is set and a valid address;
`NOTIFY_DEFAULTS` names only known events, channels and values.

Docs that change: `platforms/aws/DEPLOY.md` (Instance configuration table; Infrastructure, for the
SES and scheduler resources; a new "Email" section: domain identity, production access, smoke
test; Costs), `platforms/cloudflare/DEPLOY.md` (Requirements, One-time setup, The deploy config,
Smoke test, Costs, Local development), CONTEXT.md, README, `apps/cli/README.md`, the plugin's
`SKILL.md`, `docs/development.md` (reading local mail).

## 9. Security and privacy

- **Policy at send time.** The drainer asks `can()` again for each pending item: `site.view` for
  `site.shared*`, `comment.read` for comment events, with the recipient as a user actor and their
  memberships loaded (`requireSite`'s way). If the owner has since narrowed the audience, deleted
  the comment or made the site restricted, the item is dropped. This is the one guarantee that an
  email never reveals a site to someone who cannot see it.
- **No enumeration.** The actor's response never says who will be emailed, who is suppressed or
  who unsubscribed. The unsubscribe page answers the same for any token. `notify` failures never
  change the action's response.
- **Content.** Emails carry what the recipient may already see: the site name, the actor's name and
  address, a comment excerpt for comment events. Never the audience, other recipients, versions or
  the share link.
- **Header injection.** Subjects and display names have CR/LF stripped; addresses are the
  validated ones.
- **Logs.** Never an address or a comment body in a log line: the batch id, event keys and a short
  hash of the address (`sha256(email)` first 12 hex characters) only.
- **Audit.** `NSENT` items keep what was sent for 30 days; the user sees theirs
  (`GET /api/me/notifications/sent`). Admins get no view of other people's mail.
- **Abuse.** The per-actor limits (§5.5), the email policy on every recipient, and the defaults
  (`notify` off unless asked) keep Fling from being used to mail strangers.

## 10. Clients, with parity

Every client gates on `notifications` (and `email` for the email column and the notify option).

| | API | MCP (both servers, `packages/shared/src/mcp-tools.ts`) | CLI | Web |
|---|---|---|---|---|
| Read the catalogue and my preferences | `GET /api/me/notifications` → `{ channels, events, muted, cells }` with effective values | `fling_notifications` | `fling notifications` (a table) | Settings → Notifications: a matrix generated from the catalogue |
| Change them | `PUT /api/me/notifications { muted?, cells? }` | `fling_notifications_set` | `fling notifications set <event> <channel> on\|off\|digest`, `fling notifications mute\|unmute` | the same page |
| Send a test email to myself | `POST /api/me/notifications/test` | — | `fling notifications test` | a button on the page |
| What was sent to me | `GET /api/me/notifications/sent` | — | `fling notifications sent` | the same page |
| Notify on share | `notify` (§4.3) | `notify` on `fling_set_audience`, `fling_group_create`, `fling_group_members` | `--notify` | checkbox in `SiteAccess.tsx`, `GroupEditor.tsx` |
| Unsubscribe | `GET`/`POST /notifications/unsubscribe?t=` (no session) | — | — | the page it serves |

The in-app inbox, later, adds `GET /api/me/inbox`, `POST /api/me/inbox/read`, `fling_inbox`,
`fling inbox` and a bell in the header.

## 11. Testing

- **Mailer conformance** (`packages/conformance/src/mailer.ts`): a well-formed message is accepted
  and returns a provider id; CR/LF in the subject never reaches headers; a throttle maps to
  `retry: true`; an invalid recipient to `rejected`. Run against `MemoryMailer`, `FileMailer`,
  `SesMailer` with an injected, stubbed SES v2 client, and `CloudflareMailer` against Miniflare's
  simulated `send_email` binding. The simulator cannot produce provider errors, so the
  error-mapping cases run against a stubbed binding.
- **Store conformance**: the outbox operations (idempotent event put, the batch lease under two
  concurrent drainers, folding, the cursor) on memory, DynamoDB Local and D1, so both platforms
  drain the same way.
- **Core tests** with a fake clock and `MemoryMailer`: every event's recipients, never the actor,
  one email per cause, preferences and defaults, `notify: false`, folding, digests, retries,
  rate limits, suppression, a site made restricted before the drain (dropped), unsubscribe tokens.
- **The e2e scenario**: the Node runtime uses `MemoryMailer` and the `wrangler dev` runtime the
  real `CloudflareMailer` over the simulated binding. The scenario only uses HTTP, the CLI and MCP.
  It forces a drain with `POST /dev/notify/drain` (dev login only). Then, signed in as each
  recipient, it reads `GET /api/me/notifications/sent` (the `NSENT` items, with subject and event
  keys). It asserts the share, group, comment and reply emails, one email for a burst of comments,
  nothing after `notify: false` or an opt-out, and nothing for the actor. Against a live instance
  the drain route does not exist, so these steps are skipped.
- **Smoke test on a real deployment**: the scenario calls `POST /api/me/notifications/test`. That
  sends to the signed-in user at once, through the channel and not through the outbox. The
  scenario then checks `GET /api/me/notifications/sent` for the provider's message id. This proves
  configuration, identity and permissions without reading an inbox. Deliverability (SPF, DKIM and
  DMARC alignment) is checked once by hand at setup, by sending the test email to a real mailbox.

## 12. Phases

| Phase | What | Size |
|---|---|---|
| 1 | Catalogue; hub (`notify`, recipients, policy at send time); outbox, drainer, folding, retries, rate limits; preferences record with defaults; unsubscribe; email channel with templates; `MemoryMailer`, `FileMailer`, `SesMailer`, `CloudflareMailer`; ticks on both platforms; config and capabilities; Terraform and wrangler; the `notify` option on API, MCP and CLI and the web checkboxes; events `site.shared`, `group.member_added`, `comment.created`, `comment.reply`; `POST /api/me/notifications/test` and `GET /api/me/notifications/sent` (for the e2e and smoke test); conformance and e2e | Large: about 2 weeks |
| 2 | Settings in every client (API routes already in 1; web page, `fling notifications`, MCP tools); digests; `site.shared_via_group`; bounce and complaint events on both platforms (a Cloudflare Queue and `queue` handler; an SES configuration set → EventBridge rule → Lambda) | Medium: about 1 week |
| 3 | In-app inbox channel (Records, a per-user LiveHub room, bell); mentions | Medium |
| 4 | Webhook or Slack channel; an admin page for instance defaults, if wanted | Small each |

Phase 1 is shippable alone: people get the emails with sensible defaults and can unsubscribe from
any of them; the settings page in phase 2 adds fine control.

## 13. Open questions

1. **Beta.** Cloudflare Email Sending is in public beta, and its daily quota is not published. Is
   it acceptable to depend on it? The alternative is a non-native fallback adapter behind the same
   port (for example Resend over `fetch`), which would mean one secret.
2. **The actor's default.** The web checkbox is ticked; the API, CLI and MCP default to not
   notifying, so agents and scripts stay quiet unless asked. Agree, or should it be on everywhere?
3. **The sending address.** The proposal is one subdomain per instance under the app's domain
   (`notifications@mail.<app domain>`), with the DNS in the zone each platform already manages.
   Is that right, or do some instances need to send from another domain?
4. **Comments to owners.** `comment.created` defaults to `on` (folded over 2 minutes). Would you
   rather it default to a daily digest?
5. **Admin control.** Instance defaults are config (`NOTIFY_DEFAULTS`), changed by a deploy. Is
   that enough, or do admins need a page to change them at runtime?

## Sources

Fling files: `CONTEXT.md`; `.claude/rules/*.md`; `docs/development.md`; `apps/api/src/{deps,types,config,instance,live,sites,groups,comments,policy}.ts`;
`apps/api/src/store/{records,types}.ts`; `apps/api/src/table/types.ts`;
`packages/shared/src/{instance,audience,groups,comments,mcp-tools}.ts`;
`platforms/cloudflare/{wrangler.jsonc,src/worker.ts,DEPLOY.md}`;
`platforms/aws/{src/lambda.ts,infra/*.tf,DEPLOY.md}`; `apps/web/src/{App.tsx,pages/Review.tsx}`.

agentic-mapper (read only): `apps/web/src/api/services/email.ts`, `apps/web/src/platform/types.ts`,
`apps/web/src/node/mailer.ts`, `apps/web/src/api/routes/auth/magic-link.ts`,
`apps/web/src/api/queues/handlers/email-send.ts`, `apps/web/src/api/services/notifications.ts`,
`apps/web/src/config.ts`.

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
- Terraform `aws_sesv2_configuration_set_event_destination`: <https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/website/docs/r/sesv2_configuration_set_event_destination.html.markdown>
- EventBridge Scheduler pricing and retries: <https://aws.amazon.com/eventbridge/pricing/>, <https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html>
- Lambda with SQS: <https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html>
