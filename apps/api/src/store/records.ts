/**
 * Records: the domain persistence behind the `Store` interface, written once over the Table port
 * (`../table/types.ts`). The memory and DynamoDB deployments differ only in the Table they pass.
 *
 * Key layout. Sites are site-centric (a site's partition owns its versions and its comments);
 * access is policy's business (policy.ts), not the keys'.
 *
 *   pk                     sk                            item
 *   SITE#<siteId>          SITE                          site (email = owner, name, visibility, spa,
 *                                                        archived, currentVersionId, shareToken, …)
 *   SITE#<siteId>          VERSION#<versionId>           version (status, fileCount, totalBytes, …)
 *   SITE#<siteId>          COMMENT#<commentId>           comment (parentId, path, versionId, body,
 *                                                        author, resolvedAt, …); ids sort by time,
 *                                                        so the partition lists them oldest first
 *   SITE#<siteId>          LIVE#<connectionId>           a connection to the site's live room (peer,
 *                                                        connectedAt) — 2 h; only hubs that keep
 *                                                        connections in the store write them
 *   LIVE#<connectionId>    LIVE                          live connection lookup → the same record,
 *                                                        written with it (a hub knows only the
 *                                                        connection id when it closes)
 *   USER#<email>           SITE#<name>                   site index: a copy of the site record (a
 *                                                        projection), so a user's sites are one query
 *   USER#<email>           SHARED#<siteId>               direct grant: the email is in the audience
 *                                                        of someone else's site — a projection of
 *                                                        `audience` carrying the site's listing
 *                                                        (name, owner, createdAt, updatedAt,
 *                                                        archived, live, restricted), so the sites
 *                                                        shared with a user are one query
 *   NAME#<name>            NAME                          site name claim → { name, email, siteId,
 *                                                        createdAt } (names are global, first
 *                                                        come, first served); how a site is found
 *   USER#<email>           PROFILE                       user (name, picture, userSlug,
 *                                                        lastSignInAt, …)
 *   USERS                  USER#<email>                  users index: what the admin's users list
 *                                                        shows (name, createdAt, lastSignInAt, …),
 *                                                        written with the user (migration 0003
 *                                                        backfilled it), so users list by one query
 *   SLUG#<userSlug>        SLUG                          slug claim → email (unique userSlug)
 *   USER#<email>           KEY#<id>                      api key (name, hash, createdAt, lastUsedAt)
 *   APIKEY#<sha256>        APIKEY                        api key lookup → { email, id }
 *
 * Groups (a named list of people that audiences name by id):
 *
 *   GROUP#<groupId>        GROUP                         group (slug, name, owner, size, …)
 *   GROUP#<groupId>        MEMBER#<email>                a member
 *   GROUP#<groupId>        SITE#<siteId>                 a site whose audience names the group,
 *                                                        with the site's listing (as a grant):
 *                                                        what deleting the group updates, and how
 *                                                        its members find the site
 *   USER#<email>           GROUP#<groupId>               membership: written with the member item,
 *                                                        so a user's groups (what policy reads) are
 *                                                        one query
 *   USER#<email>           OWNS#<groupId>                a copy of the group, for its owner's list
 *   GROUPS                 GROUP#<groupId>               the instance's group directory: a copy of
 *                                                        the group, so every group lists by one query
 *   GROUPNAME#<slug>       NAME                          slug claim → { slug, groupId, owner,
 *                                                        createdAt }; how a group is found
 *
 * A site's record, its index item and (on creation) its claim are written in one transaction.
 *
 * Direct grants and group-site items (v2) carry a copy of the site's listing (`SharedListing`),
 * so Shared with me reads no site. `putSite` compares the site with the one stored and keeps
 * them in step: emails and groups that leave the audience lose their item, those that join gain
 * one, and when a listed field changed (a deploy or rollback, archive or unarchive, an audience or
 * visibility change) every item is rewritten. Nothing is written when nothing listed changed. The
 * caps (100 addresses, 10 groups) bound that to a handful of transactions. Removals go first, in
 * their own batches, while the stored site still names them; then the site, its index item and
 * as many grant and group-site writes as fit (25 operations); the rest follow in batches. So an
 * interrupted write can leave an item missing, or with an out-of-date listing, until the site is
 * next saved (every save changes `updatedAt`, so it rewrites them all), but never one for someone
 * the stored audience doesn't name. Two saves of one site racing can: an item the audience no
 * longer backs, which lists the site's name to that user until the audience next names and drops
 * them, or the site is deleted. Policy reads the audience, never these items, so opening such a
 * site is still refused. No release wrote v1 items (name and owner only), only development
 * builds, so no migration fills them in: Shared with me reads the site for any item without a
 * listing.
 *
 * A group's record, its two copies and (on creation) its claim are written in one transaction with
 * as many member changes as fit; the rest follow in batches of 12 (a member item and its
 * membership always together), so an interrupted change can leave `size` and some members out of
 * step until the group is written again.
 *
 * EXPAND PHASE (migration 0001; see its header for the deploy and rollback story). Before this
 * layout a site lived only at USER#<email>/SITE#<name>, which is why the index item keeps that
 * key and the full record: code from before it reads the index item as the site. Its versions
 * lived at USER#<email>/VERSION#<siteId>#<versionId> ("legacy versions"). Until the contract step
 * (migration 0002, run by hand, then a release that drops the code marked LEGACY here):
 * - versions are written to both places;
 * - reads take both into account, because a Lambda rolled back to the old code writes only the
 *   old keys: the newer of the site record and its index item wins (`updatedAt`), and versions
 *   are the union of both places (a complete copy beats a pending one).
 * So data is fully visible before 0001 has run, during it, after it, and across a rollback and
 * roll-forward of the Lambda.
 *
 * OAuth authorization server and remote MCP (these expire through `expiresAt`, which the Table
 * hides once passed; callers check it too):
 *
 *   OAUTHCLIENT#<clientId> CLIENT                        DCR client — 90 days, pushed out by each
 *                                                        authorization
 *   OAUTHREQ#<id>          REQ                           pending consent request — 10 min
 *   OAUTHCODE#<sha256>     CODE                          authorization code — 60 s; taken with a
 *                                                        conditional delete (single use)
 *   USER#<email>           GRANT#<id>                    connection/grant (client, current
 *                                                        refreshHash, lastUsedAt) — sliding 30
 *                                                        days
 *   REFRESH#<sha256>       REFRESH                       refresh token → { grantId, email, usedAt }
 *                                                        — 30 days; usedAt set on rotation
 *                                                        (conditional), reuse revokes the grant
 *   UPLOAD#<id>            UPLOAD                        chunked MCP upload (owner, site name) —
 *                                                        1 h; parts are in blobs under uploads/<id>/
 *   UPLOAD#<id>            FILE#<path>                   one uploaded file: encoding, part count —
 *                                                        1 h
 *   AUDIT                  <sortable id>                 an admin action (impersonation start and
 *                                                        stop) — 180 days; ids sort by time, so the
 *                                                        latest are one reverse query
 *
 * Notifications (the outbox: the queue the drainer works through, by key and prefix only):
 *
 *   USER#<email>           NOTIFYPREFS                   preferences: muted and the recipient's own
 *                                                        cells (overrides only)
 *   NOTIFY#<eventId>       EVENT                         an event, written once (ifAbsent): its
 *                                                        derived id makes a retried request a
 *                                                        no-op — 30 days
 *   NDUE#<minute>          FANOUT#<eventId>              an event still to fan out, and how far it
 *                                                        got; written with the event — 30 days
 *   USER#<email>           NPEND#<ch>#<site|->#<eventId> a notification pending for the recipient,
 *                                                        under the batch it folds into — 7 days
 *   USER#<email>           NBATCH#<ch>#<site|->          the pointer to the recipient's open batch
 *                                                        (due minute) and the cool-down after a send
 *   NDUE#<minute>          <ch>#<email>#<site|->         a batch due at that minute (state, lease,
 *                                                        attempts) — 8 days past due
 *   NOTIFY                 CURSOR                        the last minute fully drained
 *   NOTIFY                 STATS#<hour>                  the drainer's counters — 48 h
 *   NOTIFY                 FAILURE#<sortable id>         a failed send (batch id, event keys,
 *                                                        reason; no address) — 48 h
 *   NOTIFY                 RATE#<minute>                 messages the instance sent that minute — 1 h
 *   USER#<email>           NRATE#<hour>                  messages sent to the recipient that hour
 *                                                        — 2 h
 *   USER#<email>           NTEST#<hour>                  test emails the admin sent that hour — 2 h
 *   USER#<email>           NSENT#<sortable id>           a message that went out — 30 days
 *   SUPPRESS#<email>       SUPPRESS                      an address not to send to
 *
 * Folding: a pending notification joins the batch its pointer names while that batch is `due`
 * (the pending item and the unchanged batch, conditioned on its state, in one transaction), so
 * nothing joins a batch a drainer has leased. Otherwise it opens a batch: the pointer (conditioned
 * on the value read, or absent), the batch and the pending item in one transaction, so two
 * fan-outs racing for one recipient open one batch. A lease is a conditional update (the batch is
 * `due`, or its expired lease is still the one read); finishing and rescheduling are conditioned
 * on the lease token, so a drainer that lost its lease changes nothing.
 *
 * Every item also carries `type` (its kind; not the API-key lookup) and `v` (see evolution.ts).
 * MIGRATION#<id> items belong to the migration runner (migrations/runner.ts).
 *
 * Conditional writes guard the races that matter: slug claims, and first-deploy site creation,
 * which writes the NAME# claim with the site in one transaction. Deleting a site removes its
 * partition, its index item and its claim (if the claim is still this site's); archiving keeps
 * the claim. The API key and its lookup are written/deleted together. Version manifests are not
 * records (they can be large); they live in blobs.
 */
import { type ChannelId, knownCells, type NotificationPreferences } from '@fling/shared'
import { mapLimit } from '../lib/concurrency.ts'
import { newId, newSortableId } from '../lib/ids.ts'
import {
  ConditionFailed,
  compareSk,
  fieldEquals,
  ifAbsent,
  ifExists,
  type Table,
  type TableItem,
  type TransactOp,
} from '../table/types.ts'
import { decode, encode, type Kind } from './evolution.ts'
import {
  type ApiKeyRecord,
  type AuditRecord,
  type AuthCodeRecord,
  addMinutes,
  type BatchPointerRecord,
  type BatchRef,
  type CommentRecord,
  type FanOutRecord,
  type GrantRecord,
  type GroupRecord,
  type GroupSiteRecord,
  type Hour,
  type LiveConnectionRecord,
  listingOf,
  type Minute,
  minuteStart,
  type NameClaim,
  NOTIFY_COUNTERS,
  type NotificationBatchRecord,
  type NotificationEventRecord,
  type NotificationPreferencesRecord,
  type NotifyCounter,
  type NotifyFailureRecord,
  type NotifyStats,
  type OAuthClientRecord,
  type OAuthRequestRecord,
  type PendingNotificationRecord,
  type RefreshTokenRecord,
  type SentNotificationRecord,
  type SharedListing,
  type SiteGrantRecord,
  type SiteRecord,
  type SiteRef,
  type Store,
  type SuppressionRecord,
  slugCandidate,
  type UploadFileRecord,
  type UploadRecord,
  type User,
  type UserSummary,
  type VersionRecord,
} from './types.ts'

const userPk = (email: string) => `USER#${email}`
const sitePk = (siteId: string) => `SITE#${siteId}`
const groupPk = (groupId: string) => `GROUP#${groupId}`

const key = {
  user: (email: string) => ({ pk: userPk(email), sk: 'PROFILE' }),
  userIndex: (email: string) => ({ pk: 'USERS', sk: `USER#${email}` }),
  audit: (id: string) => ({ pk: 'AUDIT', sk: id }),
  slug: (slug: string) => ({ pk: `SLUG#${slug}`, sk: 'SLUG' }),
  apiKey: (email: string, id: string) => ({ pk: userPk(email), sk: `KEY#${id}` }),
  apiKeyRef: (hash: string) => ({ pk: `APIKEY#${hash}`, sk: 'APIKEY' }),
  name: (name: string) => ({ pk: `NAME#${name}`, sk: 'NAME' }),
  site: (siteId: string) => ({ pk: sitePk(siteId), sk: 'SITE' }),
  siteIndex: (email: string, name: string) => ({ pk: userPk(email), sk: `SITE#${name}` }),
  siteGrant: (email: string, siteId: string) => ({ pk: userPk(email), sk: `SHARED#${siteId}` }),
  version: (siteId: string, id: string) => ({ pk: sitePk(siteId), sk: `VERSION#${id}` }),
  group: (id: string) => ({ pk: groupPk(id), sk: 'GROUP' }),
  groupDirectory: (id: string) => ({ pk: 'GROUPS', sk: `GROUP#${id}` }),
  groupOwned: (email: string, id: string) => ({ pk: userPk(email), sk: `OWNS#${id}` }),
  groupName: (slug: string) => ({ pk: `GROUPNAME#${slug}`, sk: 'NAME' }),
  groupMember: (id: string, email: string) => ({ pk: groupPk(id), sk: `MEMBER#${email}` }),
  membership: (email: string, id: string) => ({ pk: userPk(email), sk: `GROUP#${id}` }),
  groupSite: (id: string, siteId: string) => ({ pk: groupPk(id), sk: `SITE#${siteId}` }),
  comment: (siteId: string, id: string) => ({ pk: sitePk(siteId), sk: `COMMENT#${id}` }),
  live: (siteId: string, connectionId: string) => ({
    pk: sitePk(siteId),
    sk: `LIVE#${connectionId}`,
  }),
  liveRef: (connectionId: string) => ({ pk: `LIVE#${connectionId}`, sk: 'LIVE' }),
  /** LEGACY (expand phase): where versions lived before the site-centric keys */
  legacyVersion: (email: string, siteId: string, id: string) => ({
    pk: userPk(email),
    sk: `VERSION#${siteId}#${id}`,
  }),
  oauthClient: (clientId: string) => ({ pk: `OAUTHCLIENT#${clientId}`, sk: 'CLIENT' }),
  oauthRequest: (id: string) => ({ pk: `OAUTHREQ#${id}`, sk: 'REQ' }),
  authCode: (hash: string) => ({ pk: `OAUTHCODE#${hash}`, sk: 'CODE' }),
  grant: (email: string, id: string) => ({ pk: userPk(email), sk: `GRANT#${id}` }),
  refresh: (hash: string) => ({ pk: `REFRESH#${hash}`, sk: 'REFRESH' }),
  upload: (id: string) => ({ pk: `UPLOAD#${id}`, sk: 'UPLOAD' }),
  uploadFile: (uploadId: string, path: string) => ({
    pk: `UPLOAD#${uploadId}`,
    sk: `FILE#${path}`,
  }),
  notifyPrefs: (email: string) => ({ pk: userPk(email), sk: 'NOTIFYPREFS' }),
  notifyEvent: (id: string) => ({ pk: `NOTIFY#${id}`, sk: 'EVENT' }),
  fanOut: (minute: Minute, eventId: string) => ({ pk: duePk(minute), sk: `FANOUT#${eventId}` }),
  pending: (email: string, channel: ChannelId, siteId: string | null, eventId: string) => ({
    pk: userPk(email),
    sk: `${pendingPrefix(channel, siteId)}${eventId}`,
  }),
  batchPointer: (email: string, channel: ChannelId, siteId: string | null) => ({
    pk: userPk(email),
    sk: `NBATCH#${channel}#${siteKey(siteId)}`,
  }),
  batch: (b: BatchRef) => ({
    pk: duePk(b.due),
    sk: `${b.channel}#${b.email}#${siteKey(b.siteId)}`,
  }),
  notifyCursor: () => ({ pk: 'NOTIFY', sk: 'CURSOR' }),
  notifyStats: (hour: Hour) => ({ pk: 'NOTIFY', sk: `STATS#${hour}` }),
  notifyFailure: (id: string) => ({ pk: 'NOTIFY', sk: `FAILURE#${id}` }),
  instanceRate: (minute: Minute) => ({ pk: 'NOTIFY', sk: `RATE#${minute}` }),
  recipientRate: (email: string, hour: Hour) => ({ pk: userPk(email), sk: `NRATE#${hour}` }),
  mailTests: (email: string, hour: Hour) => ({ pk: userPk(email), sk: `NTEST#${hour}` }),
  sent: (email: string, id: string) => ({ pk: userPk(email), sk: `NSENT#${id}` }),
  suppression: (email: string) => ({ pk: `SUPPRESS#${email}`, sk: 'SUPPRESS' }),
}

/** The outbox's partition for a minute. */
function duePk(minute: Minute) {
  return `NDUE#${minute}`
}
/** A batch's site in keys: `-` for events batched apart from any site. */
function siteKey(siteId: string | null) {
  return siteId ?? '-'
}
function pendingPrefix(channel: ChannelId, siteId: string | null) {
  return `NPEND#${channel}#${siteKey(siteId)}#`
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** How long outbox items live, from the time each names (§5.3 of the notifications design). */
const TTL = {
  event: 30 * DAY_MS,
  pending: 7 * DAY_MS,
  /** past its due minute: longer than a pending item lives, so a batch outlasts its items */
  batch: 8 * DAY_MS,
  stats: 48 * HOUR_MS,
  sent: 30 * DAY_MS,
  instanceRate: HOUR_MS,
  hourly: 2 * HOUR_MS,
}
const after = (at: string | Date, ms: number) => new Date(new Date(at).getTime() + ms).toISOString()
const minuteAfter = (minute: Minute, ms: number) => after(minuteStart(minute), ms)
/** How many times queueNotification re-reads after losing a race before it gives up. */
const QUEUE_ATTEMPTS = 10

/** The most operations one transaction takes (the Table port's limit). */
const TRANSACT_MAX = 25

/** How many single-item deletes run at once when clearing a set of items. */
const DELETE_CONCURRENCY = 10
/** How many single-item reads run at once when looking up a set of items. */
const READ_CONCURRENCY = 10

/** The slug claim's fields. */
interface GroupNameClaim {
  slug: string
  groupId: string
  owner: string
  createdAt: string
}

const bySlug = (groups: GroupRecord[]) => groups.sort((a, b) => compareSk(a.slug, b.slug))

/** Every listing field, so a field added to `SharedListing` can't be left out of the comparison. */
const LISTING_FIELDS = Object.keys({
  siteId: true,
  name: true,
  owner: true,
  createdAt: true,
  updatedAt: true,
  archived: true,
  live: true,
  restricted: true,
} satisfies Record<keyof SharedListing, true>) as (keyof SharedListing)[]

const sameListing = (a: SharedListing, b: SharedListing) =>
  LISTING_FIELDS.every(field => a[field] === b[field])

/**
 * `head`, then `pairs` (operations that must land together), as transactions of at most
 * TRANSACT_MAX: the first holds `head` and as many pairs as fit.
 */
function batches(head: TransactOp[], pairs: [TransactOp, TransactOp][]): TransactOp[][] {
  const out: TransactOp[][] = []
  let batch = [...head]
  for (const pair of pairs) {
    if (batch.length + 2 > TRANSACT_MAX) {
      out.push(batch)
      batch = []
    }
    batch.push(...pair)
  }
  if (batch.length) out.push(batch)
  return out
}

const newestFirst = <T extends { createdAt: string }>(xs: T[]) =>
  xs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

/**
 * LEGACY (expand phase): of two copies of one version, the complete one (versions only ever go
 * pending → complete), else the first.
 */
function newerVersion(a: VersionRecord | null, b: VersionRecord | null) {
  if (!a) return b
  if (!b) return a
  return b.status === 'complete' && a.status !== 'complete' ? b : a
}

/** The users index item's fields for a user. */
const summaryOf = (user: User): UserSummary => ({
  email: user.email,
  name: user.name,
  picture: user.picture,
  userSlug: user.userSlug,
  createdAt: user.createdAt,
  lastSignInAt: user.lastSignInAt ?? null,
})

/** Run a write whose failed condition just means "no": returns false instead of throwing. */
async function unless(write: Promise<unknown>): Promise<boolean> {
  try {
    await write
    return true
  } catch (err) {
    if (err instanceof ConditionFailed) return false
    throw err
  }
}

export class Records implements Store {
  constructor(private table: Table) {}

  private async read<T>(kind: Kind, k: { pk: string; sk: string }): Promise<T | null> {
    const item = await this.table.get(k.pk, k.sk)
    return item ? decode<T>(kind, item) : null
  }

  /** Every live item of `pk` under `skPrefix`, in sk byte order. */
  private async list<T>(kind: Kind, pk: string, skPrefix: string): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    do {
      const page = await this.table.query(pk, { skPrefix, cursor })
      for (const item of page.items) out.push(decode<T>(kind, item))
      cursor = page.cursor
    } while (cursor)
    return out
  }

  private deleteAll(keys: { pk: string; sk: string }[]) {
    return mapLimit(keys, DELETE_CONCURRENCY, k => this.table.delete(k.pk, k.sk))
  }

  // --- users ---

  getUser(email: string) {
    return this.read<User>('user', key.user(email))
  }

  async upsertUser(
    input: { email: string; name: string; picture: string | null; preferredSlug: string },
    now: string
  ) {
    const existing = await this.getUser(input.email)
    if (existing) {
      const user: User = {
        ...existing,
        name: input.name,
        picture: input.picture,
        updatedAt: now,
        lastSignInAt: now,
      }
      // The record and its index item together; the slug and createdAt never change after
      // creation, so the whole record is written over the live one.
      const written = await unless(
        this.table.transact([
          { put: encode('user', key.user(user.email), user), cond: ifExists },
          { put: encode('userindex', key.userIndex(user.email), summaryOf(user)) },
        ])
      )
      if (written) return user
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const userSlug = slugCandidate(input.preferredSlug, attempt)
      const user: User = {
        email: input.email,
        name: input.name,
        picture: input.picture,
        userSlug,
        createdAt: now,
        updatedAt: now,
        lastSignInAt: now,
      }
      try {
        await this.table.transact([
          { put: encode('slug', key.slug(userSlug), { email: input.email }), cond: ifAbsent },
          { put: encode('user', key.user(input.email), user), cond: ifAbsent },
          { put: encode('userindex', key.userIndex(input.email), summaryOf(user)) },
        ])
        return user
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
        // Either the slug is taken or a concurrent login created this user.
        const raced = await this.getUser(input.email)
        if (raced) return raced
      }
    }
    throw new Error('Could not allocate a unique user slug')
  }

  async listUsers(opts: { prefix?: string; limit: number; cursor?: string }) {
    const page = await this.table.query('USERS', {
      skPrefix: `USER#${opts.prefix ?? ''}`,
      limit: opts.limit,
      cursor: opts.cursor,
    })
    return {
      users: page.items.map(i => decode<UserSummary>('userindex', i)),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    }
  }

  // --- audit ---

  async addAuditEntry(entry: AuditRecord) {
    await this.table.put(encode('audit', key.audit(entry.id), entry), ifAbsent)
  }

  async listAuditEntries(limit: number) {
    const page = await this.table.query('AUDIT', { reverse: true, limit })
    return page.items.map(i => decode<AuditRecord>('audit', i))
  }

  // --- API keys ---

  async createApiKey(apiKey: ApiKeyRecord) {
    await this.table.transact([
      { put: encode('apikey', key.apiKey(apiKey.email, apiKey.id), apiKey), cond: ifAbsent },
      {
        put: encode('apikeyref', key.apiKeyRef(apiKey.hash), {
          email: apiKey.email,
          id: apiKey.id,
        }),
        cond: ifAbsent,
      },
    ])
  }

  async findApiKeyByHash(hash: string) {
    const ref = await this.read<{ email: string; id: string }>('apikeyref', key.apiKeyRef(hash))
    return ref ? this.read<ApiKeyRecord>('apikey', key.apiKey(ref.email, ref.id)) : null
  }

  async listApiKeys(email: string) {
    return newestFirst(await this.list<ApiKeyRecord>('apikey', userPk(email), 'KEY#'))
  }

  async deleteApiKey(email: string, id: string) {
    const apiKey = await this.read<ApiKeyRecord>('apikey', key.apiKey(email, id))
    if (!apiKey) return false
    await this.table.transact([
      { delete: key.apiKey(email, id) },
      { delete: key.apiKeyRef(apiKey.hash) },
    ])
    return true
  }

  async touchApiKey(email: string, id: string, at: string) {
    const { pk, sk } = key.apiKey(email, id)
    await unless(this.table.update(pk, sk, { set: { lastUsedAt: at } }))
  }

  // --- sites and name claims ---

  getNameClaim(name: string) {
    return this.read<NameClaim>('name', key.name(name))
  }

  async findSite(name: string) {
    const claim = await this.getNameClaim(name)
    if (!claim) return null
    const [record, index] = await Promise.all([
      this.read<SiteRecord>('site', key.site(claim.siteId)),
      this.read<SiteRecord>('site', key.siteIndex(claim.email, name)),
    ])
    // A copy of another site (a stale index item) holds nothing. LEGACY (expand phase): the index
    // item may be the newer copy (written by a rolled-back Lambda, or the only one before 0001).
    const copies = [record, index].filter((s): s is SiteRecord => s?.id === claim.siteId)
    return copies.reduce<SiteRecord | null>(
      (newest, s) => (newest && newest.updatedAt >= s.updatedAt ? newest : s),
      null
    )
  }

  async listSites(email: string) {
    const sites = await this.list<SiteRecord>('site', userPk(email), 'SITE#')
    return sites.sort((a, b) => a.name.localeCompare(b.name))
  }

  async createSite(site: SiteRecord) {
    const claim: NameClaim = {
      name: site.name,
      email: site.email,
      siteId: site.id,
      createdAt: site.createdAt,
    }
    try {
      await this.table.transact([
        { put: encode('name', key.name(site.name), claim), cond: ifAbsent },
        { put: encode('site', key.site(site.id), site), cond: ifAbsent },
        { put: encode('site', key.siteIndex(site.email, site.name), site), cond: ifAbsent },
      ])
      return site
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      const existing = await this.findSite(site.name)
      if (existing?.email === site.email) return existing
      const owner = await this.getNameClaim(site.name)
      if (owner && owner.email !== site.email) return null
      throw err
    }
  }

  async putSite(site: SiteRecord) {
    const stored = await this.storedSite(site)
    const before = stored?.audience ?? { emails: [], groups: [] }
    const after = site.audience
    const listing = listingOf(site)
    const relist = !stored || !sameListing(listingOf(stored), listing)
    const removed: TransactOp[] = [
      ...before.emails
        .filter(email => !after.emails.includes(email) && email !== site.email)
        .map(email => ({ delete: key.siteGrant(email, site.id) })),
      ...before.groups
        .filter(groupId => !after.groups.includes(groupId))
        .map(groupId => ({ delete: key.groupSite(groupId, site.id) })),
    ]
    const written: TransactOp[] = [
      ...after.emails
        .filter(email => email !== site.email && (relist || !before.emails.includes(email)))
        .map(email => {
          const grant: SiteGrantRecord = { email, ...listing }
          return { put: encode('sitegrant', key.siteGrant(email, site.id), grant) }
        }),
      ...after.groups
        .filter(groupId => relist || !before.groups.includes(groupId))
        .map(groupId => {
          const item: GroupSiteRecord = { groupId, ...listing }
          return { put: encode('groupsite', key.groupSite(groupId, site.id), item) }
        }),
    ]
    // Removals land before the site stops naming them, so an interrupted write never leaves an
    // item for someone outside the stored audience (the header has the rest of the story).
    for (let i = 0; i < removed.length; i += TRANSACT_MAX) {
      await this.table.transact(removed.slice(i, i + TRANSACT_MAX))
    }
    const ops: TransactOp[] = [
      { put: encode('site', key.site(site.id), site) },
      { put: encode('site', key.siteIndex(site.email, site.name), site) },
      ...written,
    ]
    for (let i = 0; i < ops.length; i += TRANSACT_MAX) {
      await this.table.transact(ops.slice(i, i + TRANSACT_MAX))
    }
  }

  /**
   * The site as stored, by its id: the newer of its record and its index item. LEGACY (expand
   * phase): the index item may be the newer copy, as in `findSite`.
   */
  private async storedSite(site: SiteRecord) {
    const [record, index] = await Promise.all([
      this.read<SiteRecord>('site', key.site(site.id)),
      this.read<SiteRecord>('site', key.siteIndex(site.email, site.name)),
    ])
    const copies = [record, index].filter((s): s is SiteRecord => s?.id === site.id)
    return copies.reduce<SiteRecord | null>(
      (newest, s) => (newest && newest.updatedAt >= s.updatedAt ? newest : s),
      null
    )
  }

  listSiteGrants(email: string) {
    return this.list<SiteGrantRecord>('sitegrant', userPk(email), 'SHARED#')
  }

  async knownEmails(emails: readonly string[]) {
    const found = await mapLimit([...emails], READ_CONCURRENCY, async email =>
      (await this.table.get('USERS', key.userIndex(email).sk)) ? email : null
    )
    return new Set(found.filter((e): e is string => e !== null))
  }

  async deleteSite(site: SiteRecord) {
    // The partition first (versions, and anything else a site will own), so an interrupted
    // delete leaves the site findable and the delete can be repeated.
    const owned = await this.table.query(sitePk(site.id))
    const legacy = await this.table.query(userPk(site.email), {
      skPrefix: `VERSION#${site.id}#`,
    })
    const rest = owned.items.filter(i => i.sk !== 'SITE')
    const grants = site.audience.emails.map(email => key.siteGrant(email, site.id))
    const groups = site.audience.groups.map(groupId => key.groupSite(groupId, site.id))
    await this.deleteAll([...rest, ...legacy.items, ...grants, ...groups])
    // Release the name claim only if it is this site's (or absent). If another site holds it,
    // the site is still deleted and the claim kept.
    const ops: TransactOp[] = [
      { delete: key.site(site.id) },
      { delete: key.siteIndex(site.email, site.name) },
    ]
    const claim = {
      delete: key.name(site.name),
      cond: fieldEquals('siteId', site.id, { orAbsent: true }),
    }
    if (!(await unless(this.table.transact([...ops, claim])))) await this.table.transact(ops)
  }

  // --- groups ---

  /** The group, its directory copy and its owner's copy. */
  private groupOps(group: GroupRecord, cond?: typeof ifAbsent): TransactOp[] {
    return [
      { put: encode('group', key.group(group.id), group), ...(cond ? { cond } : {}) },
      { put: encode('group', key.groupDirectory(group.id), group) },
      { put: encode('group', key.groupOwned(group.owner, group.id), group) },
    ]
  }

  /** A member item and its membership, added or removed together. */
  private memberPairs(
    group: GroupRecord,
    members: { add: readonly string[]; remove: readonly string[] },
    at: string
  ): [TransactOp, TransactOp][] {
    const added = members.add.map((email): [TransactOp, TransactOp] => [
      {
        put: encode('groupmember', key.groupMember(group.id, email), {
          groupId: group.id,
          email,
          addedAt: at,
        }),
      },
      {
        put: encode('membership', key.membership(email, group.id), {
          groupId: group.id,
          email,
          addedAt: at,
        }),
      },
    ])
    const removed = members.remove.map((email): [TransactOp, TransactOp] => [
      { delete: key.groupMember(group.id, email) },
      { delete: key.membership(email, group.id) },
    ])
    return [...added, ...removed]
  }

  async createGroup(group: GroupRecord, members: readonly string[]) {
    const claim: GroupNameClaim = {
      slug: group.slug,
      groupId: group.id,
      owner: group.owner,
      createdAt: group.createdAt,
    }
    const pairs = this.memberPairs(group, { add: members, remove: [] }, group.createdAt)
    const [first = [], ...rest] = batches(
      [
        { put: encode('groupname', key.groupName(group.slug), claim), cond: ifAbsent },
        ...this.groupOps(group, ifAbsent),
      ],
      pairs
    )
    try {
      await this.table.transact(first)
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      if (await this.read<GroupNameClaim>('groupname', key.groupName(group.slug))) return null
      throw err
    }
    for (const batch of rest) await this.table.transact(batch)
    return group
  }

  async findGroup(slug: string) {
    const claim = await this.read<GroupNameClaim>('groupname', key.groupName(slug))
    if (!claim) return null
    const group = await this.read<GroupRecord>('group', key.group(claim.groupId))
    return group?.slug === slug ? group : null
  }

  async getGroups(ids: readonly string[]) {
    const found = await mapLimit([...ids], READ_CONCURRENCY, id =>
      this.read<GroupRecord>('group', key.group(id))
    )
    return found.filter((g): g is GroupRecord => g !== null)
  }

  async listGroups() {
    return bySlug(await this.list<GroupRecord>('group', 'GROUPS', 'GROUP#'))
  }

  async listOwnedGroups(email: string) {
    return bySlug(await this.list<GroupRecord>('group', userPk(email), 'OWNS#'))
  }

  async listGroupMembers(groupId: string) {
    const members = await this.list<{ email: string }>('groupmember', groupPk(groupId), 'MEMBER#')
    return members.map(m => m.email)
  }

  async listMemberships(email: string) {
    const items = await this.list<{ groupId: string }>('membership', userPk(email), 'GROUP#')
    return items.map(m => m.groupId)
  }

  async putGroup(
    group: GroupRecord,
    members?: { add: readonly string[]; remove: readonly string[] }
  ) {
    const pairs = members ? this.memberPairs(group, members, group.updatedAt) : []
    for (const batch of batches(this.groupOps(group), pairs)) await this.table.transact(batch)
  }

  listGroupSites(groupId: string) {
    return this.list<GroupSiteRecord>('groupsite', groupPk(groupId), 'SITE#')
  }

  async deleteGroup(group: GroupRecord) {
    // Members, memberships and site items first, so an interrupted delete leaves the group
    // findable and the delete can be repeated.
    const [members, sites] = await Promise.all([
      this.listGroupMembers(group.id),
      this.listGroupSites(group.id),
    ])
    await this.deleteAll([
      ...members.flatMap(email => [
        key.membership(email, group.id),
        key.groupMember(group.id, email),
      ]),
      ...sites.map(s => key.groupSite(group.id, s.siteId)),
    ])
    await this.table.transact([
      { delete: key.group(group.id) },
      { delete: key.groupDirectory(group.id) },
      { delete: key.groupOwned(group.owner, group.id) },
      {
        delete: key.groupName(group.slug),
        cond: fieldEquals('groupId', group.id, { orAbsent: true }),
      },
    ])
  }

  // --- versions ---

  async getVersion(site: SiteRef, id: string) {
    const [version, legacy] = await Promise.all([
      this.read<VersionRecord>('version', key.version(site.id, id)),
      this.read<VersionRecord>('version', key.legacyVersion(site.email, site.id, id)),
    ])
    return newerVersion(version, legacy)
  }

  async putVersion(site: SiteRef, version: VersionRecord) {
    await this.table.transact([
      { put: encode('version', key.version(site.id, version.id), version) },
      { put: encode('version', key.legacyVersion(site.email, site.id, version.id), version) },
    ])
  }

  /** In version-id byte order. */
  async listVersions(site: SiteRef) {
    const [versions, legacy] = await Promise.all([
      this.list<VersionRecord>('version', sitePk(site.id), 'VERSION#'),
      this.list<VersionRecord>('version', userPk(site.email), `VERSION#${site.id}#`),
    ])
    const byId = new Map<string, VersionRecord>()
    for (const v of [...versions, ...legacy]) {
      byId.set(v.id, newerVersion(byId.get(v.id) ?? null, v) as VersionRecord)
    }
    return [...byId.values()].sort((a, b) => compareSk(a.id, b.id))
  }

  // --- comments ---

  createComment(comment: CommentRecord) {
    return unless(
      this.table.put(encode('comment', key.comment(comment.siteId, comment.id), comment), ifAbsent)
    )
  }

  getComment(siteId: string, id: string) {
    return this.read<CommentRecord>('comment', key.comment(siteId, id))
  }

  /** In id byte order: oldest first. */
  listComments(siteId: string) {
    return this.list<CommentRecord>('comment', sitePk(siteId), 'COMMENT#')
  }

  async resolveComment(
    siteId: string,
    id: string,
    resolution: Pick<CommentRecord, 'resolvedAt' | 'resolvedBy'>
  ) {
    const { pk, sk } = key.comment(siteId, id)
    try {
      const item = await this.table.update(pk, sk, { set: resolution }, ifExists)
      return decode<CommentRecord>('comment', item)
    } catch (err) {
      if (err instanceof ConditionFailed) return null
      throw err
    }
  }

  async deleteComment(siteId: string, id: string) {
    const comment = await this.getComment(siteId, id)
    if (!comment) return false
    // Replies first, so an interrupted delete leaves the thread to delete again. A reply written
    // while its thread is deleted is an orphan: lists drop it, deleting the site removes it.
    if (comment.parentId === null) {
      const replies = (await this.listComments(siteId)).filter(c => c.parentId === id)
      await this.deleteAll(replies.map(r => key.comment(siteId, r.id)))
    }
    const { pk, sk } = key.comment(siteId, id)
    return (await this.table.delete(pk, sk)) !== null
  }

  // --- live rooms ---

  async putLiveConnection(c: LiveConnectionRecord) {
    await this.table.transact([
      { put: encode('live', key.live(c.siteId, c.connectionId), c) },
      { put: encode('liveref', key.liveRef(c.connectionId), c) },
    ])
  }

  getLiveConnection(connectionId: string) {
    return this.read<LiveConnectionRecord>('liveref', key.liveRef(connectionId))
  }

  listLiveConnections(siteId: string) {
    return this.list<LiveConnectionRecord>('live', sitePk(siteId), 'LIVE#')
  }

  async deleteLiveConnection(connectionId: string) {
    const c = await this.getLiveConnection(connectionId)
    if (!c) return null
    // The room's item first: a lookup left behind by an interrupted delete expires on its own.
    const room = key.live(c.siteId, connectionId)
    const ref = key.liveRef(connectionId)
    await this.table.delete(room.pk, room.sk)
    await this.table.delete(ref.pk, ref.sk)
    return c
  }

  // --- OAuth ---

  async putOAuthClient(client: OAuthClientRecord) {
    await this.table.put(encode('oauthclient', key.oauthClient(client.clientId), client))
  }

  getOAuthClient(clientId: string) {
    return this.read<OAuthClientRecord>('oauthclient', key.oauthClient(clientId))
  }

  async putOAuthRequest(req: OAuthRequestRecord) {
    await this.table.put(encode('oauthreq', key.oauthRequest(req.id), req))
  }

  getOAuthRequest(id: string) {
    return this.read<OAuthRequestRecord>('oauthreq', key.oauthRequest(id))
  }

  async deleteOAuthRequest(id: string) {
    const { pk, sk } = key.oauthRequest(id)
    await this.table.delete(pk, sk)
  }

  async putAuthCode(code: AuthCodeRecord) {
    await this.table.put(encode('oauthcode', key.authCode(code.hash), code))
  }

  async takeAuthCode(hash: string) {
    // Conditional, so exactly one of two concurrent exchanges of a code gets it back.
    const { pk, sk } = key.authCode(hash)
    try {
      const item = await this.table.delete(pk, sk, ifExists)
      return item ? decode<AuthCodeRecord>('oauthcode', item) : null
    } catch (err) {
      if (err instanceof ConditionFailed) return null
      throw err
    }
  }

  async createGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    await this.table.transact([
      { put: encode('grant', key.grant(grant.email, grant.id), grant), cond: ifAbsent },
      { put: encode('refresh', key.refresh(refresh.hash), refresh), cond: ifAbsent },
    ])
  }

  getGrant(email: string, id: string) {
    return this.read<GrantRecord>('grant', key.grant(email, id))
  }

  async listGrants(email: string) {
    return newestFirst(await this.list<GrantRecord>('grant', userPk(email), 'GRANT#'))
  }

  async deleteGrant(email: string, id: string) {
    const { pk, sk } = key.grant(email, id)
    return (await this.table.delete(pk, sk)) !== null
  }

  rotateGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    return unless(
      this.table.transact([
        { put: encode('grant', key.grant(grant.email, grant.id), grant), cond: ifExists },
        { put: encode('refresh', key.refresh(refresh.hash), refresh), cond: ifAbsent },
      ])
    )
  }

  async touchGrant(email: string, id: string, at: string) {
    const { pk, sk } = key.grant(email, id)
    await unless(this.table.update(pk, sk, { set: { lastUsedAt: at } }))
  }

  getRefreshToken(hash: string) {
    return this.read<RefreshTokenRecord>('refresh', key.refresh(hash))
  }

  async claimRefreshToken(hash: string, at: string) {
    const { pk, sk } = key.refresh(hash)
    try {
      const item = await this.table.update(
        pk,
        sk,
        { set: { usedAt: at } },
        fieldEquals('usedAt', undefined)
      )
      return { record: decode<RefreshTokenRecord>('refresh', item), reused: false }
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      const record = await this.getRefreshToken(hash)
      return record ? { record, reused: true } : null
    }
  }

  // --- chunked MCP uploads ---

  async putUpload(upload: UploadRecord) {
    await this.table.put(encode('upload', key.upload(upload.id), upload))
  }

  getUpload(id: string) {
    return this.read<UploadRecord>('upload', key.upload(id))
  }

  async deleteUpload(id: string) {
    const files = await this.listUploadFiles(id)
    await this.deleteAll([key.upload(id), ...files.map(f => key.uploadFile(id, f.path))])
  }

  async putUploadFile(file: UploadFileRecord) {
    await this.table.put(encode('uploadfile', key.uploadFile(file.uploadId, file.path), file))
  }

  async appendUploadPart(file: Omit<UploadFileRecord, 'parts'>) {
    const k = key.uploadFile(file.uploadId, file.path)
    for (;;) {
      // Common case: the file exists with this encoding; count the part atomically.
      try {
        const item = await this.table.update(
          k.pk,
          k.sk,
          { add: { parts: 1 }, set: { ...file, type: 'uploadfile' } },
          fieldEquals('encoding', file.encoding)
        )
        return Number(item.parts)
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
      }
      const existing = await this.table.get(k.pk, k.sk)
      if (existing && existing.encoding !== file.encoding) return null
      if (existing) continue // created meanwhile by a concurrent append
      // Absent: create it at one part. Losing that race to another append means it exists now.
      const created = { ...file, parts: 1 } satisfies UploadFileRecord
      if (await unless(this.table.put(encode('uploadfile', k, created), ifAbsent))) return 1
    }
  }

  /** In path byte order. */
  listUploadFiles(uploadId: string) {
    return this.list<UploadFileRecord>('uploadfile', `UPLOAD#${uploadId}`, 'FILE#')
  }

  // --- notifications: preferences ---

  async getNotificationPreferences(email: string) {
    const prefs = await this.read<NotificationPreferencesRecord>(
      'notifyprefs',
      key.notifyPrefs(email)
    )
    return prefs ? { ...prefs, cells: knownCells(prefs.cells) } : null
  }

  async putNotificationPreferences(email: string, prefs: NotificationPreferences, at: string) {
    const record: NotificationPreferencesRecord = {
      email,
      muted: prefs.muted,
      cells: knownCells(prefs.cells),
      updatedAt: at,
    }
    await this.table.put(encode('notifyprefs', key.notifyPrefs(email), record))
    return record
  }

  // --- notifications: events and fan-out ---

  putNotificationEvent(event: Omit<NotificationEventRecord, 'expiresAt'>, due: Minute) {
    const expiresAt = after(event.createdAt, TTL.event)
    const fanOut: FanOutRecord = {
      eventId: event.id,
      due,
      done: 0,
      createdAt: event.createdAt,
      expiresAt,
    }
    return unless(
      this.table.transact([
        {
          put: encode('notifyevent', key.notifyEvent(event.id), { ...event, expiresAt }),
          cond: ifAbsent,
        },
        { put: encode('fanout', key.fanOut(due, event.id), fanOut), cond: ifAbsent },
      ])
    )
  }

  getNotificationEvent(id: string) {
    return this.read<NotificationEventRecord>('notifyevent', key.notifyEvent(id))
  }

  async listDueNotifications(minute: Minute) {
    const fanOuts: FanOutRecord[] = []
    const batches: NotificationBatchRecord[] = []
    let cursor: string | undefined
    do {
      const page = await this.table.query(duePk(minute), { cursor })
      for (const item of page.items) {
        if (item.sk.startsWith('FANOUT#')) fanOuts.push(decode<FanOutRecord>('fanout', item))
        else batches.push(decode<NotificationBatchRecord>('nbatch', item))
      }
      cursor = page.cursor
    } while (cursor)
    return { fanOuts, batches }
  }

  async saveFanOutProgress(minute: Minute, eventId: string, done: number) {
    const { pk, sk } = key.fanOut(minute, eventId)
    await unless(this.table.update(pk, sk, { set: { done } }))
  }

  async moveFanOut(from: Minute, to: Minute, eventId: string) {
    const fanOut = await this.read<FanOutRecord>('fanout', key.fanOut(from, eventId))
    if (!fanOut || from === to) return
    await this.table.transact([
      { delete: key.fanOut(from, eventId) },
      { put: encode('fanout', key.fanOut(to, eventId), { ...fanOut, due: to }) },
    ])
  }

  async finishFanOut(minute: Minute, eventId: string) {
    const { pk, sk } = key.fanOut(minute, eventId)
    await this.table.delete(pk, sk)
  }

  // --- notifications: pending notifications and batches ---

  getBatchPointer(email: string, channel: ChannelId, siteId: string | null) {
    return this.read<BatchPointerRecord>('nbatchptr', key.batchPointer(email, channel, siteId))
  }

  private readBatch(b: BatchRef) {
    return this.read<NotificationBatchRecord>('nbatch', key.batch(b))
  }

  async queueNotification(item: Omit<PendingNotificationRecord, 'expiresAt'>, earliest: Minute) {
    const { email, channel, batchSiteId: siteId } = item
    const pendingKey = key.pending(email, channel, siteId, item.eventId)
    const pending = encode('npending', pendingKey, {
      ...item,
      expiresAt: after(item.createdAt, TTL.pending),
    })
    for (let attempt = 0; attempt < QUEUE_ATTEMPTS; attempt++) {
      const pointer = await this.getBatchPointer(email, channel, siteId)
      const open = pointer?.due
        ? await this.readBatch({ email, channel, siteId, due: pointer.due })
        : null
      let batch: NotificationBatchRecord
      let ops: TransactOp[]
      if (open?.state === 'due') {
        // Fold: the batch is rewritten as read, only while it is still due.
        batch = open
        ops = [
          { put: pending, cond: ifAbsent },
          { put: encode('nbatch', key.batch(open), open), cond: fieldEquals('state', 'due') },
        ]
      } else {
        const coolDown = pointer?.coolDownUntil
        const due =
          coolDown && coolDown > minuteStart(earliest).toISOString()
            ? ceilMinute(coolDown)
            : earliest
        batch = {
          id: newId(),
          email,
          channel,
          siteId,
          due,
          state: 'due',
          attempts: 0,
          createdAt: item.createdAt,
          expiresAt: minuteAfter(due, TTL.batch),
        }
        const next: BatchPointerRecord = {
          email,
          channel,
          siteId,
          due,
          ...(coolDown ? { coolDownUntil: coolDown } : {}),
          expiresAt: batch.expiresAt,
        }
        ops = [
          { put: pending, cond: ifAbsent },
          { put: encode('nbatch', key.batch(batch), batch), cond: ifAbsent },
          {
            put: encode('nbatchptr', key.batchPointer(email, channel, siteId), next),
            cond: pointer ? fieldEquals('due', pointer.due) : ifAbsent,
          },
        ]
      }
      try {
        await this.table.transact(ops)
        return { batch, opened: batch !== open, queued: true }
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
      }
      if (await this.table.get(pendingKey.pk, pendingKey.sk)) {
        const pointer = await this.getBatchPointer(email, channel, siteId)
        const current = pointer?.due
          ? await this.readBatch({ email, channel, siteId, due: pointer.due })
          : null
        if (current) return { batch: current, opened: false, queued: false }
      }
    }
    throw new Error('queueNotification: the batch kept changing; try again')
  }

  async leaseNotificationBatch(b: BatchRef, now: string, leaseUntil: string) {
    const batch = await this.readBatch(b)
    if (!batch) return null
    let cond: ReturnType<typeof fieldEquals>
    if (batch.state === 'due') cond = fieldEquals('state', 'due')
    else if (batch.leaseUntil !== undefined && batch.leaseUntil <= now) {
      cond = fieldEquals('lease', batch.lease)
    } else return null
    const { pk, sk } = key.batch(b)
    try {
      const item = await this.table.update(
        pk,
        sk,
        { set: { state: 'leased', lease: newId(), leaseUntil } },
        cond
      )
      return decode<NotificationBatchRecord>('nbatch', item)
    } catch (err) {
      if (err instanceof ConditionFailed) return null
      throw err
    }
  }

  async listPendingNotifications(email: string, channel: ChannelId, siteId: string | null) {
    const items = await this.list<PendingNotificationRecord>(
      'npending',
      userPk(email),
      pendingPrefix(channel, siteId)
    )
    return items.sort((a, b) => compareSk(a.eventId, b.eventId))
  }

  /** Whether the batch is still under the lease the caller holds. */
  private async holdsLease(batch: NotificationBatchRecord) {
    const stored = await this.readBatch(batch)
    return stored !== null && stored.state === 'leased' && stored.lease === batch.lease
  }

  async finishNotificationBatch(
    batch: NotificationBatchRecord,
    done: {
      eventIds: readonly string[]
      coolDownUntil: string | null
      sent?: Omit<SentNotificationRecord, 'expiresAt'>
    }
  ) {
    const { email, channel, siteId } = batch
    const pointerKey = key.batchPointer(email, channel, siteId)
    const closePointer: TransactOp = done.coolDownUntil
      ? {
          put: encode('nbatchptr', pointerKey, {
            email,
            channel,
            siteId,
            coolDownUntil: done.coolDownUntil,
            expiresAt: after(done.coolDownUntil, DAY_MS),
          } satisfies BatchPointerRecord),
          cond: fieldEquals('due', batch.due),
        }
      : { delete: pointerKey, cond: fieldEquals('due', batch.due) }
    const head: TransactOp[] = [
      { delete: key.batch(batch), cond: fieldEquals('lease', batch.lease) },
      ...(done.sent
        ? [
            {
              put: encode('nsent', key.sent(email, done.sent.id), {
                ...done.sent,
                expiresAt: after(done.sent.sentAt, TTL.sent),
              }),
            },
          ]
        : []),
    ]
    const deletes: TransactOp[] = done.eventIds.map(id => ({
      delete: key.pending(email, channel, siteId, id),
    }))
    const room = TRANSACT_MAX - head.length - 1
    // Pending items beyond one transaction go first, while the lease still holds the batch.
    const extra = deletes.slice(room)
    if (extra.length > 0) {
      if (!(await this.holdsLease(batch))) return false
      for (let i = 0; i < extra.length; i += TRANSACT_MAX) {
        await this.table.transact(extra.slice(i, i + TRANSACT_MAX))
      }
    }
    const last = deletes.slice(0, room)
    if (await unless(this.table.transact([...head, closePointer, ...last]))) return true
    if (!(await this.holdsLease(batch))) return false
    // The pointer names a newer batch (opened while this one was leased): leave it, but carry the
    // cool-down over to it.
    if (!(await unless(this.table.transact([...head, ...last])))) return false
    if (done.coolDownUntil) {
      const { pk, sk } = pointerKey
      await unless(this.table.update(pk, sk, { set: { coolDownUntil: done.coolDownUntil } }))
    }
    return true
  }

  async rescheduleNotificationBatch(batch: NotificationBatchRecord, to: Minute, attempts: number) {
    if (to <= batch.due)
      throw new Error('rescheduleNotificationBatch: move a batch to a later minute')
    const { email, channel, siteId } = batch
    const pointer = await this.getBatchPointer(email, channel, siteId)
    const moved: NotificationBatchRecord = {
      id: batch.id,
      email,
      channel,
      siteId,
      due: to,
      state: 'due',
      attempts,
      createdAt: batch.createdAt,
      expiresAt: minuteAfter(to, TTL.batch),
    }
    const next: BatchPointerRecord = {
      email,
      channel,
      siteId,
      due: to,
      ...(pointer?.coolDownUntil ? { coolDownUntil: pointer.coolDownUntil } : {}),
      expiresAt: moved.expiresAt,
    }
    const release: TransactOp = {
      delete: key.batch(batch),
      cond: fieldEquals('lease', batch.lease),
    }
    if (pointer?.due === batch.due) {
      const written = await unless(
        this.table.transact([
          release,
          { put: encode('nbatch', key.batch(moved), moved), cond: ifAbsent },
          {
            put: encode('nbatchptr', key.batchPointer(email, channel, siteId), next),
            cond: fieldEquals('due', batch.due),
          },
        ])
      )
      if (written) return 'moved'
    }
    // Another batch is open for this recipient and site: it sends these notifications too.
    return (await unless(this.table.transact([release]))) ? 'merged' : 'lost'
  }

  async getNotifyCursor() {
    const cursor = await this.read<{ minute: Minute }>('notifycursor', key.notifyCursor())
    return cursor?.minute ?? null
  }

  setNotifyCursor(minute: Minute, previous: Minute | null) {
    return unless(
      this.table.put(
        encode('notifycursor', key.notifyCursor(), { minute }),
        previous === null ? ifAbsent : fieldEquals('minute', previous)
      )
    )
  }

  // --- notifications: records, counters and suppression ---

  /**
   * Add to a counter item, creating it (with `fields` and `expiresAt`) when absent: an update
   * never creates an item, so a miss puts it, and losing that race means it exists now.
   */
  private async bump(
    k: { pk: string; sk: string },
    kind: Kind,
    add: Record<string, number>,
    fields: Record<string, unknown>,
    expiresAt: string
  ): Promise<TableItem> {
    for (;;) {
      try {
        return await this.table.update(k.pk, k.sk, { add })
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
      }
      const item = encode(kind, k, { ...fields, ...add, expiresAt })
      if (await unless(this.table.put(item, ifAbsent))) return item
    }
  }

  private async count(k: { pk: string; sk: string }, expiresAt: string) {
    const item = await this.bump(k, 'counter', { count: 1 }, {}, expiresAt)
    return Number(item.count)
  }

  async addNotifyStats(hour: Hour, counts: Partial<Record<NotifyCounter, number>>) {
    const add = Object.fromEntries(Object.entries(counts).filter(([, n]) => n)) as Record<
      string,
      number
    >
    if (Object.keys(add).length === 0) return
    const zero = Object.fromEntries(NOTIFY_COUNTERS.map(c => [c, 0]))
    await this.bump(
      key.notifyStats(hour),
      'notifystats',
      add,
      { hour, ...zero },
      after(`${hour}:00:00.000Z`, TTL.stats)
    )
  }

  async listNotifyStats(since: Hour) {
    const stats = await this.list<NotifyStats>('notifystats', 'NOTIFY', 'STATS#')
    return stats
      .filter(s => s.hour >= since)
      .map(s => ({
        ...(Object.fromEntries(NOTIFY_COUNTERS.map(c => [c, Number(s[c] ?? 0)])) as Record<
          NotifyCounter,
          number
        >),
        hour: s.hour,
      }))
  }

  async addNotifyFailure(failure: Omit<NotifyFailureRecord, 'id' | 'expiresAt'>) {
    const id = newSortableId(new Date(failure.at))
    const record: NotifyFailureRecord = { ...failure, id, expiresAt: after(failure.at, TTL.stats) }
    await this.table.put(encode('notifyfailure', key.notifyFailure(id), record))
  }

  async listNotifyFailures(limit: number) {
    const page = await this.table.query('NOTIFY', { skPrefix: 'FAILURE#', reverse: true, limit })
    return page.items.map(i => decode<NotifyFailureRecord>('notifyfailure', i))
  }

  async listSentNotifications(email: string, limit: number) {
    const page = await this.table.query(userPk(email), {
      skPrefix: 'NSENT#',
      reverse: true,
      limit,
    })
    return page.items.map(i => decode<SentNotificationRecord>('nsent', i))
  }

  getSuppression(email: string) {
    return this.read<SuppressionRecord>('suppression', key.suppression(email))
  }

  async putSuppression(suppression: SuppressionRecord) {
    await this.table.put(encode('suppression', key.suppression(suppression.email), suppression))
  }

  countRecipientSend(email: string, hour: Hour) {
    return this.count(key.recipientRate(email, hour), after(`${hour}:00:00.000Z`, TTL.hourly))
  }

  async recipientSends(email: string, hour: Hour) {
    const k = key.recipientRate(email, hour)
    const item = await this.table.get(k.pk, k.sk)
    return item ? Number(item.count) : 0
  }

  countInstanceSend(minute: Minute) {
    return this.count(key.instanceRate(minute), minuteAfter(minute, TTL.instanceRate))
  }

  countMailTest(email: string, hour: Hour) {
    return this.count(key.mailTests(email, hour), after(`${hour}:00:00.000Z`, TTL.hourly))
  }
}

/** The minute an instant falls in, rounded up: the first minute that starts at or after it. */
function ceilMinute(at: string): Minute {
  const minute = at.slice(0, 16)
  return minuteStart(minute).toISOString() === at ? minute : addMinutes(minute, 1)
}
